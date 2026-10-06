import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setInterval, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createManagedControl } from '../lib/managed.js';

/**
 * Create real streams for exercising the managed command protocol.
 *
 * @param {object} t - Test context responsible for stream cleanup.
 * @returns {object} Controller, streams, emitted events and stop count.
 */
function control(t) {
    const input = new PassThrough();
    const output = new PassThrough();
    const events = [];
    const result = { input, output, events, stops: 0 };

    output.on('data', (chunk) => events.push(...chunk.toString().trim().split('\n').map((line) => JSON.parse(line))));
    result.controller = createManagedControl(input, output, () => {
        result.stops++;
    });
    t.after(() => {
        result.controller.close();
        output.destroy();
    });

    return result;
}

test('managed control accepts fragmented stop once and emits versioned status', (t) => {
    const result = control(t);

    result.controller.status('running', 'Watching Teams', 12_345);
    assert.deepEqual(result.events[0], { protocol: 1, state: 'running', message: 'Watching Teams', port: 12_345 });
    result.input.write('st');
    result.input.write('op\r\nstop\n');
    assert.equal(result.stops, 1);
    const invalid = control(t);

    invalid.input.write('launch\n');
    assert.equal(invalid.events.at(-1).state, 'error');
    assert.equal(invalid.stops, 0);
    result.controller.status('waiting', '\u0001'.repeat(20_000));
    assert.equal(result.events.at(-1).message.length, 1_000);
});

test('managed control rejects oversized commands without treating their suffix as stop', (t) => {
    const result = control(t);

    result.input.write('x'.repeat(5_000));
    result.input.write('stop\n');
    assert.equal(result.stops, 0);
    assert.equal(result.events.filter((event) => event.state === 'error').length, 1);
    result.input.write('stop\n');
    assert.equal(result.stops, 1);
});

test('managed parent EOF stops exactly once and cleanup closes input', async (t) => {
    const result = control(t);
    const ended = once(result.input, 'end');

    result.input.end('stop\n');
    await ended;
    assert.equal(result.stops, 1);
    result.controller.close();
    assert.equal(result.input.destroyed, true);
    const eof = control(t);
    const eofEnded = once(eof.input, 'end');

    eof.input.end();
    await eofEnded;
    assert.equal(eof.stops, 1);
});

test('unconsumed managed output fails closed at its fixed queue boundary', async (t) => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    let stops = 0;
    const controller = createManagedControl(input, output, () => {
        stops++;
        // Shutdown may emit terminal statuses before it drains its work queue.
        controller.status('stopping', 'Cleaning up');
    });

    t.after(() => {
        controller.close();
        output.destroy();
    });
    const record = `${JSON.stringify({ protocol: 1, state: 'error', message: 'Unknown managed command; expected stop' })}\n`;
    const recordBytes = Buffer.byteLength(record);
    const accepted = Math.floor(65_536 / recordBytes);

    input.write('\n'.repeat(accepted));
    assert.equal(stops, 0);
    assert.equal(output.writableLength, accepted * recordBytes);
    assert.equal(output.destroyed, false);
    input.write('\n');
    assert.equal(stops, 1);
    assert.equal(output.destroyed, true);
    assert.ok(output.writableLength <= 65_536);
    input.write('invalid\n'.repeat(100_000));
    controller.status('running', 'Must not enqueue after pipe failure');
    input.end('stop\n');
    await delay(0);
    assert.equal(stops, 1);
    assert.equal(output.closed, true);
    assert.ok(output.writableLength <= 65_536);
    controller.close();
    assert.equal(input.destroyed, true);
});

