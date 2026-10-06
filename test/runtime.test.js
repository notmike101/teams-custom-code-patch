import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const runtimeSource = await readFile(new URL('../inject/runtime.js', import.meta.url), 'utf8');

/**
 * Evaluate the browser payload in a lifecycle-only Teams-origin VM.
 *
 * @param {string} origin - Origin exposed by the VM.
 * @returns {(object|undefined)} Installed runtime, or undefined for a rejected origin.
 */
function runtime(origin = 'https://teams.live.com') {
    // Lifecycle checks do not emulate Teams UI; no body means the panel waits for DOMContentLoaded.
    const document = {
        body: null,
        /**
         * Accept listener registration without modeling the absent DOM body.
         */
        addEventListener() {
            return;
        },
        /**
         * Accept listener cleanup without modeling the absent DOM body.
         */
        removeEventListener() {
            return;
        },
    };
    const context = vm.createContext({ document, location: { origin }, AbortController, setTimeout, clearTimeout, console });

    context.window = context;
    context.top = context;
    vm.runInContext(`(${runtimeSource})({ binding: 'binding', owner: 'test', lifecycleTimeout: 20 })`, context);

    return context.__teamsCustom;
}

/**
 * Create snapshot metadata for runtime lifecycle tests.
 *
 * @param {Array<object>} plugins - Plugin entries to apply.
 * @returns {object} Snapshot with empty themes and diagnostics.
 */
const snapshot = (plugins) => ({ themes: [], plugins, errors: [] });
/**
 * Create an enabled plugin entry with a test lifecycle factory.
 *
 * @param {string} name - Plugin filename.
 * @param {string} revision - Content revision.
 * @param {function(): object} factory - Factory producing lifecycle methods.
 * @returns {object} Enabled plugin entry.
 */
const entry = (name, revision, factory) => ({ name, revision, factory, enabled: true });

test('runtime keeps unchanged plugins and aborts/stops before replacement, disable and disposal', async () => {
    const loader = runtime();
    const events = [];
    /**
     * Create a versioned lifecycle factory that records starts and abort-aware stops.
     *
     * @param {number} version - Version label for recorded events.
     * @returns {function(): object} Factory for the requested plugin version.
     */
    const make = (version) => () => {
        let signal;

        return {
            /**
             * Capture the start signal and record the plugin version.
             *
             * @param {object} api - Plugin identity and abort signal.
             */
            start(api) {
                signal = api.signal;
                events.push(`start${version}:${api.id}`);
            },
            /**
             * Require abort before recording the stopped version.
             */
            stop() {
                assert.equal(signal.aborted, true);
                events.push(`stop${version}`);
            },
        };
    };

    await loader.apply(snapshot([entry('a.js', '1', make(1))]));
    await loader.apply(snapshot([entry('a.js', '1', make(1))]));
    await loader.apply(snapshot([entry('a.js', '2', make(2))]));
    await loader.apply(snapshot([]));
    assert.deepEqual(events, ['start1:a.js', 'stop1', 'start2:a.js', 'stop2']);
    await loader.apply(snapshot([entry('a.js', '3', make(3))]));
    await loader.dispose();
    assert.deepEqual(events.slice(-2), ['start3:a.js', 'stop3']);
});

