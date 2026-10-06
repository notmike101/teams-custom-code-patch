import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Script } from 'node:vm';

/**
 * Accept only safe Windows child filenames with the required extension.
 *
 * @param {unknown} name - Candidate filename.
 * @param {string} suffix - Required supported extension.
 * @returns {boolean} Whether the name is a safe local filename.
 */
function validateFilename(name, suffix) {
    if (typeof name !== 'string' || !['.css', '.js'].includes(suffix)
        || name.length <= suffix.length || !name.endsWith(suffix)) {
        return false;
    }

    for (let index = 0; index < name.length; index++) {
        if (name.charCodeAt(index) < 32) {
            return false;
        }
    }

    return !/["*/:<>?\\|]/.test(name) && !/[ .]$/.test(name)
        && !/^(con|prn|aux|nul|com[1-9²³¹]|lpt[1-9²³¹])(?:\.|$)/i.test(name);
}

/**
 * Validate a plain configuration object and normalize enabled filename lists.
 *
 * @param {unknown} value - Untrusted decoded configuration.
 * @returns {object} Sorted, deduplicated theme and plugin lists.
 */
function validateConfig(value) {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
        || ['__proto__', 'constructor', 'prototype'].some((key) => Object.hasOwn(value, key))) {
        throw new Error('Config must be a plain object without prototype keys');
    }

    const config = {};

    for (const [kind, suffix] of [['themes', '.css'], ['plugins', '.js']]) {
        const list = Object.hasOwn(value, kind) ? value[kind] : [];

        if (!Array.isArray(list) || list.some((name) => !validateFilename(name, suffix))) {
            throw new Error(`${kind} must be an array of safe ${suffix} filenames`);
        }

        config[kind] = [...new Set(list)].sort();
    }

    return config;
}

/**
 * Read a regular local configuration file, accepting a UTF-8 BOM.
 *
 * @param {string} dataDir - Companion data directory.
 * @returns {Promise<object>} Validated configuration or empty lists when the file is absent.
 */
async function readConfig(dataDir) {
    const path = join(dataDir, 'config.json');

    try {
        const info = await lstat(path);

        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error('config.json must be a regular local file');
        }

        return validateConfig(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { themes: [], plugins: [] };
        }

        throw error;
    }
}

/**
 * Atomically replace a validated configuration without writing through links.
 *
 * @param {string} dataDir - Companion data directory.
 * @param {unknown} value - Replacement configuration to validate.
 * @returns {Promise<void>} Completion of the atomic replacement and temporary-file cleanup.
 */
async function writeConfig(dataDir, value) {
    const config = validateConfig(value);

    // Do not replace a linked configuration file with a privileged binding write.
    await readConfig(dataDir);
    const temporary = join(dataDir, `.config-${randomUUID()}.tmp`);

    try {
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(dataDir, 'config.json'));
    } finally {
        await unlink(temporary).catch((error) => {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        });
    }
}

/**
 * Scan safe local files deterministically and load only configured sources.
 *
 * @param {string} dataDir - Companion data directory.
 * @param {boolean} safeMode - Whether all user sources must remain unloaded.
 * @returns {Promise<object>} Ordered extension inventory, revisions and isolated load errors.
 */
async function readSnapshot(dataDir, safeMode = false) {
    const snapshot = { themes: [], plugins: [], errors: [], safeMode };
    let config = { themes: [], plugins: [] };

    try {
        config = await readConfig(dataDir);
    } catch (error) {
        snapshot.errors.push(`Config: ${error.message}`);
    }

    for await (const [kind, suffix] of [['themes', '.css'], ['plugins', '.js']]) {
        const directory = join(dataDir, kind);
        let files = [];

        try {
            const info = await lstat(directory);

            if (!info.isDirectory() || info.isSymbolicLink()) {
                throw new Error(`${kind} must be a real local directory`);
            }

            files = (await readdir(directory, { withFileTypes: true }))
                .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && validateFilename(entry.name, suffix))
                .map((entry) => entry.name).sort();
        } catch (error) {
            if (error.code !== 'ENOENT') {
                snapshot.errors.push(`${kind}: ${error.message}`);
            }
        }

        for (const name of config[kind]) {
            if (!files.includes(name)) {
                snapshot.errors.push(`Missing or unsafe ${kind} file: ${name}`);
            }
        }

        for await (const name of files) {
            const entry = { name, enabled: !safeMode && config[kind].includes(name), configured: config[kind].includes(name) };

            snapshot[kind].push(entry);

            if (!entry.enabled) {
                continue;
            }

            try {
                const path = join(directory, name);
                const info = await lstat(path);

                if (!info.isFile() || info.isSymbolicLink()) {
                    throw new Error('not a regular local file');
                }

                entry.source = await readFile(path, 'utf8');
                entry.revision = createHash('sha256').update(entry.source).digest('hex');
            } catch (error) {
                entry.enabled = false;
                snapshot.errors.push(`${name}: ${error.message}`);
            }
        }
    }

    return snapshot;
}

/**
 * Generate a browser snapshot expression with independently compiled plugin factories.
 *
 * @param {object} snapshot - Extension metadata and enabled source text.
 * @returns {string} Snapshot expression that does not execute plugin bodies on the host.
 */
function snapshotExpression(snapshot) {
    const plugins = snapshot.plugins.map(({ source, ...entry }) => {
        if (!entry.enabled || source === undefined) {
            return JSON.stringify(entry);
        }

        const body = `function() {\n${source}\n}\n//# sourceURL=teams-custom/${encodeURIComponent(entry.name)}\n`;

        try {
            // Compile only: a bad function body must not invalidate its neighbors' expression.
            new Script(`(${body})`);

            return `{...${JSON.stringify(entry)},factory:(${body})}`;
        } catch (error) {
            return JSON.stringify({ ...entry, error: `${entry.name}: ${error.message}` });
        }
    });
    const metadata = {
        ...snapshot, themes: snapshot.themes.map((theme) => {
            const entry = { ...theme };

            delete entry.source;

            return entry;
        }),
    };

    delete metadata.plugins;

    return `({...${JSON.stringify(metadata)},plugins:[${plugins.join(',')}]})`;
}

export { validateFilename, validateConfig, readConfig, writeConfig, readSnapshot, snapshotExpression };
