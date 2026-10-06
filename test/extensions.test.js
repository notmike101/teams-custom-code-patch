import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateConfig, validateFilename, readSnapshot } from '../lib/extensions.js';

/**
 * Create an isolated local extension inventory with automatic cleanup.
 *
 * @param {object} t - Node test context.
 * @param {object} [options] - Fixture file and configuration settings.
 * @param {object} [options.themes] - Theme filenames mapped to source text.
 * @param {object} [options.plugins] - Plugin filenames mapped to source text.
 * @param {unknown} [options.config] - Optional configuration to serialize.
 * @returns {Promise<string>} Temporary fixture directory.
 */
async function fixture(t, { themes = {}, plugins = {}, config } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'teams-custom-test-'));

    t.after(() => rm(dir, { recursive: true, force: true }));

    for await (const [kind, files] of Object.entries({ themes, plugins })) {
        await mkdir(join(dir, kind));

        for await (const [name, source] of Object.entries(files)) {
            await writeFile(join(dir, kind, name), source);
        }
    }

    if (config !== undefined) {
        await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    }

    return dir;
}

/**
 * Assert that every inventory entry remains disabled without loaded source.
 *
 * @param {Array<object>} entries - Inventory entries to inspect.
 */
function assertUnloaded(entries) {
    for (const entry of entries) {
        assert.equal(entry.enabled, false, entry.name);
        assert.equal(entry.source, undefined, entry.name);
        assert.equal(entry.revision, undefined, entry.name);
    }
}

test('filenames accept local children and reject traversal and Windows path forms', () => {
    for (const [name, suffix] of [
        ['theme.css', '.css'], ['my theme.css', '.css'],
        ['plugin.js', '.js'], ['plugin-v2.min.js', '.js'],
    ]) {
        assert.equal(validateFilename(name, suffix), true, name);
    }

    for (const name of [
        '../outside.js', '..\\outside.js', '/outside.js', '\\outside.js',
        'C:\\outside.js', 'C:outside.js', '\\\\server\\share\\outside.js',
        'nested/plugin.js', 'nested\\plugin.js', 'plugin.js:payload',
        'plugin.css', 'plugin.js.bak', 'plugin.js.', 'plugin.js ',
        'plugin\0.js', 'plugin\n.js', 'bad?.js', 'bad*.js', 'bad|.js',
        'bad<.js', 'bad>.js', 'bad".js', 'CON.js', 'NUL.js', 'aux.js',
        'COM1.js', 'LPT1.js', '', '.', '..', null, 42, {},
    ]) {
        assert.equal(validateFilename(name, '.js'), false, String(name));
    }

    assert.equal(validateFilename('plugin.js', '.css'), false);

    for (let code = 0; code < 32; code++) {
        assert.equal(validateFilename(`plugin${String.fromCharCode(code)}.js`, '.js'), false);
    }
});

test('config rejects wrong list types and non-filename entries', () => {
    for (const value of [null, [], 'config', 1]) {
        assert.throws(() => validateConfig(value));
    }

    for (const field of ['themes', 'plugins']) {
        for (const value of [null, 'all', true, {}, [null], [42], [{ name: 'marker.js' }]]) {
            assert.throws(() => validateConfig({ themes: [], plugins: [], [field]: value }));
        }
    }

    for (const [field, name] of [
        ['plugins', '../outside.js'], ['plugins', 'C:\\outside.js'],
        ['plugins', 'nested\\marker.js'], ['plugins', 'marker.css'],
        ['themes', '../outside.css'], ['themes', 'nested/dark.css'],
        ['themes', 'dark.js'],
    ]) {
        assert.throws(() => validateConfig({ themes: [], plugins: [], [field]: [name] }));
    }
});

test('config rejects prototype-shaped roots and entries', () => {
    for (const value of [
        JSON.parse('{"themes":[],"plugins":[],"__proto__":{"plugins":["evil.js"]}}'),
        { themes: [], plugins: [], constructor: { prototype: { plugins: ['evil.js'] } } },
        { themes: [], plugins: [], prototype: { plugins: ['evil.js'] } },
        Object.create({ themes: [], plugins: ['evil.js'] }),
        { themes: [], plugins: [JSON.parse('{"__proto__":{"name":"evil.js"}}')] },
    ]) {
        assert.throws(() => validateConfig(value));
    }
});

test('snapshots sort discovered filenames, load only enabled sources, and never execute JS', async (t) => {
    const marker = '__teamsCustomLoaderTestExecuted';

    assert.equal(globalThis[marker], undefined);
    t.after(() => {
        delete globalThis[marker];
    });
    const plugin = `globalThis.${marker} = true; return { start() {}, stop() {} };`;
    const dir = await fixture(t, {
        themes: { 'z.css': 'body { color: red; }', 'off.css': 'DO NOT LOAD', 'a.css': 'body { color: blue; }', 'notes.txt': 'ignore' },
        plugins: { 'z.js': plugin, 'off.js': 'throw new Error("disabled plugin executed");', 'a.js': 'return { start() {}, stop() {} };', 'notes.txt': 'ignore' },
        config: { themes: ['z.css', 'a.css'], plugins: ['z.js', 'a.js'] },
    });
    const snapshot = await readSnapshot(dir, false);

    assert.deepEqual(snapshot.themes.map(({ name, enabled }) => ({ name, enabled })), [
        { name: 'a.css', enabled: true }, { name: 'off.css', enabled: false }, { name: 'z.css', enabled: true },
    ]);
    assert.deepEqual(snapshot.plugins.map(({ name, enabled }) => ({ name, enabled })), [
        { name: 'a.js', enabled: true }, { name: 'off.js', enabled: false }, { name: 'z.js', enabled: true },
    ]);
    assert.equal(snapshot.themes[0].source, 'body { color: blue; }');
    assert.equal(snapshot.themes[2].source, 'body { color: red; }');
    assert.equal(snapshot.plugins[0].source, 'return { start() {}, stop() {} };');
    assert.equal(snapshot.plugins[2].source, plugin);

    for (const entry of [...snapshot.themes, ...snapshot.plugins].filter(({ enabled }) => enabled)) {
        assert.equal(typeof entry.revision, 'string');
        assert.notEqual(entry.revision, '');
    }

    assertUnloaded([snapshot.themes[1], snapshot.plugins[1]]);
    assert.deepEqual(snapshot.errors, []);
    assert.equal(globalThis[marker], undefined);
    assert.deepEqual(await readSnapshot(dir, false), snapshot);
    await writeFile(join(dir, 'plugins', 'off.js'), 'different disabled source');
    assert.deepEqual(await readSnapshot(dir, false), snapshot);
});