test('failed and hanging lifecycle operations remain isolated and do not wedge later applies', async () => {
    const loader = runtime();
    let signal;
    let stopped = 0;
    let healthy = 0;

    await loader.apply(snapshot([
        entry('hang.js', '1', () => ({
            /**
             * Capture the signal and deliberately leave start unresolved.
             *
             * @param {object} api - Plugin identity and abort signal.
             * @returns {Promise<void>} Unresolved operation used to exercise the lifecycle deadline.
             */
            start(api) {
                signal = api.signal;

                return new Promise(() => {
                    /* Intentionally leave start pending to exercise its deadline. */
                });
            },
            /**
             * Record the stop attempt and deliberately leave cleanup unresolved.
             *
             * @returns {Promise<void>} Unresolved operation used to exercise the stop deadline.
             */
            stop() {
                stopped++;

                return new Promise(() => {
                    /* Intentionally leave stop pending to exercise its deadline. */
                });
            },
        })),
        { name: 'syntax.js', enabled: true, revision: '1', error: 'syntax.js: bad syntax' },
        entry('healthy.js', '1', () => ({
            /**
             * Count a healthy plugin start beside a failing neighbor.
             */
            start() {
                healthy++;
            },
            /**
             * Complete healthy plugin cleanup without additional effects.
             */
            stop() {
                return;
            },
        })),
    ]));
    assert.equal(signal.aborted, true);
    assert.equal(stopped, 1);
    assert.equal(healthy, 1);
    assert.ok(loader.errors.some((error) => error.includes('timed out')));
    await loader.apply(snapshot([]));
    await loader.dispose();
});

for (const value of [null, undefined]) {
    for (const failure of ['throw', 'reject']) {
        test(`${failure} ${value} aborts and stops failed start, isolates neighbors and permits explicit retry`, async () => {
            const loader = runtime();
            let signal;
            let starts = 0;
            let stops = 0;
            let healthyStarts = 0;
            const failed = entry('failed.js', '1', () => ({
                /**
                 * Fail the initial start and allow an explicit retry to succeed.
                 *
                 * @param {object} api - Plugin identity and abort signal.
                 * @returns {(Promise<void>|undefined)} Rejected promise for the rejection scenario; otherwise no result.
                 */
                start(api) {
                    starts++;
                    signal = api.signal;

                    if (starts > 1) {
                        return undefined;
                    }

                    if (failure === 'throw') {
                        throw value;
                    }

                    return Promise.reject(value);
                },
                /**
                 * Verify abort and count cleanup of the failed plugin.
                 */
                stop() {
                    assert.equal(signal.aborted, true);
                    stops++;
                },
            }));
            const healthy = entry('healthy.js', '1', () => ({
                /**
                 * Count healthy starts while neighboring failures remain isolated.
                 */
                start() {
                    healthyStarts++;
                },
                /**
                 * Complete the healthy neighbor’s cleanup without additional effects.
                 */
                stop() {
                    return;
                },
            }));
            const diagnostics = await loader.apply(snapshot([failed, healthy]));

            assert.equal(signal.aborted, true);
            assert.equal(stops, 1);
            assert.equal(healthyStarts, 1);
            assert.ok(diagnostics.includes(`failed.js: ${value}`));
            assert.ok(loader.errors.includes(`failed.js: ${value}`));
            await loader.apply(snapshot([failed, healthy]));
            assert.equal(starts, 1);
            await loader.apply(snapshot([failed, healthy]), true);
            assert.equal(starts, 2);
            assert.equal(signal.aborted, false);
            assert.equal(healthyStarts, 1);
            assert.equal(loader.errors.length, 0);
            await loader.dispose();
            assert.equal(stops, 2);
        });
    }
}

test('null factory failure and undefined stop rejection remain diagnostics without blocking healthy plugins', async () => {
    const loader = runtime();
    let stopped = 0;
    let healthy = 0;

    await loader.apply(snapshot([
        entry('factory.js', '1', () => {
            throw null;
        }),
        entry('stop.js', '1', () => ({
            /**
             * Throw an undefined start failure to exercise diagnostic normalization.
             */
            start() {
                throw undefined;
            },
            /**
             * Count cleanup and reject with an undefined failure.
             *
             * @returns {Promise<void>} Rejected cleanup operation.
             */
            stop() {
                stopped++;

                return Promise.reject(undefined);
            },
        })),
        entry('healthy.js', '1', () => ({
            /**
             * Count healthy starts beside null and undefined lifecycle failures.
             */
            start() {
                healthy++;
            },
            /**
             * Complete healthy cleanup beside failed lifecycle operations.
             */
            stop() {
                return;
            },
        })),
    ]));
    assert.equal(stopped, 1);
    assert.equal(healthy, 1);
    assert.ok(loader.errors.includes('factory.js: null'));
    assert.ok(loader.errors.includes('stop.js: undefined'));
    assert.ok(loader.errors.includes('stop.js stop: undefined'));
    await loader.dispose();
});

