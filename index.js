import { Console } from 'node:console';
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink, lstat, readFile } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { CdpConnection } from './lib/cdp.js';
import { readSnapshot, readConfig, writeConfig, validateFilename, snapshotExpression } from './lib/extensions.js';
import { createManagedControl } from './lib/managed.js';
import { inspectWindows, validateListener, launchTeams } from './lib/windows.js';

const origins = new Set(['https://teams.live.com', 'https://teams.microsoft.com', 'https://teams.cloud.microsoft']);
/**
 * Check whether a page address belongs to an allowed Teams origin.
 *
 * @param {string} url - Page address to inspect.
 * @returns {boolean} Whether the origin is allowed.
 */
const eligible = (url) => {
    try {
        return origins.has(new URL(url).origin);
    } catch {
        return false;
    }
};

const originGuard = `window === window.top && ${JSON.stringify([...origins])}.includes(location.origin)`;
const panelCss = `
#teams-custom-launcher,#teams-custom-panel {font:14px/1.5 system-ui,sans-serif!important;color:#f5f5f5!important;background:#242424!important;position:fixed!important;z-index:2147483647!important;box-sizing:border-box!important;border:1px solid #aaa!important;border-radius:8px!important;}
#teams-custom-launcher {right:16px!important;bottom:16px!important;padding:8px 12px!important;cursor:pointer!important;}
#teams-custom-panel {right:16px!important;bottom:64px!important;width:min(380px,calc(100vw - 32px))!important;max-height:75vh!important;overflow:auto!important;padding:16px!important;box-shadow:0 4px 24px #0008!important;}
#teams-custom-panel[hidden] {display:none!important;}
#teams-custom-panel h2 {font-size:18px!important;margin:0 0 8px!important;}
#teams-custom-panel label {display:block!important;padding:4px!important;overflow-wrap:anywhere!important;}
#teams-custom-panel button {font:inherit!important;padding:4px 8px!important;margin:4px!important;color:#fff!important;background:#444!important;border:1px solid #aaa!important;border-radius:4px!important;cursor:pointer!important;}
#teams-custom-panel button:disabled {opacity:.6!important;}
#teams-custom-panel fieldset {border:1px solid #888!important;margin:12px 0!important;}
#teams-custom-panel ul {padding-left:20px!important;color:#ffb6b6!important;overflow-wrap:anywhere!important;}
#teams-custom-panel :focus-visible,#teams-custom-launcher:focus-visible {outline:3px solid #aab4ff!important;outline-offset:2px!important;}
`;

/**
 * Parse companion command-line options and validate required values.
 *
 * @returns {object} Validated launch and data-directory options.
 */
function options() {
    const result = { attach: false, safeMode: false };
    const args = process.argv.slice(2);

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--attach':
                result.attach = true;
                break;
            case '--safe-mode':
                result.safeMode = true;
                break;
            case '--managed':
                result.managed = true;
                break;
            case '--help':
            case '-h':
                result.help = true;
                break;
            case '--port':
            case '--data-dir': {
                const value = args[++i];

                if (!value || value.startsWith('--')) {
                    throw new Error(`Missing value for ${arg}`);
                }

                if (arg === '--port') {
                    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
                        throw new Error('Port must be between 1 and 65535');
                    }

                    result.port = Number(value);
                } else {
                    result.dataDir = resolve(value);
                }

                break;
            }

            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (result.attach && !result.port) {
        throw new Error('--attach requires --port');
    }

    if (!result.dataDir) {
        if (!process.env.APPDATA && !result.help) {
            throw new Error('APPDATA is not defined; supply --data-dir');
        }

        result.dataDir = join(process.env.APPDATA ?? '.', 'TeamsCustom');
    }

    return result;
}

/**
 * Reserve and release an available loopback TCP port.
 *
 * @returns {Promise<number>} Port selected by the operating system.
 */
async function availablePort() {
    const server = createServer();

    return await new Promise((resolvePort, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;

            server.close((error) => error ? reject(error) : resolvePort(port));
        });
    });
}

