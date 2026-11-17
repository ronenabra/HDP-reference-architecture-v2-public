'use strict';
/** Small Easy COUNT proof: frozen clinical grants persist across supported transport changes. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { NATIVE_FILTER_CONTROLS } = require(fs.existsSync(path.resolve(__dirname, '../../src/shared/conformance-policy.js'))
    ? '../../src/shared/conformance-policy' : '/shared/conformance-policy');

/** Require the observed effective native group at every source, rather than infer it from a preset label. */
function assertNativeMode(snapshot) {
    assert.equal(snapshot.preset, 'connectathon-easy');
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        assert.ok(NATIVE_FILTER_CONTROLS.every(name => snapshot.sourceControls[ho]?.[name] === true), `${ho} mandatory native authorization group`);
    }
}

/** Run injected ordinary-token helpers across both transport profiles and always restore the named preset before returning a verdict. */
async function qualifyEasyCountControls({ snapshot, createConsent, qualify, enableTransportChecks, restore }) {
    const policy = {}, scenarios = [];
    try {
        policy.default = snapshot(); assertNativeMode(policy.default);
        const defaultProfile = await qualify(await createConsent());
        assert.ok(defaultProfile.length && defaultProfile.every(item => item.nativeFiltering === true));
        scenarios.push(...defaultProfile);
        assert.equal((await enableTransportChecks()).status, 200);
        policy.enforced = snapshot(); assertNativeMode(policy.enforced);
        const enforced = await qualify(await createConsent());
        assert.ok(enforced.length && enforced.every(item => item.nativeFiltering === true));
        scenarios.push(...enforced);
    } finally {
        assert.equal((await restore()).status, 200, 'restore the named easy preset');
        policy.restored = snapshot(); assertNativeMode(policy.restored);
        if (policy.default) assert.equal(policy.restored.policyVersion, policy.default.policyVersion);
    }
    return { preset: 'connectathon-easy', status: 'pass', scope: 'backend-count-small-fixture', policy, scenarios };
}

/** Bind live policy snapshots and existing ordinary PCM helpers to the three small native fixtures. */
async function main() {
    const runtime = require('./demo-runtime-client');
    const positive = require('./gateway-clinical-count-matrix');
    const { buildEffectivePolicy, sourceSimulationControls } = require('/shared/conformance-policy');
    const snapshot = () => {
        const config = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
        const policy = buildEffectivePolicy(config, process.env);
        return { preset: config.conformance.preset, policyVersion: policy.version,
            sourceControls: Object.fromEntries(config.healthOrganizations.map(ho => [ho.id,
                sourceSimulationControls(policy, config, { resource: ho.endpoint })])) };
    };
    const result = await qualifyEasyCountControls({ snapshot,
        createConsent: positive.createApprovedClinicalConsent, qualify: positive.qualifyGatewayClinicalCounts,
        enableTransportChecks: () => runtime.save({ transportChecks: true }),
        restore: async () => {
            const response = await fetch(`${runtime.config.internalBaseUrls.pcmUi}/admin/config/simulation`, {
                method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
                    'x-admin-password': process.env.TEAM_ADMIN_PASSWORD || '' },
                body: JSON.stringify({ preset: 'connectathon-easy' }), signal: AbortSignal.timeout(15000)
            });
            return { status: response.status };
        }
    });
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { assertNativeMode, qualifyEasyCountControls };