test('same-owner bootstrap preserves a running plugin and different-owner bootstrap rejects without takeover', async () => {
    const document = {
        body: null,
        /**
         * Accept listener registration without modeling the absent DOM body.
         */
        addEventListener() {
            return;
        },
        /**
         * Accept listener cleanup without modeling the absent DOM body.
         */
        removeEventListener() {
            return;
        },
    };
    const context = vm.createContext({ document, location: { origin: 'https://teams.live.com' }, AbortController, setTimeout, clearTimeout });

    context.window = context;
    context.top = context;
    vm.runInContext(`(${runtimeSource})({ binding: 'first', owner: 'first' })`, context);
    const existing = context.__teamsCustom;
    let starts = 0;
    let stops = 0;
    let signal;
    const plugin = entry('healthy.js', '1', () => ({
        /**
         * Count starts and preserve the abort signal across repeated bootstrap.
         *
         * @param {object} api - Plugin identity and abort signal.
         */
        start(api) {
            starts++;
            signal = api.signal;
        },
        /**
         * Count cleanup of the ownership-preserved plugin.
         */
        stop() {
            stops++;
        },
    }));

    await existing.apply(snapshot([plugin]));
    vm.runInContext(`(${runtimeSource})({ binding: 'first', owner: 'first' })`, context);
    assert.equal(context.__teamsCustom, existing);
    await context.__teamsCustom.apply(snapshot([plugin]));
    assert.equal(starts, 1);
    assert.equal(stops, 0);
    assert.equal(signal.aborted, false);
    assert.throws(() => vm.runInContext(`(${runtimeSource})({ binding: 'second', owner: 'second' })`, context));
    assert.equal(context.__teamsCustom, existing);
    assert.equal(starts, 1);
    assert.equal(stops, 0);
    assert.equal(signal.aborted, false);
    await existing.dispose();
});

test('runtime does not bootstrap on sign-in origins', () => {
    assert.equal(runtime('https://login.microsoftonline.com'), undefined);
});

test('pending plugin lifecycle work does not force healthy neighbors past their deadlines', async () => {
    const loader = runtime();
    const startGate = Promise.withResolvers();
    const stopGate = Promise.withResolvers();
    const healthyStarted = Promise.withResolvers();
    const healthyStopped = Promise.withResolvers();
    let slowSignal;
    const application = loader.apply(snapshot([
        entry('slow.js', '1', () => ({
            /**
             * Wait for the test to release startup.
             *
             * @param {object} api - Plugin identity and abort signal.
             * @returns {Promise<unknown>} Startup gate.
             */
            start(api) {
                slowSignal = api.signal;

                return startGate.promise;
            },
            /**
             * Wait for the test to release cleanup.
             *
             * @returns {Promise<unknown>} Cleanup gate.
             */
            stop() {
                return stopGate.promise;
            },
        })),
        entry('healthy.js', '1', () => ({
            /**
             * Signal that startup reached the independent healthy plugin.
             */
            start() {
                healthyStarted.resolve();
            },
            /**
             * Signal that cleanup reached the independent healthy plugin.
             */
            stop() {
                healthyStopped.resolve();
            },
        })),
    ]));

    try {
        await healthyStarted.promise;
        assert.equal(slowSignal.aborted, false);
        startGate.resolve();
        assert.equal((await application).length, 0);
        const disposal = loader.dispose();

        await healthyStopped.promise;
        stopGate.resolve();
        assert.equal((await disposal).length, 0);
    } finally {
        startGate.resolve();
        stopGate.resolve();
        await application;
        await loader.dispose();
    }
});
