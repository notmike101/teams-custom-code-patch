import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CdpConnection } from '../lib/cdp.js';

/**
 * Create a local protocol endpoint and register connection cleanup.
 *
 * @param {object} t - Node test context.
 * @param {function(object, object): void} handle - Handler for decoded incoming protocol requests.
 * @returns {Promise<CdpConnection>} Connected transport under test.
 */
async function endpoint(t, handle) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    await once(server, 'listening');
    server.on('connection', (socket) => socket.on('message', (data) => handle(socket, JSON.parse(data))));
    t.after(() => {
        for (const client of server.clients) {
            client.terminate();
        }

        return new Promise((resolve) => {
            server.close(resolve);
        });
    });
    const connection = new CdpConnection({ timeout: 80 });

    t.after(() => connection.close());
    await connection.connect(`ws://127.0.0.1:${server.address().port}/devtools/page/test`);

    return connection;
}

test('CDP correlates results and rejects protocol errors without poisoning later requests', async (t) => {
    const cdp = await endpoint(t, (socket, { id, method }) => socket.send(JSON.stringify(
        method === 'Broken' ? { id, error: { code: -32_601, message: 'Unknown method' } } : { id, result: { method } },
    )));

    await assert.rejects(cdp.send('Broken'), /Unknown method/);
    assert.deepEqual(await cdp.send('Healthy'), { method: 'Healthy' });
});

test('CDP times out unanswered requests and remains usable', async (t) => {
    const cdp = await endpoint(t, (socket, { id, method }) => {
        if (method === 'Healthy') {
            socket.send(JSON.stringify({ id, result: {} }));
        }
    });

    await assert.rejects(cdp.send('Never'), /timed out/i);
    assert.deepEqual(await cdp.send('Healthy'), {});
});

test('CDP rejects every pending request on remote disconnect and local close', async (t) => {
    const remote = await endpoint(t, (socket) => socket.close());

    await assert.rejects(remote.send('Pending'), /closed|disconnect/i);
    const local = await endpoint(t, () => undefined);
    const pending = local.send('Pending');

    local.close();
    await assert.rejects(pending, /closed|disconnect/i);
    await assert.rejects(local.send('Later'), /closed|connect/i);
});