test('enabled file revisions change for same-size edits with unchanged timestamps', async (t) => {
    const dir = await fixture(t, {
        themes: { 'theme.css': 'body { color: red; }' },
        plugins: { 'plugin.js': 'return { start() { /* first */ }, stop() {} };' },
        config: { themes: ['theme.css'], plugins: ['plugin.js'] },
    });
    const fixedTime = new Date('2026-01-01T00:00:00Z');
    const themePath = join(dir, 'themes', 'theme.css');
    const pluginPath = join(dir, 'plugins', 'plugin.js');

    await utimes(themePath, fixedTime, fixedTime);
    await utimes(pluginPath, fixedTime, fixedTime);
    const before = await readSnapshot(dir, false);

    await writeFile(themePath, 'body { color: tan; }');
    await writeFile(pluginPath, 'return { start() { /* later */ }, stop() {} };');
    await utimes(themePath, fixedTime, fixedTime);
    await utimes(pluginPath, fixedTime, fixedTime);
    const after = await readSnapshot(dir, false);

    assert.equal(after.themes[0].source, 'body { color: tan; }');
    assert.equal(after.plugins[0].source, 'return { start() { /* later */ }, stop() {} };');
    assert.notEqual(after.themes[0].revision, before.themes[0].revision);
    assert.notEqual(after.plugins[0].revision, before.plugins[0].revision);
    assert.deepEqual(await readSnapshot(dir, false), after);
});

test('missing config leaves discovered extensions disabled', async (t) => {
    const dir = await fixture(t, {
        themes: { 'theme.css': 'body { color: red; }' },
        plugins: { 'plugin.js': 'throw new Error("must not execute");' },
    });
    const snapshot = await readSnapshot(dir, false);

    assert.deepEqual(snapshot.themes.map(({ name }) => name), ['theme.css']);
    assert.deepEqual(snapshot.plugins.map(({ name }) => name), ['plugin.js']);
    assertUnloaded([...snapshot.themes, ...snapshot.plugins]);
});

test('invalid config fails closed while retaining discoverable files and an error', async (t) => {
    const dir = await fixture(t, {
        themes: { 'theme.css': 'body { color: red; }' },
        plugins: { 'plugin.js': 'return { start() {}, stop() {} };' },
    });

    for await (const text of [
        '{broken JSON',
        '{"themes":["theme.css"],"plugins":"all"}',
        '{"themes":["theme.css"],"plugins":["../outside.js"]}',
        '{"themes":["theme.css"],"plugins":[],"__proto__":{"plugins":["plugin.js"]}}',
    ]) {
        await writeFile(join(dir, 'config.json'), text);
        const snapshot = await readSnapshot(dir, false);

        assert.deepEqual(snapshot.themes.map(({ name }) => name), ['theme.css']);
        assert.deepEqual(snapshot.plugins.map(({ name }) => name), ['plugin.js']);
        assertUnloaded([...snapshot.themes, ...snapshot.plugins]);
        assert.ok(snapshot.errors.length > 0);
        assert.ok(snapshot.errors.every((error) => typeof error === 'string' && error.length > 0));
    }
});

test('a missing enabled file reports an isolated error without dropping a healthy extension', async (t) => {
    const dir = await fixture(t, {
        plugins: { 'healthy.js': 'return { start() {}, stop() {} };' },
        config: { themes: [], plugins: ['missing.js', 'healthy.js'] },
    });
    const snapshot = await readSnapshot(dir, false);
    const healthy = snapshot.plugins.find(({ name }) => name === 'healthy.js');

    assert.equal(healthy.enabled, true);
    assert.equal(healthy.source, 'return { start() {}, stop() {} };');
    assert.ok(snapshot.errors.some((error) => typeof error === 'string' && error.includes('missing.js')));
});

test('safe mode retains management inventory but loads no enabled extensions', async (t) => {
    const dir = await fixture(t, {
        themes: { 'theme.css': 'body { color: red; }' },
        plugins: { 'plugin.js': 'throw new Error("must not execute");' },
        config: { themes: ['theme.css'], plugins: ['plugin.js'] },
    });
    const snapshot = await readSnapshot(dir, true);

    assert.deepEqual(snapshot.themes.map(({ name }) => name), ['theme.css']);
    assert.deepEqual(snapshot.plugins.map(({ name }) => name), ['plugin.js']);
    assertUnloaded([...snapshot.themes, ...snapshot.plugins]);
    assert.deepEqual(snapshot.errors, []);
});
