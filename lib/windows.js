import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/**
 * Run an encoded PowerShell command with bounded output and duration.
 *
 * @param {string} script - PowerShell source to execute.
 * @param {AbortSignal} [signal] - Cancellation for this owned helper only.
 * @param {object} [env] - Environment inherited by the child process.
 * @returns {Promise<string>} Trimmed standard output.
 */
async function powershell(script, signal, env = process.env) {
    if (process.platform !== 'win32') {
        throw new Error('Native Teams launcher requires Windows');
    }

    signal?.throwIfAborted();
    const command = execute('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env, signal, windowsHide: true, timeout: 12_000, maxBuffer: 8 * 1_024 * 1_024 });
    // Abort rejects before close; shutdown must also drain the killed helper.
    const closed = signal
        ? new Promise((resolveClose) => {
                command.child.once('close', resolveClose);
            })
        : undefined;

    try {
        const { stdout } = await command;

        return stdout.trim();
    } catch (error) {
        if (signal?.aborted) {
            await closed;
        }

        throw error;
    }
}

/**
 * Inspect Windows processes and listeners for a validated debugger port.
 *
 * @param {number} port - Debugger TCP port.
 * @returns {Promise<object>} Process ancestry and matching listening sockets.
 */
async function inspectWindows(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('Invalid debugger port');
    }

    return JSON.parse(await powershell(`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine }
})
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq ${port} } | ForEach-Object {
  @{ address = $_.LocalAddress; pid = [int]$_.OwningProcess }
})
@{ processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 5 -Compress
`));
}

/**
 * Require a loopback-only Teams-hosted WebView2 listener with Teams ancestry.
 *
 * @param {object} state - Windows process and listener inspection.
 * @returns {object} Verified WebView2 owner process.
 */
function validateListener(state) {
    if (!Array.isArray(state.listeners) || !state.listeners.length) {
        throw new Error('No debugger listener found');
    }

    if (state.listeners.some(({ address }) => !['127.0.0.1', '::1'].includes(address))) {
        throw new Error('Refusing debugger listener: it is not loopback-only');
    }

    const pids = new Set(state.listeners.map(({ pid }) => pid));

    if (pids.size !== 1) {
        throw new Error('Refusing debugger port owned by multiple processes');
    }

    const processes = new Map(state.processes.map((entry) => [entry.pid, entry]));
    const owner = processes.get([...pids][0]);

    if (owner?.name?.toLowerCase() !== 'msedgewebview2.exe'
        || !/--webview-exe-name=(?:"ms-teams\.exe"|ms-teams\.exe)(?:\s|$)/i.test(owner.commandLine ?? '')) {
        throw new Error('Refusing debugger listener: owner is not a Teams-hosted WebView2 browser');
    }

    const seen = new Set([owner.pid]);
    let ancestor = processes.get(owner.parentPid);

    while (ancestor && !seen.has(ancestor.pid)) {
        if (ancestor.name?.toLowerCase() === 'ms-teams.exe') {
            return owner;
        }

        seen.add(ancestor.pid);
        ancestor = processes.get(ancestor.parentPid);
    }

    throw new Error('Refusing debugger listener: WebView2 has no Teams process ancestor');
}

/**
 * Launch the native Teams alias with process-local loopback debugger options.
 *
 * @param {number} port - Debugger TCP port.
 * @param {AbortSignal} [signal] - Stop a pending owned helper, never Teams.
 * @returns {Promise<void>} Completion of the Teams launch command.
 */
async function launchTeams(port, signal) {
    if (!process.env.LOCALAPPDATA) {
        throw new Error('LOCALAPPDATA is not defined');
    }

    const existing = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ?? '';

    if (/--remote-debugging-(port|address|pipe)/i.test(existing)) {
        throw new Error('Existing WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS has debugger options; remove them from this terminal environment first');
    }

    const alias = join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'ms-teams.exe');
    const literal = `'${alias.replaceAll('\'', '\'\'')}'`;

    await powershell(`$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${literal}`, signal, {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `${existing} --remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`.trim(),
    });
}

export { inspectWindows, validateListener, launchTeams };
