#!/usr/bin/env node
'use strict';

/** Generate the sandbox-owned Admin API; public PCM guidance remains external. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Remove server-rendered React markup while retaining the pinned bundled specification.
 * The browser's HTML normalization of rich OpenAPI descriptions can differ from
 * React's prerender tree. Redoc.init renders once rather than hydrating that tree.
 */
function clientRenderedDocument(html) {
    const start = html.indexOf('      <div id="redoc">');
    const script = html.indexOf('      <script>', start);
    const hydrate = 'Redoc.hydrate(__redoc_state, container);';
    if (start < 0 || script < 0 || html.split(hydrate).length !== 2 || !html.includes('"spec":{"data":')) {
        throw new Error('Pinned Redoc output structure changed; review the docs generator before publishing.');
    }
    return `${html.slice(0, start)}      <div id="redoc"></div>\n${html.slice(script)}`
        .replace(hydrate, 'Redoc.init(__redoc_state.spec.data, __redoc_state.options, container);')
        .replace(/^[ \t]+$/gm, '');
}

/** Regenerate outputs through the package-lock-pinned local CLI; never update normative inputs. */
function main() {
    const root = path.resolve(__dirname, '..');
    const cli = path.join(root, 'node_modules/@redocly/cli/bin/cli.js');
    for (const [input, output] of [['openapi-admin.yaml', 'admin-api-docs.html']]) {
        const filename = path.join(root, 'docs', output);
        execFileSync(process.execPath, [cli, 'build-docs', `docs/${input}`, '--disableGoogleFont', '-o', filename], { cwd: root, stdio: 'inherit' });
        fs.writeFileSync(filename, clientRenderedDocument(fs.readFileSync(filename, 'utf8')));
    }
}
if (require.main === module) main();
module.exports = { clientRenderedDocument, main };