test('real managed output saturation exits naturally while parent stdout remains unread', { skip: process.platform !== 'win32', timeout: 10_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'teams-managed-output-'));
    const child = spawn(process.execPath, [
        fileURLToPath(new URL('../index.js', import.meta.url)),
        '--managed', '--attach', '--port', '65535', '--data-dir', directory,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const exited = once(child, 'exit');
    const closed = once(child, 'close');
    let stderr = '';

    t.after(async () => {
        child.stdout.resume();

        if (child.exitCode === null) {
            child.kill();
        }

        await closed;
        await rm(directory, { recursive: true, force: true });
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    /* Leave stdout entirely unread until the child has exited; a dummy
       process.stdout.destroy() cannot release its pending native write. */
    child.stdin.end('\n'.repeat(1_000_000));
    const [code, signal] = await exited;

    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
    child.stdout.resume();
    await closed;
    await assert.rejects(access(join(directory, 'companion.lock')), { code: 'ENOENT' });
});

/**
 * Launch the real CLI with isolated data and collect its protocol output.
 *
 * @param {object} t - Test context owning temporary data.
 * @param {string} [command] - Parent input followed by EOF.
 * @returns {Promise<object>} Exit code, events and temporary directory.
 */
async function runManaged(t, command = '') {
    const directory = await mkdtemp(join(tmpdir(), 'teams-managed-'));

    t.after(() => rm(directory, { recursive: true, force: true }));
    const child = spawn(process.execPath, [
        fileURLToPath(new URL('../index.js', import.meta.url)),
        '--managed', '--data-dir', directory,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = once(child, 'close');
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(command);
    const [code] = await closed;
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));

    return { code, events, stderr, directory };
}

test('real managed startup EOF and stop clean their lock without launching Teams', { timeout: 15_000 }, async (t) => {
    await Promise.all(['', 'stop\n'].map(async (command) => {
        const result = await runManaged(t, command);

        assert.equal(result.code, 0, result.stderr);
        assert.ok(result.events.every((event) => event.protocol === 1));
        assert.equal(result.events[0].state, 'starting');
        assert.equal(result.events.at(-1).state, 'stopped');
        assert.ok(!result.events.some((event) => event.port !== undefined));
        await assert.rejects(access(join(result.directory, 'companion.lock')), { code: 'ENOENT' });
    }));
});

test('managed Stop and EOF abort the pending owned launch helper without startup failure', { skip: process.platform !== 'win32', timeout: 20_000 }, async (t) => {
    await Promise.all(['stop\n', ''].map(async (command) => {
        const directory = await mkdtemp(join(tmpdir(), 'teams-managed-launch-'));
        const ready = join(directory, 'helper.pid');
        const dispatched = join(directory, 'dispatched');
        const preload = join(directory, 'helper-preload.mjs');

        /* Keep execFile and its real PowerShell child; replace only the native
           process query/dispatch boundary so this regression never starts Teams. */
        await writeFile(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const execFile = childProcess.execFile;
const execute = promisify(execFile);
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const replacement = (...args) => execFile(...args);
replacement[promisify.custom] = (file, args, options) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const controlled = script.includes('Start-Process')
        ? "[IO.File]::WriteAllText(" + literal(${JSON.stringify(ready)}) + ", [string]$PID); Start-Sleep -Seconds 30; [IO.File]::WriteAllText(" + literal(${JSON.stringify(dispatched)}) + ", 'dispatched')"
        : "Write-Output '{\\"processes\\":[],\\"listeners\\":[]}'";
    return execute(file, [...args.slice(0, -1), Buffer.from(controlled, 'utf16le').toString('base64')], options);
};
childProcess.execFile = replacement;
syncBuiltinESMExports();
`);
        const child = spawn(process.execPath, [
            '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../index.js', import.meta.url)),
            '--managed', '--data-dir', directory,
        ], {
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            env: { ...process.env, LOCALAPPDATA: directory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '' },
        });
        const closed = once(child, 'close');
        let helperPid;
        let stdout = '';
        let stderr = '';

        t.after(async () => {
            if (child.exitCode === null) {
                child.kill();
                await closed;
            }

            await rm(directory, { recursive: true, force: true });
        });
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.stdin.on('error', () => undefined);
        const deadline = Date.now() + 5_000;

        for await (const path of setInterval(20, ready)) {
            if (Date.now() >= deadline || child.exitCode !== null) {
                break;
            }

            try {
                helperPid = Number(await readFile(path, 'utf8'));
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }

            if (helperPid) {
                break;
            }
        }

        assert.ok(helperPid > 0, `Owned launch helper never became pending: ${stderr}`);
        process.kill(helperPid, 0);
        child.stdin.end(command);
        const [code] = await closed;
        const events = stdout.trim().split('\n').map((line) => JSON.parse(line));

        assert.equal(code, 0, stderr);
        assert.ok(!events.some((event) => event.state === 'error'), stdout);
        assert.equal(events.at(-1).state, 'stopped');
        assert.throws(() => process.kill(helperPid, 0), { code: 'ESRCH' });
        helperPid = undefined;
        await assert.rejects(access(dispatched), { code: 'ENOENT' });
        await assert.rejects(access(join(directory, 'companion.lock')), { code: 'ENOENT' });
    }));
});

test('real managed option errors remain JSON and exit without touching an existing lock', { timeout: 15_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'teams-managed-error-'));

    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, 'companion.lock'), 'existing owner\n');
    const child = spawn(process.execPath, [
        fileURLToPath(new URL('../index.js', import.meta.url)),
        '--managed', '--data-dir', directory, '--invalid',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = once(child, 'close');
    let stdout = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    const [code] = await closed;
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(code, 1);
    assert.ok(events.some((event) => event.state === 'error' && /Unknown option/.test(event.message)));
    assert.equal(events.at(-1).state, 'stopped');
    assert.equal(child.stdin.destroyed, true);
    assert.equal(await readFile(join(directory, 'companion.lock'), 'utf8'), 'existing owner\n');
});