/**
 * Validate that a debugger endpoint is local and has the expected shape.
 *
 * @param {string} value - Debugger address received from the endpoint.
 * @param {number} port - Verified debugger port.
 * @param {string} protocol - Required URL protocol.
 * @param {string} prefix - Required endpoint path prefix.
 * @returns {string} Validated debugger address.
 */
function debuggerUrl(value, port, protocol, prefix) {
    const url = new URL(value);

    if (url.protocol !== protocol || !['127.0.0.1', '[::1]'].includes(url.hostname)
        || Number(url.port) !== port || url.username || url.password || !url.pathname.startsWith(prefix)
        || url.search || url.hash) {
        throw new Error(`Refusing non-local or unexpected debugger URL: ${value}`);
    }

    return url.href;
}

/**
 * Fetch and decode a bounded response from the local debugger.
 *
 * @param {number} port - Verified debugger port.
 * @param {string} path - Debugger API path.
 * @returns {Promise<object>} Decoded debugger response.
 */
async function endpoint(port, path) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });

    if (!response.ok) {
        throw new Error(`Debugger ${path}: HTTP ${response.status}`);
    }

    const text = await response.text();

    if (text.length > 2 * 1_024 * 1_024) {
        throw new Error('Debugger response is too large');
    }

    return JSON.parse(text);
}

/**
 * Evaluate an expression in a target and surface page exceptions.
 *
 * @param {object} target - Connected target with a CDP transport.
 * @param {string} expression - JavaScript expression to evaluate.
 * @param {number} [contextId] - Optional execution context identifier.
 * @returns {Promise<unknown>} Value returned by the expression.
 */
async function evaluate(target, expression, contextId) {
    const response = await target.cdp.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
        ...(contextId === undefined ? {} : { contextId }),
    });

    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Page evaluation failed');
    }

    return response.result?.value;
}

/* CSS IDs belong to the current CDP session. Recover only inspector sheets whose
   text carries this running companion's marker; sourceURL/title may be empty. */
/**
 * Recover only this companion’s marked inspector sheets and update its current-frame CSS.
 *
 * @param {object} target - Target carrying current-session headers and owned sheet identifiers.
 * @param {string} owner - Running companion ownership marker.
 * @param {object} frame - Current top-level frame and loader identifiers.
 * @param {string} css - Owned declarations to install.
 * @returns {Promise<void>} Completion of recovery and stylesheet replacement.
 */
async function writeOwnedStyleSheet(target, owner, frame, css) {
    const marker = `/* teams-custom-owner: ${owner} */\n`;

    if (!target.sheetId || target.frameId !== frame.id || target.loaderId !== frame.loaderId) {
        let recovered;

        for await (const header of target.sheets.values()) {
            if (header.origin !== 'inspector') {
                continue;
            }

            const { text } = await target.cdp.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });

            if (!text.startsWith(marker)) {
                continue;
            }

            target.ownedSheets.add(header.styleSheetId);

            if (!recovered && header.frameId === frame.id) {
                recovered = header.styleSheetId;
            }
        }

        for await (const styleSheetId of target.ownedSheets) {
            if (styleSheetId !== recovered) {
                await target.cdp.send('CSS.setStyleSheetText', { styleSheetId, text: marker });
            }
        }

        if (!recovered) {
            if (target.stopped) {
                return;
            }

            const sheet = await target.cdp.send('CSS.createStyleSheet', { frameId: frame.id });

            recovered = sheet.styleSheetId;
            target.ownedSheets.add(recovered);
        }

        target.sheetId = recovered;
        target.frameId = frame.id;
        target.loaderId = frame.loaderId;
    }

    if (target.stopped) {
        return;
    }

    await target.cdp.send('CSS.setStyleSheetText', { styleSheetId: target.sheetId, text: `${marker}${css}` });
}

/**
 * Blank all tracked owned sheets, retaining identifiers if any cleanup fails.
 *
 * @param {object} target - Target carrying the owned sheet identifiers.
 * @returns {Promise<void>} Completion of owned stylesheet cleanup.
 */
