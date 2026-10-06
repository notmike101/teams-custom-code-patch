/* exported teamsCustomRuntime */
/**
 * Install the owned Teams controls and bounded plugin lifecycle runtime.
 *
 * @param {object} options - Companion ownership, binding and lifecycle settings.
 * @param {string} options.owner - Running companion ownership identifier.
 * @param {string} options.binding - Privileged companion binding name.
 * @param {number} [options.lifecycleTimeout] - Optional lifecycle deadline in milliseconds.
 */
function teamsCustomRuntime(options) {
    const allowed = new Set(['https://teams.live.com', 'https://teams.microsoft.com', 'https://teams.cloud.microsoft']);

    if (globalThis !== globalThis.top || !allowed.has(location.origin)) {
        return;
    }

    if (globalThis.__teamsCustom) {
        if (globalThis.__teamsCustom.owner !== options.owner) {
            throw new Error('This Teams page belongs to another companion. Stop that companion; if it exited abnormally, Quit Teams and relaunch before attaching. Separate data directories do not allow shared page ownership.');
        }

        return;
    }

    const records = new Map();
    let disposed = false;
    let queue = Promise.resolve();
    let latest = { themes: [], plugins: [], errors: [] };
    let panel;
    let launcher;
    let pending;
    let requestId = 0;
    let actionError = '';
    const timeout = options.lifecycleTimeout ?? 3_000;
    /**
     * Collect bounded snapshot, lifecycle and action diagnostics.
     *
     * @returns {Array<string>} Messages suitable for the controls panel.
     */
    const errors = () => [...latest.errors, ...[...records.values()].flatMap((record) => record.errors), ...(actionError ? [actionError] : [])]
        .slice(0, 50).map((error) => String(error).slice(0, 1_000));

    /**
     * Run a lifecycle operation with a deadline and always cancel its timer.
     *
     * @param {function(): unknown} operation - Lifecycle operation to invoke.
     * @param {string} label - Diagnostic name for timeout failures.
     * @returns {Promise<unknown>} Operation result or rejection before the deadline.
     */
    async function bounded(operation, label) {
        let timer;

        try {
            return await Promise.race([
                Promise.resolve().then(operation),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Abort a plugin and invoke its stop method at most once.
     *
     * @param {object} record - Plugin lifecycle record.
     * @returns {Promise<void>} Completion of bounded stop and diagnostic capture.
     */
    async function stop(record) {
        record.controller.abort();

        if (record.stopped) {
            return;
        }

        record.stopped = true;
        try {
            if (typeof record.instance?.stop === 'function') {
                await bounded(() => record.instance.stop(), `${record.name} stop`);
            }
        } catch (error) {
            record.errors.push(`${record.name} stop: ${error?.message ?? String(error)}`);
        }
    }

    /**
     * Instantiate and start one plugin, isolating failures and aborting failed starts.
     *
     * @param {object} entry - Enabled plugin metadata and factory.
     * @returns {Promise<void>} Completion of bounded start or failure cleanup.
     */
    async function start(entry) {
        const record = { name: entry.name, revision: entry.revision, controller: new AbortController(), errors: [], stopped: false };

        records.set(entry.name, record);
        try {
            if (entry.error) {
                throw new Error(entry.error);
            }

            record.instance = entry.factory();

            if (!record.instance || typeof record.instance.start !== 'function' || typeof record.instance.stop !== 'function') {
                throw new Error('plugin must return { start(api), stop() }');
            }

            await bounded(() => record.instance.start(Object.freeze({ id: entry.name, name: entry.name, signal: record.controller.signal })), `${entry.name} start`);

            if (disposed) {
                await stop(record);
            }
        } catch (error) {
            record.errors.push(`${entry.name}: ${error?.message ?? String(error)}`);
            await stop(record);
        }
    }

    /**
     * Create a DOM element with optional plain-text content.
     *
     * @param {string} tag - Element tag name.
     * @param {string} [text] - Optional text content.
     * @returns {HTMLElement} Created element.
     */
    function element(tag, text) {
        const node = document.createElement(tag);

        if (text !== undefined) {
            node.textContent = text;
        }

        return node;
    }

    /**
     * Send one bounded control request through the companion binding.
     *
     * @param {object} action - Reload or toggle action payload.
     */
    function send(action) {
        if (disposed || pending) {
            return;
        }

        const id = ++requestId;

        pending = { id, timer: setTimeout(() => runtime.ack(id, 'Companion did not respond; retry or check its terminal'), 20_000) };
        actionError = '';
        render();
        try {
            globalThis[options.binding](JSON.stringify({ id, ...action }));
        } catch (error) {
            runtime.ack(id, error?.message ?? String(error));
        }
    }

    /**
     * Mount accessible extension controls when the document body is available.
     */
    function mount() {
        if (disposed || panel || !document.body) {
            return;
        }

        launcher = element('button', 'Teams Custom');
        launcher.id = 'teams-custom-launcher';
        launcher.type = 'button';
        launcher.setAttribute('aria-controls', 'teams-custom-panel');
        launcher.setAttribute('aria-expanded', 'false');
        panel = element('section');
        panel.id = 'teams-custom-panel';
        panel.hidden = true;
        panel.setAttribute('aria-label', 'Teams Custom extensions');
        launcher.addEventListener('click', () => {
            panel.hidden = !panel.hidden;
            launcher.setAttribute('aria-expanded', String(!panel.hidden));

            if (!panel.hidden) {
                panel.querySelector('button')?.focus();
            }
        });
        document.body.append(launcher, panel);
        render();
    }

    /**
     * Render extension inventory, request state and bounded diagnostics.
     */
    function render() {
        mount();

        if (!panel) {
            return;
        }

        const focusedName = panel.contains(document.activeElement) ? document.activeElement?.dataset?.file : undefined;

        panel.replaceChildren();
        panel.append(element('h2', 'Teams Custom'));
        const close = element('button', 'Close');

        close.type = 'button';
        close.addEventListener('click', () => {
            panel.hidden = true;
            launcher.setAttribute('aria-expanded', 'false');
            launcher.focus();
        });
        panel.append(close);
        const status = element('p', latest.safeMode ? 'Safe mode: user extensions are not loaded. Toggles edit configuration for your next normal run.' : 'Local trusted extensions · polling every 1.5 seconds');

        status.setAttribute('role', 'status');
        panel.append(status);

        for (const kind of ['themes', 'plugins']) {
            const fieldset = element('fieldset');

            fieldset.append(element('legend', kind === 'themes' ? 'Themes' : 'Plugins'));

            if (!latest[kind].length) {
                fieldset.append(element('p', `No local ${kind} found.`));
            }

            for (const entry of latest[kind]) {
                const label = element('label');
                const checkbox = element('input');

                checkbox.type = 'checkbox';
                checkbox.checked = entry.configured ?? entry.enabled;
                checkbox.disabled = Boolean(pending);
                checkbox.dataset.file = `${kind}:${entry.name}`;
                checkbox.addEventListener('change', () => send({ action: 'toggle', kind, name: entry.name, enabled: checkbox.checked }));
                label.append(checkbox, document.createTextNode(` ${entry.name}`));
                fieldset.append(label);
            }

            panel.append(fieldset);
        }

        const reload = element('button', pending ? 'Working…' : 'Reload local files');

        reload.type = 'button';
        reload.disabled = Boolean(pending);
        reload.addEventListener('click', () => send({ action: 'reload' }));
        panel.append(reload);
        const messages = element('ul');

        messages.setAttribute('aria-live', 'polite');

        for (const error of errors()) {
            messages.append(element('li', error));
        }

        panel.append(messages);

        if (focusedName) {
            [...panel.querySelectorAll('input')].find((node) => node.dataset.file === focusedName)?.focus();
        }
    }

    const runtime = {
        owner: options.owner,
        /**
         * Read current snapshot and lifecycle diagnostics.
         *
         * @returns {Array<string>} Current displayed error messages.
         */
        get errors() {
            return errors();
        },
        /**
         * Queue a snapshot application without losing later work after a rejection.
         *
         * @param {object} snapshot - Snapshot containing plugin factories and management metadata.
         * @param {boolean} retryFailed - Whether unchanged failed plugins may be restarted.
         * @returns {Promise<(Array<string>|undefined)>} Diagnostics after application, or undefined after disposal.
         */
        apply(snapshot, retryFailed = false) {
            /**
             * Reconcile plugin lifecycle records with the queued snapshot.
             *
             * @returns {Promise<(Array<string>|undefined)>} Current diagnostics after reconciliation, or undefined when inactive.
             */
            const work = async () => {
                if (disposed) {
                    return;
                }

                if (globalThis !== globalThis.top || !allowed.has(location.origin)) {
                    void runtime.dispose();

                    return;
                }

                latest = snapshot;
                actionError = '';
                const desired = new Map(snapshot.plugins.filter((entry) => entry.enabled && !snapshot.safeMode).map((entry) => [entry.name, entry]));

                await Promise.all([...new Set([...records.keys(), ...desired.keys()])].map(async (name) => {
                    const existing = records.get(name);
                    const next = desired.get(name);

                    if (existing && next && existing.revision === next.revision && !(retryFailed && existing.errors.length)) {
                        return;
                    }

                    if (existing) {
                        await stop(existing);
                        records.delete(name);
                        // Preserve cleanup failures in the displayed snapshot even after disabling.
                        latest.errors.push(...existing.errors.filter((error) => error.includes(' stop')));
                    }

                    if (next && !disposed) {
                        await start(next);
                    }
                }));

                render();

                return errors();
            };

            const result = queue.then(work);

            queue = result.catch(() => undefined);

            return result;
        },
        /**
         * Display a bounded companion-side failure.
         *
         * @param {unknown} error - Failure to display in the controls panel.
         */
        report(error) {
            actionError = String(error).slice(0, 1_000);
            render();
        },
        /**
         * Complete only the matching pending control request.
         *
         * @param {number} id - Acknowledged request identifier.
         * @param {string} [error] - Optional companion failure message.
         */
        ack(id, error = '') {
            if (!pending || pending.id !== id) {
                return;
            }

            clearTimeout(pending.timer);
            pending = undefined;
            actionError = error;
            render();
        },
        /**
         * Abort plugins, drain queued work and remove owned page controls.
         *
         * @returns {Promise<(Array<string>|undefined)>} Cleanup diagnostics, or undefined when already disposed.
         */
        async dispose() {
            if (disposed) {
                return;
            }

            disposed = true;

            if (pending) {
                clearTimeout(pending.timer);
            }

            document.removeEventListener('DOMContentLoaded', mount);

            for (const record of records.values()) {
                record.controller.abort();
            }

            await queue;

            await Promise.all([...records.values()].map(stop));

            const failures = errors();

            records.clear();
            panel?.remove();
            launcher?.remove();

            if (globalThis.__teamsCustom === runtime) {
                delete globalThis.__teamsCustom;
            }

            return failures;
        },
    };

    globalThis.__teamsCustom = runtime;
    document.addEventListener('DOMContentLoaded', mount, { once: true });
    mount();
}
