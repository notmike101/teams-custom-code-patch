import assert from 'node:assert/strict';
import test from 'node:test';
import { validateListener } from '../lib/windows.js';

const browser = { pid: 2, name: 'msedgewebview2.exe', commandLine: 'msedgewebview2.exe --webview-exe-name=ms-teams.exe', parentPid: 1 };
const teams = { pid: 1, name: 'ms-teams.exe', parentPid: 0, commandLine: 'ms-teams.exe' };
const state = { processes: [teams, browser], listeners: [{ address: '127.0.0.1', pid: 2 }] };

test('ownership accepts only loopback Teams-hosted WebView2 with Teams ancestry', () => {
    assert.equal(validateListener(state).pid, 2);

    for (const invalid of [
        { ...state, listeners: [{ address: '0.0.0.0', pid: 2 }] },
        { ...state, listeners: [{ address: '127.0.0.1', pid: 1 }] },
        { ...state, processes: [teams, { ...browser, commandLine: 'msedgewebview2.exe --webview-exe-name=other.exe' }] },
        { ...state, processes: [{ ...teams, name: 'other.exe' }, browser] },
        { ...state, listeners: [...state.listeners, { address: '::', pid: 2 }] },
    ]) {
        assert.throws(() => validateListener(invalid));
    }
});
