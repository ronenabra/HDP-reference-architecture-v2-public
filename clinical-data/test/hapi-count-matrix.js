'use strict';

/** Native signed clinical count acceptance for all three HOs in every preset. */
const fs = require('node:fs');
const { runCountHo } = require('./hapi-authorization-matrix');

async function main() {
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) await runCountHo(ho);
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT,
        JSON.stringify({ scenarios: [{ id: 'hapi-authorized-counts', status: 'pass', executed: true }] }));
    process.stdout.write('HAPI THREE-HO AUTHORIZED COUNT MATRIX PASS\n');
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { main };
