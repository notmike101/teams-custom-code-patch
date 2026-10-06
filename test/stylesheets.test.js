import assert from 'node:assert/strict';
import test from 'node:test';
import { writeOwnedStyleSheet, clearOwnedStyleSheets } from '../index.js';

/* Model only the CDP boundary: sheets outlive sockets, and each session has fresh IDs.
   Headers intentionally expose empty sourceURL/title, as observed in native Teams. */
/**
 * Model current-session CDP headers over sheets that survive socket replacement.
 *
 * @param {Map<string, object>} sheets - Persistent stylesheet contents indexed by session identifier.
 * @returns {object} Target model and created-sheet counter.
 */
function session(sheets) {
    let created = 0;
    const headers = new Map([...sheets].map(([id, sheet]) => [id, { styleSheetId: id, frameId: sheet.frame, origin: sheet.origin ?? 'inspector', sourceURL: '', title: '' }]));
    const target = {
        sheets: headers, ownedSheets: new Set(),
        cdp: {
            /**
             * Execute a modeled stylesheet protocol request with promise rejection semantics.
             *
             * @param {string} method - Stylesheet CDP method.
             * @param {object} params - Protocol arguments.
             * @returns {Promise<object>} Modeled protocol result.
             */
            async send(method, params) {
                if (method === 'CSS.getStyleSheetText') {
                    assert.ok(sheets.has(params.styleSheetId), 'must use current-session header IDs');

                    return await Promise.resolve({ text: sheets.get(params.styleSheetId).text });
                }

                if (method === 'CSS.setStyleSheetText') {
                    assert.ok(sheets.has(params.styleSheetId), 'must use current-session header IDs');
                    sheets.get(params.styleSheetId).text = params.text;

                    return {};
                }

                if (method === 'CSS.createStyleSheet') {
                    const id = `created-${++created}`;

                    sheets.set(id, { frame: params.frameId, text: '' });
                    headers.set(id, { styleSheetId: id, frameId: params.frameId, origin: 'inspector', sourceURL: '', title: '' });

                    return { styleSheetId: id };
                }

                throw new Error(`Unexpected CDP method: ${method}`);
            },
        },
    };

    return {
        target,
        /**
         * Read the number of sheets created by this session.
         *
         * @returns {number} Created stylesheet count.
         */
        created: () => created,
    };
}

const frame = { id: 'top', loaderId: 'document-1' };

test('fresh-session text ownership reuses surviving sheets and removes duplicate declarations on edits and shutdown', async () => {
    const sheets = new Map([
        ['fresh-32', { frame: 'top', text: '/* teams-custom-owner: companion */\n.old-color { color: red }' }],
        ['fresh-33', { frame: 'top', text: '/* teams-custom-owner: companion */\n.old-border { border: 1px solid }' }],
        ['foreign', { frame: 'top', text: '/* teams-custom-owner: other */\n.foreign { color: green }' }],
        ['unmarked', { frame: 'top', text: '.unmarked { color: blue }' }],
        ['regular', { frame: 'top', origin: 'regular', text: '/* teams-custom-owner: companion */\n.site { color: black }' }],
    ]);
    const { target, created } = session(sheets);

    await writeOwnedStyleSheet(target, 'companion', frame, '.new-border { border: 2px solid }');
    assert.equal(created(), 0);
    assert.equal(target.sheetId, 'fresh-32');
    assert.equal(sheets.get('fresh-32').text, '/* teams-custom-owner: companion */\n.new-border { border: 2px solid }');
    assert.equal(sheets.get('fresh-33').text, '/* teams-custom-owner: companion */\n');
    await writeOwnedStyleSheet(target, 'companion', frame, '');
    assert.equal(sheets.get('fresh-32').text, '/* teams-custom-owner: companion */\n');
    await clearOwnedStyleSheets(target);
    assert.equal(sheets.get('fresh-32').text, '');
    assert.equal(sheets.get('fresh-33').text, '');
    assert.equal(sheets.get('foreign').text, '/* teams-custom-owner: other */\n.foreign { color: green }');
    assert.equal(sheets.get('unmarked').text, '.unmarked { color: blue }');
    assert.equal(sheets.get('regular').text, '/* teams-custom-owner: companion */\n.site { color: black }');
});

test('recovery clears same-owner headers added during an awaited stylesheet text read', async () => {
    const sheets = new Map([
        ['first', { frame: 'top', text: '/* teams-custom-owner: companion */\n.old { color: red }' }],
    ]);
    const { target, created } = session(sheets);
    const send = target.cdp.send;

    /**
     * Deliver a stylesheet-added event while the first text request is pending.
     *
     * @param {string} method - Stylesheet CDP method.
     * @param {object} params - Protocol arguments.
     * @returns {Promise<object>} Modeled protocol result.
     */
    target.cdp.send = async (method, params) => {
        const result = send(method, params);

        if (method === 'CSS.getStyleSheetText' && params.styleSheetId === 'first') {
            await Promise.resolve();
            sheets.set('late', { frame: 'top', text: '/* teams-custom-owner: companion */\n.duplicate { color: green }' });
            target.sheets.set('late', { styleSheetId: 'late', frameId: 'top', origin: 'inspector', sourceURL: '', title: '' });
        }

        return await result;
    };

    await writeOwnedStyleSheet(target, 'companion', frame, '.new { color: blue }');
    assert.equal(created(), 0);
    assert.equal(target.sheetId, 'first');
    assert.equal(sheets.get('first').text, '/* teams-custom-owner: companion */\n.new { color: blue }');
    assert.equal(sheets.get('late').text, '/* teams-custom-owner: companion */\n');
    await clearOwnedStyleSheets(target);
    assert.equal(sheets.get('first').text, '');
    assert.equal(sheets.get('late').text, '');
});

test('new document recovers current-frame ownership and blanks previous owned frames before creating a sheet', async () => {
    const sheets = new Map([
        ['previous-frame', { frame: 'old-top', text: '/* teams-custom-owner: companion */\n.old { color: red }' }],
    ]);
    const { target, created } = session(sheets);

    await writeOwnedStyleSheet(target, 'companion', frame, '.first { color: blue }');
    assert.equal(created(), 1);
    assert.equal(sheets.get('previous-frame').text, '/* teams-custom-owner: companion */\n');

    // CSS.styleSheetRemoved removes destroyed-document IDs before frameNavigated.
    for (const id of [...target.sheets.keys()]) {
        target.sheets.delete(id);
        target.ownedSheets.delete(id);
        sheets.delete(id);
    }

    target.sheetId = undefined;
    await writeOwnedStyleSheet(target, 'companion', { id: 'top', loaderId: 'document-2' }, '.second { color: green }');
    assert.equal(created(), 2);
    assert.equal(sheets.get('created-2').text, '/* teams-custom-owner: companion */\n.second { color: green }');
    await clearOwnedStyleSheets(target);
    assert.equal(sheets.get('created-2').text, '');
});

test('unreadable inspector text fails closed rather than adding another stylesheet', async () => {
    const { target, created } = session(new Map([['gone', { frame: 'top', text: '' }]]));

    /**
     * Reject stylesheet access to model a disconnected CDP session.
     *
     * @returns {Promise<never>} Rejected transport operation.
     */
    target.cdp.send = () => Promise.reject(new Error('CDP connection closed'));

    await assert.rejects(writeOwnedStyleSheet(target, 'companion', frame, '.new { color: red }'), /connection closed/);
    assert.equal(created(), 0);
});
