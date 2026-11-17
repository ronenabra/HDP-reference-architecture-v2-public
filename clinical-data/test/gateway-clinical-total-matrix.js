'use strict';
/** Three-source opaque PCM token TOTAL proof over the existing eight-resource-per-HO fixture. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const runtime = require('./demo-runtime-client');
const { equivalentTokens, authorityKey } = require('./equivalent-page-authority');
const crypto = require('node:crypto');
const { createApprovedClinicalConsent } = require('./gateway-clinical-count-matrix');
const { buildEffectivePolicy, sourceSimulationControls } = require('/shared/conformance-policy');
const { countFixtureCases } = require('./count-fixture-oracle');

/** Mint new ordinary authority for each continuation and follow the literal public URL. */
async function qualify(consent) {
    const scenarios = [];
    for (const [index, ho] of runtime.config.healthOrganizations.entries()) {
        const config = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
        const policy = buildEffectivePolicy(config, process.env);
        const oracle = countFixtureCases(ho.id, sourceSimulationControls(policy, config, { resource: ho.endpoint }), runtime.savedApproval(consent).scope);
        const expectedIds = oracle.known;
        const ids = [], pages = [];
        const scopes = [];
        const pair = await equivalentTokens(() => runtime.issue(consent, undefined, index));
        const authorityFingerprint = crypto.createHash('sha256').update(authorityKey(pair[0].json)).digest('hex');
        let url = `${ho.endpoint}/Observation?_count=1&_total=accurate&_sort=date`;
        for (let n = 0; n < 10; n++) {
            const issued = pair[n === 0 ? 0 : 1];
            assert.equal(issued.status, 200, `${ho.id} ordinary token issuance`);
            const response = await runtime.request(url, { bearer: issued.json.access_token });
            assert.equal(response.status, 200, `${url}: ${JSON.stringify(response.json)} priorScope=${scopes.at(-1)} newScope=${issued.json.scope}`);
            scopes.push(issued.json.scope);
            assert.equal(response.json.total, expectedIds.length);
            const primary = (response.json.entry || []).filter(e => e.search?.mode === 'match').map(e => e.resource.id);
            assert.equal(primary.length, 1, `${ho.id} useful one-match page`);
            ids.push(...primary);
            const next = response.json.link?.find(link => link.relation === 'next')?.url;
            pages.push({ ids: primary, url, total: response.json.total, next: next || null, authorityRevalidated: true, distinctEquivalentToken: n === 1, grantedScope: issued.json.scope });
            if (!next) break;
            assert.equal(new URL(next).origin, new URL(ho.endpoint).origin);
            assert.equal(new URL(next).pathname, new URL(ho.endpoint).pathname.replace(/\/$/, ''));
            url = next; assert.ok(n < 9);
        }
        assert.deepEqual(ids, expectedIds, `${ho.id} independent clinical TOTAL fixture IDs`);
        scenarios.push({ id: `gateway-clinical-total-${oracle.nativeFiltering ? 'enforced' : 'simulation'}-${ho.id}`,
            status: 'pass', executed: true, ordinaryPcmToken: true, effectiveNativePolicy: oracle.mode,
            approvedScope: runtime.savedApproval(consent).scope, expectedIds, actualIds: ids, authorityFingerprint, distinctApprovedOpaqueTokens: 2, pages });
    }
    return scenarios;
}

/** Easy transport checks can change; every observed grant and native filter stays mandatory. */
async function main() {
    const scenarios = [];
    try {
        scenarios.push(...await qualify(await createApprovedClinicalConsent()));
        if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT + '.default-checkpoint', JSON.stringify({ preset: runtime.config.conformance.preset, status: 'pass', scenarios }, null, 2));
        if (runtime.config.conformance.preset === 'connectathon-easy') {
            assert.equal((await runtime.save({ transportChecks: true })).status, 200);
            scenarios.push(...await qualify(await createApprovedClinicalConsent()));
        if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT + '.default-checkpoint', JSON.stringify({ preset: runtime.config.conformance.preset, status: 'pass', scenarios }, null, 2));
        }
    } finally {
        if (runtime.config.conformance.preset === 'connectathon-easy') {
            const response = await fetch(`${runtime.config.internalBaseUrls.pcmUi}/admin/config/simulation`, {
                method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD || '' },
                body: JSON.stringify({ preset: 'connectathon-easy' }), signal: AbortSignal.timeout(15000)
            });
            assert.equal(response.status, 200, 'restore named Easy defaults');
        }
    }
    const result = { preset: runtime.config.conformance.preset, status: 'pass', scope: 'total-backend-small-fixture', scenarios };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { main, qualify };