async function clearOwnedStyleSheets(target) {
    const failures = [];

    for await (const styleSheetId of target.ownedSheets) {
        try {
            await target.cdp.send('CSS.setStyleSheetText', { styleSheetId, text: '' });
        } catch (error) {
            failures.push(error?.message ?? String(error));
        }
    }

    if (failures.length) {
        throw new Error(failures.join('; '));
    }

    target.ownedSheets.clear();
    target.sheetId = undefined;
}

/**
 * Own the redirected status pipe without Windows' synchronous stdio writes.
 *
 * @returns {Socket} Asynchronous, destroyable output for the managed protocol.
 */
function managedOutput() {
    const output = new Socket({ fd: 1, readable: false, writable: true });

    if (process.platform === 'win32') {
        /* Node 24.21.0 lib/net.js forces fd 1/2 pipes into blocking mode and
           shadows the async Socket writers. No public API opts out.
           ponytail: pinned Windows Node internals; rerun managed pipe regressions on upgrades. */
        try {
            const error = output._handle.setBlocking(false);

            if (error) {
                throw new Error(`Cannot make managed output asynchronous: ${error}`);
            }

            delete output._write;
            delete output._writev;
        } catch (error) {
            output.destroy();
            throw error;
        }
    }

    return output;
}

/**
 * Run the verified native Teams companion and manage its lifecycle.
 *
 * @returns {Promise<void>} Completion after shutdown or help output.
 */
