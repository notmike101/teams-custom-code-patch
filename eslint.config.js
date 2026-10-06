import javascript from '@notmike101/eslint-config-js';
import jsdoc from '@notmike101/eslint-config-jsdoc';
import globals from 'globals';

export default [
    {
        ignores: ['.tools/**', 'build/**', 'dist/**'],
    },
    ...javascript,
    ...jsdoc,
    {
        files: ['index.js', 'lib/**/*.js', 'test/**/*.js'],
        languageOptions: {
            globals: {
                ...Object.fromEntries(Object.keys(globals.browser).map((name) => [name, 'off'])),
                ...globals.node,
            },
        },
    },
    {
        files: ['inject/runtime.js'],
        languageOptions: {
            sourceType: 'script',
        },
    },
];
