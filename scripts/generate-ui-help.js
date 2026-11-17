#!/usr/bin/env node
'use strict';
/** Project reviewed Markdown help rows into a deterministic local browser asset. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function parseCatalog(markdown) {
    const entries = {};
    for (const line of markdown.split('\n')) {
        const match = line.match(/^\| `([\w.-]+)` \| (.+) \| (.+) \| (.*?) \|$/);
        if (!match) {
            if (line.startsWith('| `')) throw new Error(`Malformed help row: ${line}`);
            continue;
        }
        const [, key, title, body, technical] = match;
        if (entries[key]) throw new Error(`Duplicate help key: ${key}`);
        entries[key] = { title, body, technical: technical === '—' ? '' : technical };
    }
    if (!entries['common.explain']) throw new Error('Help catalog is empty or malformed');
    return entries;
}
function projection() {
    const entries = parseCatalog(fs.readFileSync(path.join(root, 'docs/ui-explanation-catalog.md'), 'utf8'));
    return `'use strict';\n// Generated from docs/ui-explanation-catalog.md by scripts/generate-ui-help.js.\nwindow.PCM_HELP_COPY = ${JSON.stringify(entries, null, 2)};\n`;
}
if (require.main === module) {
    const file = path.join(root, 'src/shared/ui/help-copy.js');
    const result = projection();
    if (process.argv.includes('--check')) {
        if (fs.readFileSync(file, 'utf8') !== result) throw new Error('Help copy drift: run node scripts/generate-ui-help.js');
    } else fs.writeFileSync(file, result);
}
module.exports = { parseCatalog, projection };