async function main() {
    const managed = process.argv.includes('--managed');
    const console = managed ? new Console({ stdout: process.stderr, stderr: process.stderr }) : globalThis.console;
    let config;
    let dataDir;
    let lockPath;
    let lock;
    const targets = new Map();
    const owner = randomUUID();
    const binding = `__teamsCustom_${owner.replaceAll('-', '')}`;
    const launchAbort = new AbortController();
    let stopped = false;
    let timer;
    let shutdownPromise;
    let control;
    let serial = Promise.resolve();
    let queuedActions = 0;
    let snapshot;
    let signature;
    let lastStatus = '';
    /**
     * Serialize companion work while allowing later jobs after a rejection.
     *
     * @param {function(): unknown} work - Operation to run after preceding work.
     * @returns {Promise<unknown>} Result or rejection of the queued operation.
     */
    const enqueue = (work) => {
        const result = serial.then(work);

        serial = result.catch(() => undefined);

        return result;
    };

    /**
     * Print a status message only when it changes.
     *
     * @param {string} message - Current companion status.
     * @param {number} [port] - Debugger loopback port.
     * @param {string} [state] - Managed lifecycle state.
     */
    const status = (message, port, state = 'waiting') => {
        if (!stopped && message !== lastStatus) {
            console.info(message);
            control?.status(state, message, port);
            lastStatus = message;
        }
    };

    /**
     * Remove a target’s bootstrap, runtime, stylesheets and connection.
     *
     * @param {object} target - Connected target to clean up.
     * @returns {Promise<void>} Completion of accessible target cleanup.
     */
    async function disposeTarget(target) {
    // Remove reload bootstrap before cleanup, so a later Teams reload cannot resurrect it.
        if (target.scriptId) {
            await target.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: target.scriptId })
                .catch((error) => console.error(`[${target.id}] Could not remove reload bootstrap: ${error.message}; Quit Teams for a guaranteed rollback.`));
        }

        const cleanupErrors = await evaluate(target, `window.__teamsCustom?.owner === ${JSON.stringify(owner)} ? window.__teamsCustom.dispose() : undefined`)
            .catch((error) => {
                console.error(`[${target.id}] Runtime cleanup unavailable: ${error.message}`);
            });

        if (cleanupErrors?.length) {
            console.error(`[${target.id}] ${cleanupErrors.join('\n')}`);
        }

        await clearOwnedStyleSheets(target)
            .catch((error) => console.error(`[${target.id}] Owned CSS cleanup unavailable: ${error.message}; Quit Teams for a guaranteed rollback.`));
        await target.cdp.send('Runtime.removeBinding', { name: binding }).catch(() => undefined);
        target.cdp.close();
    }

    /**
     * Stop polling and queued work, clean targets and release the companion lock.
     *
     * @returns {Promise<void>} Completion of companion shutdown.
     */
    function shutdown() {
        if (shutdownPromise) {
            return shutdownPromise;
        }

        stopped = true;
        launchAbort.abort();
        clearTimeout(timer);

        for (const target of targets.values()) {
            target.stopped = true;
        }

        shutdownPromise = (async () => {
            try {
                await serial;
                control?.status('stopping', 'Removing reachable customization; Teams will not be terminated.');
                await Promise.all([...targets.values()].map(disposeTarget));
                targets.clear();

                if (lock) {
                    await lock.close();
                    await unlink(lockPath);
                }

                const message = 'Extensions cleaned up where accessible. If Teams is debug-enabled, Quit Teams to close its debugger.';

                console.info(message);
                control?.status('stopped', message);
            } finally {
                process.off('SIGINT', onSignal);
                process.off('SIGTERM', onSignal);
                control?.close();
            }
        })();

        return shutdownPromise;
    }

    /**
     * Handle a termination signal by initiating shutdown and reporting failures.
     */
    const onSignal = () => {
        void shutdown().catch((error) => {
            console.error(error.message);
            control?.status('error', error.message);
            process.exitCode = 1;
        });
    };

    if (managed) {
        control = createManagedControl(process.stdin, managedOutput(), onSignal);
        control.status('starting', 'Starting Teams companion.');
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    /**
     * Initialize and poll through the same queue drained by shutdown.
     *
     * @returns {Promise<void>} Completion of startup and the first polling cycle.
     */
    async function start() {
        config = options();

        if (config.help) {
            console.info('Usage: node index.js [--port PORT] [--attach --port PORT] [--safe-mode] [--data-dir PATH] [--managed]');
            control?.close();
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);

            return;
        }

        dataDir = config.dataDir;
        await mkdir(dataDir, { recursive: true });
        const directoryInfo = await lstat(dataDir);

        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
            throw new Error('Data directory must be a real directory, not a link');
        }

        if (stopped) {
            return;
        }

        lockPath = join(dataDir, 'companion.lock');
        try {
            lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new Error(`A companion lock exists in ${dataDir}. Stop the other companion. After a crash, verify it is not running before deleting companion.lock.`);
            }

            throw error;
        }

        await lock.writeFile(`${process.pid}\n`);

        for await (const kind of ['themes', 'plugins']) {
            await mkdir(join(dataDir, kind), { recursive: true });
        }

        try {
            const file = await open(join(dataDir, 'config.json'), 'wx', 0o600);

            await file.writeFile('{"themes":[],"plugins":[]}\n');
            await file.close();
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }

        const runtimeSource = await readFile(new URL('./inject/runtime.js', import.meta.url), 'utf8');
        const bootstrap = `(${runtimeSource})(${JSON.stringify({ owner, binding })})\n//# sourceURL=teams-custom/runtime.js`;
        const port = config.port ?? await availablePort();

        if (stopped) {
            return;
        }

        let windows = await inspectWindows(port);

        if (stopped) {
            return;
        }

        if (windows.listeners.length) {
            validateListener(windows);
        } else {
            if (config.attach) {
                throw new Error(`No listener on port ${port}. Quit Teams and start the companion without --attach.`);
            }

            if (windows.processes.some(({ name }) => name?.toLowerCase() === 'ms-teams.exe')) {
                throw new Error(`Teams is already running without the requested debugger on port ${port}. Use Teams tray menu > Quit, then rerun; or --attach --port with its existing debugger port. Nothing was terminated.`);
            }

            control?.status('starting', 'Launching Teams and waiting for its verified debugger.', port);
            await launchTeams(port, launchAbort.signal);
            const deadline = Date.now() + 45_000;

            /**
             * Poll the listener serially until startup expires, stops or verifies ownership.
             *
             * @returns {Promise<void>} Completion of the bounded startup wait.
             */
            async function waitForListener() {
                if (stopped || Date.now() >= deadline) {
                    return;
                }

                await delay(1_000);
                windows = await inspectWindows(port);

                if (stopped) {
                    return;
                }

                if (windows.listeners.length) {
                    validateListener(windows);

                    return;
                }

                await waitForListener();
            }

            await waitForListener();

            if (stopped) {
                return;
            }

            if (!windows.listeners.length) {
                throw new Error('Teams did not expose a debugger within 45 seconds. Quit Teams and inspect WebView2 policy/launch support; no security policy was changed.');
            }
        }

        if (stopped) {
            return;
        }

        console.info(`Teams Custom: http://127.0.0.1:${port} · ${dataDir}${config.safeMode ? ' · SAFE MODE' : ''}`);
        console.warn('WARNING: the Teams debugger is accessible to local processes until Teams quits. Only load trusted plugins.');

        /**
         * Apply the current snapshot only to an eligible ready top-level document.
         *
         * @param {object} target - Connected page target.
         * @param {boolean} retryFailed - Whether failed plugins should be retried.
         * @returns {Promise<void>} Completion of snapshot application.
         */
        async function apply(target, retryFailed = false) {
            if (stopped) {
                return;
            }

            const documentState = await evaluate(target, `({allowed: ${originGuard}, ready: !!document.body, url: location.href})`);

            if (!documentState?.allowed) {
                await evaluate(target, `window.__teamsCustom?.owner === ${JSON.stringify(owner)} ? window.__teamsCustom.dispose() : undefined`);
                await clearOwnedStyleSheets(target);
                target.dirty = true;

                return;
            }

            if (!documentState.ready) {
                target.dirty = true;

                return;
            }

            if (stopped) {
                return;
            }

            await evaluate(target, bootstrap);
            const tree = await target.cdp.send('Page.getFrameTree');

            if (stopped || !eligible(tree.frameTree?.frame?.url)) {
                target.dirty = true;

                return;
            }

            const frame = tree.frameTree.frame;
            const css = snapshot.themes.filter((entry) => entry.enabled).map((entry) => `/* ${entry.name} */\n${entry.source}`).join('\n');

            // Reuse this companion's current-document sheet, removing duplicate owned declarations first.
            await writeOwnedStyleSheet(target, owner, frame, `${css}\n${panelCss}`);

            if (stopped) {
                return;
            }

            const result = await evaluate(target, `(${originGuard}) && window.__teamsCustom?.owner === ${JSON.stringify(owner)} ? window.__teamsCustom.apply(${snapshotExpression(snapshot)},${retryFailed}) : undefined`);

            target.dirty = false;

            if (result?.length) {
                console.error(`[${target.id}] ${result.join('\n')}`);
            }
        }

        /**
         * Refresh local sources and apply changed or dirty target snapshots.
         *
         * @param {boolean} force - Whether every target should be reapplied.
         * @returns {Promise<void>} Completion of refresh across targets.
         */
        async function refresh(force = false) {
            const next = await readSnapshot(dataDir, config.safeMode);

            if (stopped) {
                return;
            }

            const nextSignature = JSON.stringify(next);
            const changed = nextSignature !== signature;

            snapshot = next;
            signature = nextSignature;
            const failures = [];

            await Promise.all([...targets.values()].filter((target) => changed || force || target.dirty).map(async (target) => {
                try {
                    await apply(target, force);
                } catch (error) {
                    target.dirty = true;
                    const message = `Target ${target.id}: ${error.message}`;

                    failures.push(message);
                    status(message);
                    await evaluate(target, `(${originGuard}) && window.__teamsCustom?.owner === ${JSON.stringify(owner)} ? window.__teamsCustom.report(${JSON.stringify(message)}) : undefined`).catch(() => undefined);
                }
            }));

            if (failures.length) {
                throw new Error(failures.join('; ').slice(0, 1_000));
            }
        }

        /**
         * Validate and serialize a privileged action from an eligible page context.
         *
         * @param {object} target - Target that emitted the binding event.
         * @param {object} event - CDP binding invocation and execution context.
         * @returns {Promise<void>} Completion of action handling and acknowledgement.
         */
        async function handleBinding(target, event) {
            if (stopped || event.name !== binding || typeof event.payload !== 'string' || event.payload.length > 2_048) {
                return;
            }

            let action;

            try {
                action = JSON.parse(event.payload);
            } catch {
                return;
            }

            if (!action || Object.getPrototypeOf(action) !== Object.prototype || !Number.isSafeInteger(action.id) || action.id < 1) {
                return;
            }

            const idKey = `${event.executionContextId}:${action.id}`;

            if (target.seen.has(idKey) || queuedActions >= 32) {
                return;
            }

            target.seen.add(idKey);

            if (target.seen.size > 256) {
                target.seen.delete(target.seen.values().next().value);
            }

            queuedActions++;
            try {
                await enqueue(async () => {
                    if (stopped || targets.get(target.id) !== target) {
                        return;
                    }

                    let error = '';

                    try {
                        // A binding exists in every context: privilege is granted only to the real top-level allowed document.
                        const context = target.contexts.get(event.executionContextId);

                        if (!context?.auxData?.isDefault || context.auxData.frameId !== target.frameId
                            || !await evaluate(target, originGuard, event.executionContextId)) {
                            throw new Error('Extension controls are unavailable in this document');
                        }

                        if (action.action === 'reload' && Object.keys(action).sort().join(',') === 'action,id') {
                            await refresh(true);
                        } else if (action.action === 'toggle' && Object.keys(action).sort().join(',') === 'action,enabled,id,kind,name'
                            && ['themes', 'plugins'].includes(action.kind) && typeof action.enabled === 'boolean'
                            && validateFilename(action.name, action.kind === 'themes' ? '.css' : '.js')) {
                            const inventory = await readSnapshot(dataDir, config.safeMode);

                            if (!inventory[action.kind].some((entry) => entry.name === action.name)) {
                                throw new Error('File is no longer in the local extension inventory');
                            }

                            const value = await readConfig(dataDir);
                            const names = new Set(value[action.kind]);

                            if (action.enabled) {
                                names.add(action.name);
                            } else {
                                names.delete(action.name);
                            }

                            value[action.kind] = [...names].sort();
                            await writeConfig(dataDir, value);
                            await refresh();
                        } else {
                            throw new Error('Invalid extension control action');
                        }
                    } catch (failure) {
                        error = failure.message.slice(0, 1_000);
                    }

                    await evaluate(target, `(${originGuard}) && window.__teamsCustom?.owner === ${JSON.stringify(owner)} ? window.__teamsCustom.ack(${action.id},${JSON.stringify(error)}) : undefined`, event.executionContextId).catch(() => undefined);
                });
            } finally {
                queuedActions--;
            }
        }

        /**
         * Connect and initialize a page target with ownership and context tracking.
         *
         * @param {object} info - Debugger page target metadata.
         * @returns {Promise<void>} Completion of target initialization.
         */
        async function connectTarget(info) {
            if (stopped) {
                return;
            }

            const cdp = new CdpConnection();
            const target = { id: info.id, cdp, dirty: true, contexts: new Map(), seen: new Set(), sheets: new Map(), ownedSheets: new Set() };

            cdp.on('Runtime.executionContextCreated', ({ context }) => target.contexts.set(context.id, context));
            cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => target.contexts.delete(executionContextId));
            cdp.on('Runtime.executionContextsCleared', () => {
                target.contexts.clear();
                target.seen.clear();
                target.dirty = true;
            });
            cdp.on('CSS.styleSheetAdded', ({ header }) => target.sheets.set(header.styleSheetId, header));
            cdp.on('CSS.styleSheetRemoved', ({ styleSheetId }) => {
                target.sheets.delete(styleSheetId);
                target.ownedSheets.delete(styleSheetId);

                if (target.sheetId === styleSheetId) {
                    target.sheetId = undefined;
                    target.dirty = true;
                }
            });
            cdp.on('Page.frameNavigated', ({ frame }) => {
                if (!frame.parentId) {
                    target.frameId = frame.id;
                    target.sheetId = undefined;
                    target.dirty = true;
                }
            });
            cdp.on('Runtime.bindingCalled', (event) => {
                void handleBinding(target, event).catch((error) => console.error(error.message));
            });
            cdp.on('disconnect', () => {
                if (targets.get(target.id) === target) {
                    targets.delete(target.id);
                }
            });
            try {
                await cdp.connect(debuggerUrl(info.webSocketDebuggerUrl, port, 'ws:', '/devtools/page/'));

                if (stopped) {
                    cdp.close();

                    return;
                }

                targets.set(target.id, target);
                await cdp.send('Runtime.enable');
                await cdp.send('Page.enable');
                await cdp.send('DOM.enable');
                await cdp.send('CSS.enable');

                if (stopped) {
                    return;
                }

                await cdp.send('Runtime.addBinding', { name: binding });

                if (stopped) {
                    return;
                }

                const script = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrap });

                target.scriptId = script.identifier;
            } catch (error) {
                await disposeTarget(target);
                targets.delete(target.id);
                throw error;
            }
        }

        /**
         * Verify listener ownership, reconcile page targets and refresh local files.
         *
         * @returns {Promise<void>} Completion of one polling cycle.
         */
        async function tick() {
            if (stopped) {
                return;
            }

            try {
                // ponytail: a 1.5s serial poll avoids Windows watcher races; use events if this latency becomes material.
                const state = await inspectWindows(port);

                if (stopped) {
                    return;
                }

                if (!state.listeners.length) {
                    await Promise.all([...targets.values()].map(disposeTarget));
                    targets.clear();
                    status('Teams debugger disconnected; waiting for the verified Teams listener to return.');

                    return;
                }

                validateListener(state);
                const version = await endpoint(port, '/json/version');

                debuggerUrl(version.webSocketDebuggerUrl, port, 'ws:', '/devtools/browser/');
                const list = await endpoint(port, '/json/list');

                if (stopped) {
                    return;
                }

                if (!Array.isArray(list)) {
                    throw new TypeError('Debugger target list is not an array');
                }

                const pages = list.filter((entry) => entry && entry.type === 'page');

                if (pages.some((entry) => typeof entry.id !== 'string' || typeof entry.url !== 'string')) {
                    throw new Error('Malformed debugger page target');
                }

                const ids = new Set(pages.map((entry) => entry.id));

                for await (const [id, target] of targets) {
                    if (!ids.has(id)) {
                        await disposeTarget(target);
                        targets.delete(id);
                    }
                }

                for await (const info of pages) {
                    if (eligible(info.url) && !targets.has(info.id)) {
                        await connectTarget(info);
                    }
                }

                await refresh();
                status(`Watching ${targets.size} Teams page target(s).`, port, targets.size ? 'running' : 'waiting');
            } catch (error) {
                // Ownership failures are fatal: never retain a privileged connection to a replaced listener.
                if (/Refusing/.test(error.message)) {
                    throw error;
                }

                status(`Waiting for Teams debugger: ${error.message}`);
            }
        }

        /**
         * Schedule the next serialized polling cycle unless shutdown has begun.
         */
        const schedule = () => {
            if (stopped) {
                return;
            }

            timer = setTimeout(() => {
                void enqueue(tick).then(schedule).catch(async (error) => {
                    console.error(error.message);
                    control?.status('error', error.message);
                    process.exitCode = 1;
                    await shutdown();
                });
            }, 1_500);
        };

        await tick();
        schedule();
    }

    try {
        await enqueue(start);
    } catch (error) {
        if (stopped && launchAbort.signal.aborted && error.name === 'AbortError') {
            await shutdown();

            return;
        }

        control?.status('error', error.message);
        await shutdown();
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error?.message ?? String(error));
        process.exitCode = 1;
    });
}

export { writeOwnedStyleSheet, clearOwnedStyleSheets };
