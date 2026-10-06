import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readConfig, writeConfig } from '../lib/extensions.js';

test('config supports Windows UTF-8 BOM and rejects invalid replacement without changing the file', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'teams-custom-config-'));

    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'config.json');

    await writeFile(path, '\uFEFF{"themes":[],"plugins":[]}');
    assert.deepEqual(await readConfig(dir), { themes: [], plugins: [] });
    const before = await readFile(path, 'utf8');

    await assert.rejects(writeConfig(dir, { plugins: ['../evil.js'] }));
    assert.equal(await readFile(path, 'utf8'), before);
    await writeConfig(dir, { themes: ['a.css'], plugins: [] });
    assert.deepEqual(await readConfig(dir), { themes: ['a.css'], plugins: [] });
    assert.deepEqual(await readdir(dir), ['config.json']);
});
