'use strict';
/** Run accepted PAGE/TOTAL/EVERYTHING small-fixture oracles under unchanged named controls. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const runtime = require('./demo-runtime-client');
const { createApprovedClinicalConsent } = require('./gateway-clinical-count-matrix');
/** Use existing real opaque-token qualification without enabling disabled simulations. */
async function main() {
    const scenarios = [], before = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
    for (const operation of ['page', 'total', 'everything']) scenarios.push(...await require(`./gateway-clinical-${operation}-matrix`).qualify(await createApprovedClinicalConsent()));
    const after = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
    assert.deepEqual(after.securitySimulation, before.securitySimulation);
    const result = { preset: runtime.config.conformance.preset, scenarios, controlsPreserved: true,
        notice: runtime.config.conformance.preset === 'connectathon-easy' ? 'Transport/authentication simulation — clinical scope and Patient enforcement remain mandatory' : 'Configured native filtering retained' };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
