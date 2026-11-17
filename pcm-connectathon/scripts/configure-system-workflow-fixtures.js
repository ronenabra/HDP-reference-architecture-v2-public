#!/usr/bin/env node
'use strict';

/** Explicit opt-in configuration for the fabricated PCM-IG-040 workflow dataset. */
const fs = require('fs');
const path = require('path');
const { parseArgs, writeJson } = require('./lib');
const { assertValidTeamConfig } = require('../../src/shared/team-config-validator');
const fixture = require('../../clinical-data/pcm-ig-040/workflow-config.json');

/** Return a validated copy; ordinary team generation and startup remain empty by default. */
function configureWorkflowFixtures(config, { candidate042 = false } = {}) {
    const selected = candidate042 ? require('../../clinical-data/pcm-ig-042-workflows').candidateWorkflowFixtures().configuration : fixture;
    const next = structuredClone(config);
    if (!selected.participatingHmos.every(id => next.healthOrganizations.some(ho => ho.id === id))) {
        throw new Error('The fabricated workflow fixture requires managed HOs ho-a, ho-b and ho-c');
    }
    next.systemAuthorization.participatingHmos = structuredClone(selected.participatingHmos);
    next.systemAuthorization.memberships = structuredClone(selected.memberships);
    next.systemAuthorization.presenceEligiblePatients = structuredClone(selected.presenceEligiblePatients);
    next.systemAuthorization.discovery.eligibleRelationships = structuredClone(selected.eligibleRelationships);
    assertValidTeamConfig(next, { env: {} });
    return next;
}

/** Apply only an explicitly selected local disposable fixture through the maintained Admin boundary.
 * This resets PCM seed/opaque-token state; it never edits source clinical data.
 */
async function applyRunningWorkflowFixtures(config, password, fetchImpl = require('../../src/shared/outbound-destination').guardedFetch) {
    const url = new URL('/admin/restore', config.publicBaseUrls.pcmUi);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Running fixture application requires a local disposable Admin URL');
    const policy = require('../../src/shared/conformance-policy').buildEffectivePolicy(config, {});
    if (policy.exposure.adminAuthentication === 'required' && !password) throw new Error('Running fixture application requires its Admin password');
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const headers = { accept: 'application/json', 'content-type': 'application/json', ...(password ? { 'x-admin-password': password } : {}) };
    // Review the complete current protected backup; never synthesize or omit its credentials.
    const backupUrl = new URL('/admin/backup', url);
    const review = await fetchImpl(backupUrl.href, { method: 'GET', headers, signal: AbortSignal.timeout(30000) });
    if (!review.ok) throw new Error(`Running workflow fixture review failed: HTTP ${review.status}`);
    const backup = await review.json();
    if (backup.teamId !== config.teamId || !backup.certificates || !backup.teamConfig
        || String(backup.teamConfig.runtime?.revision || 0) !== String(config.runtime?.revision || 0)) {
        throw new Error('Running workflow configuration changed; review the owned fixture again before applying.');
    }
    const response = await fetchImpl(url.href, { method: 'POST', headers,
        body: JSON.stringify({ backupJson: JSON.stringify({ ...backup, teamConfig: config }), expectedRevision: String(backup.teamConfig.runtime.revision || 0) }),
        signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok || result.status !== 'restored' || result.applied !== 'pcm-runtime-reset' || result.listenerAdoption !== 'not-checked') throw new Error(`Running workflow fixture application failed: HTTP ${response.status}`);
    const readback = await fetchImpl(backupUrl.href, { method: 'GET', headers, signal: AbortSignal.timeout(30000) });
    const observed = readback.ok ? (await readback.json()).teamConfig : null;
    if (!observed || observed.runtime?.revision !== result.revision || ['systemAuthorization', 'securitySimulation', 'contract', 'conformance']
        .some(key => !require('node:util').isDeepStrictEqual(observed[key], config[key]))) throw new Error('Running workflow fixture PCM readback failed; other listeners were not checked.');
    return result;
}

/** Preview by default; --write preserves a byte-exact configuration backup before installing. */
async function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (!args['team-dir']) throw new Error('--team-dir is required; add --write only to install the preview');
    const file = path.resolve(args['team-dir'], 'team-config.json');
    const original = fs.readFileSync(file);
    const result = configureWorkflowFixtures(JSON.parse(original), { candidate042: args['candidate-042'] === true });
    if (args['apply-running'] && !args.write) throw new Error('--apply-running requires explicit --write and resets only the selected disposable PCM state');
    if (!args.write) return console.log(JSON.stringify(result, null, 2));
    if (!args['apply-running'] && JSON.stringify(result) === JSON.stringify(JSON.parse(original))) return;
    const backup = `${file}.pre-workflow-fixtures.json`;
    if (fs.existsSync(backup)) throw new Error('Fixture backup already exists; review it before another installation');
    fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    if (args['apply-running']) {
        const env = fs.readFileSync(path.join(path.dirname(file), '.env'), 'utf8');
        await applyRunningWorkflowFixtures(result, env.match(/^TEAM_ADMIN_PASSWORD=(.*)$/m)?.[1]);
    } else writeJson(file, result);
}
if (require.main === module) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { applyRunningWorkflowFixtures, configureWorkflowFixtures, main };
