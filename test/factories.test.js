import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { snapshotExpression } from '../lib/extensions.js';

test('one plugin syntax error does not prevent healthy factory compilation or execute sources on host', () => {
    const snapshot = {
        themes: [], errors: [], plugins: [
            { name: 'broken.js', enabled: true, revision: '1', source: 'return {' },
            { name: 'healthy.js', enabled: true, revision: '2', source: 'globalThis.executed = true; return { start() {}, stop() {} };' },
            { name: 'off.js', enabled: false },
        ],
    };
    const context = vm.createContext({});
    const value = vm.runInContext(snapshotExpression(snapshot), context);

    assert.match(value.plugins[0].error, /broken.js/);
    assert.equal(typeof value.plugins[1].factory, 'function');
    assert.equal(value.plugins[2].factory, undefined);
    assert.equal(context.executed, undefined);
    value.plugins[1].factory();
    assert.equal(context.executed, true);
});
