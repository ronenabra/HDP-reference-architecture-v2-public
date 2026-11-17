'use strict';
/** Real bounded Admin publication, exact source ownership and future token issuance. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
const baseline = installTestRuntime();
const router = require('../src/routes/ui'), model = require('../src/admin-security');
const { SIMULATION_CONTROLS, PRESETS, buildEffectivePolicy } = require('../../shared/conformance-policy');
const read = () => JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
function seed(preset = 'connectathon-balanced', overrides = {}) { const config = buildTeamConfig(overrides, preset); config.runtime = baseline.runtime; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config)); return config; }
/** Submit the protected existing endpoint; no test persistence substitute. */
function submit(body, route = '/admin/config/simulation') {
    const req = { body, path: route, query: {}, params: {}, get: () => 'application/json' };
    const result = { status: 200 }, res = { status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; }, format(types) { return types.json(); } };
    router.stack.find(layer => layer.route?.path === route).route.stack[0].handle(req, res); return result;
}
function form(config, sourceId = '') { return { adminForm: 'simulation', expectedRevision: String(config.runtime.revision || 0), sourceId, preset: config.conformance.preset, resetDefaults: 'false', ...Object.fromEntries(SIMULATION_CONTROLS.map(name => [`control.${name}`, sourceId ? 'inherit' : String(config.securitySimulation.global[name])])) }; }
function unchanged(body, status = 400, route) { const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH); const result = submit(body, route); assert.equal(result.status, status, JSON.stringify(result.body)); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before); }

test('all six global controls save independently; all unchecked explicitly means Off and preserves source overrides', () => {
    let config = seed(); config.securitySimulation.perSource = { 'ho-b': { clientAssertionReplay: false } }; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    for (const name of SIMULATION_CONTROLS) { const body = form(read()); body[`control.${name}`] = 'false'; assert.equal(submit(body).status, 200); assert.equal(read().securitySimulation.global[name], false); }
    const body = form(read()); for (const name of SIMULATION_CONTROLS) delete body[`control.${name}`]; assert.equal(submit(body).status, 200); assert.ok(Object.values(read().securitySimulation.global).every(value => value === false));
    assert.deepEqual(read().securitySimulation.perSource, config.securitySimulation.perSource);
    assert.ok(Object.entries(buildEffectivePolicy(read()).simulation.controls).filter(([name]) => !SIMULATION_CONTROLS.includes(name)).every(([, value]) => value === true));
});
test('exact dynamic registered IDs resolve policy aliases; source explicit On/Off/Inherit preserves other sources', () => {
    const custom = require('../src/data-sources').toConfigDataSource({ id: 'custom-0042', name: 'Same name', endpoint: 'https://custom.test/fhir', clientId: 'pcm-custom-0042', enabled: true }); custom.pcmClientAuth.certThumbprint = 'A'.repeat(43);
    const config = seed('connectathon-balanced', { organizations: { dataSources: [custom] } });
    const managed = config.healthOrganizations[0].dataSourceOrganization.id;
    for (const id of [managed, 'custom-0042', config.organizations.referenceDataSource.id]) {
        const body = form(read(), id); for (const [index, name] of SIMULATION_CONTROLS.entries()) body[`control.${name}`] = index % 2 ? 'true' : 'false';
        const result = submit(body); assert.equal(result.status, 200, JSON.stringify(result)); const key = model.sources(read()).find(source => source.id === id).policyId;
        assert.deepEqual(read().securitySimulation.perSource[key], Object.fromEntries(SIMULATION_CONTROLS.map((name, i) => [name, Boolean(i % 2)])));
    }
    const before = structuredClone(read().securitySimulation.perSource); assert.equal(submit(form(read(), managed)).status, 200); delete before['ho-a']; assert.deepEqual(read().securitySimulation.perSource, before);
    unchanged(form(read(), 'Same name'), 404); unchanged(form(read(), 'removed-id'), 404);
});
test('closed forms reject retired, invalid, missing source values and stale revisions before mutation', () => {
    const config = seed();
    for (const body of [{ ...form(config), expectedRevision: '-1' }, { ...form(config), 'control.tokenExpiry': 'false' }, { ...form(config), 'control.clientAssertionAudience': 'sometimes' }, { ...form(config), perSourceJson: '{}' }, ...[false, null, {}, undefined].map(sourceId => ({ ...form(config), sourceId })), { ...form(config), grantFullClinicalAccess: true }, { ...form(config, config.healthOrganizations[0].dataSourceOrganization.id), 'control.publicClientMtls': undefined }]) unchanged(body, body.expectedRevision === '-1' ? 409 : 400);
});
test('preset replacement requires reviewed reset; resets all source overrides and preserves lifetime/capability/authority owners', () => {
    const config = seed('connectathon-balanced', { security: { pcmApi: { accessTokenExpiresInSeconds: 17, allowServiceProviderOwnTokenIntrospection: false } }, securitySimulation: { perSource: { 'ho-a': { clientAssertionReplay: false } } } });
    unchanged({ ...form(config), preset: 'connectathon-easy' });
    const body = form(config); body.preset = 'connectathon-easy'; body.resetDefaults = 'true'; for (const name of SIMULATION_CONTROLS) delete body[`control.${name}`];
    assert.equal(submit(body).status, 200); assert.deepEqual(read().securitySimulation.perSource, {}); assert.ok(Object.values(read().securitySimulation.global).every(value => value === false));
    assert.equal(read().security.pcmApi.accessTokenExpiresInSeconds, 17); assert.equal(read().security.pcmApi.allowServiceProviderOwnTokenIntrospection, false); assert.deepEqual(read().contract, config.contract); assert.deepEqual(read().organizations, config.organizations);
});
test('strict locks every global and source check; mode transitions reject before write/revision', () => {
    for (const preset of PRESETS) {
        const config = seed(preset), target = preset === 'strict' ? 'connectathon-easy' : 'strict'; unchanged({ ...form(config), preset: target, resetDefaults: 'true' }, 409);
        if (preset === 'strict') for (const name of SIMULATION_CONTROLS) { unchanged({ ...form(config), [`control.${name}`]: 'false' }); unchanged({ ...form(config, config.healthOrganizations[0].dataSourceOrganization.id), [`control.${name}`]: 'true' }); }
    }
});
test('bounded duration validates positive integers and test/production maxima without editing environment or other fields', () => {
    for (const [environment, maximum] of [['production', 30], ['test', 86400]]) {
        seed('connectathon-balanced', { contract: { environment } }); const route = '/admin/config/security';
        const body = () => ({ adminForm: 'token-duration', expectedRevision: String(read().runtime.revision || 0), accessTokenExpiresInSeconds: '1' });
        for (const invalid of ['0', '-1', '1.2', '1e1', '', 'NaN', String(maximum + 1), '9007199254740992', false, null, [], {}, 0, -1, 1.5]) unchanged({ ...body(), accessTokenExpiresInSeconds: invalid }, 400, route);
        unchanged({ ...body(), environment: 'test' }, 400, route); unchanged({ ...body(), introspectionReturnsExpiredTokens: 'true' }, 400, route); unchanged({ ...body(), expectedRevision: '-1' }, 409, route);
        for (const value of [1, maximum, 17]) { const prior = read(); assert.equal(submit({ ...body(), accessTokenExpiresInSeconds: value === 17 ? value : String(value) }, route).status, 200); const next = read(); assert.equal(next.security.pcmApi.accessTokenExpiresInSeconds, value); assert.deepEqual(next.securitySimulation, prior.securitySimulation); assert.deepEqual(next.contract, prior.contract); assert.equal(require('../src/team-config').getEffectiveConformancePolicy().token.accessTokenExpiresInSeconds, value); }
    }
});
test('duration publication affects future real issuance only, capped by earlier authority; existing grants and first-use clocks remain', t => {
    const f = require('../../../test-support/pcm-042-grants').grantHarness('connectathon-balanced', { mode: 'one-time' }); t.after(f.close);
    // Real grant harness supplies registered actor authentication; authority/token repositories remain real.
    f.config.security.pcmApi.accessTokenExpiresInSeconds = 7; const issued = f.issue(); assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const old = structuredClone(f.tokenStore.get(issued.body.access_token)), approval = structuredClone(f.store.privateRecords.approvals.getDecision(f.consent.id));
    assert.equal(f.windows.size, 0, 'issuance does not start the first-use clock');
    assert.equal(f.inspect(issued.body.access_token).body.active, true);
    const firstUseBefore = structuredClone([...f.windows.entries()]); assert.equal(firstUseBefore.length, 1);
    seed('connectathon-balanced', { security: { pcmApi: { accessTokenExpiresInSeconds: 7 } } });
    assert.equal(submit({ adminForm: 'token-duration', expectedRevision: String(read().runtime.revision || 0), accessTokenExpiresInSeconds: '3' }, '/admin/config/security').status, 200);
    f.config.security.pcmApi.accessTokenExpiresInSeconds = require('../src/team-config').getEffectiveConformancePolicy().token.accessTokenExpiresInSeconds;
    assert.equal(f.issue().body.expires_in, 3); assert.deepEqual(f.tokenStore.get(issued.body.access_token), old); assert.equal(f.inspect(issued.body.access_token).body.active, true); assert.deepEqual(f.store.privateRecords.approvals.getDecision(f.consent.id), approval);
    assert.deepEqual([...f.windows.entries()], firstUseBefore);
    const policy = f.store.get('Contract', 'policy-presence'); policy.applies.end = new Date((require('../../../test-support/data-grants').NOW + 2) * 1000).toISOString(); f.store.update(policy);
    assert.equal(f.issue('presence-check').body.expires_in, 2);
});
test('readable rendered controls bind current source policy and trust links, no JSON or invariant pseudo-editors', () => {
    const config = seed(); const id = config.healthOrganizations[0].dataSourceOrganization.id;
    for (const query of [{ section: 'security' }, { section: 'security', source: id }]) {
        const html = router._test.renderAdminHtml({ query }); for (const name of SIMULATION_CONTROLS) { assert.ok(html.includes(model.LABELS[name])); assert.ok(html.includes(`data-help-key="simulation.${name}"`)); }
        assert.doesNotMatch(html, /name="perSourceJson"|Save security<|name="dsFhirServerEnforceMappedPatients"|name="pcmApiClientAuth"/);
        assert.match(html, /Saved .*Effective/); assert.match(html, /Always required/);
    }
    assert.match(router._test.renderAdminHtml({ query: { section: 'security', source: id } }), /view=trust/);
    assert.doesNotMatch(router._test.renderAdminHtml({ query: { section: 'security', source: 'removed-id' } }), /data-simulation-form/);
});

test('Sandbox capability keeps accepted defaults/Strict lock and rejects stale form publication', () => {
    for (const preset of PRESETS) {
        const config = seed(preset), route = '/admin/config/own-token-introspection';
        const body = { adminForm: 'own-token-capability', expectedRevision: String(config.runtime.revision || 0), allowServiceProviderOwnTokenIntrospection: 'true' };
        unchanged({ ...body, expectedRevision: '-1' }, 409, route);
        if (preset === 'strict') unchanged(body, 400, route);
        else { assert.equal(submit(body, route).status, 200); assert.equal(read().security.pcmApi.allowServiceProviderOwnTokenIntrospection, true); }
        const restore = { ...body, expectedRevision: String(read().runtime.revision || 0), allowServiceProviderOwnTokenIntrospection: 'default' };
        assert.equal(submit(restore, route).status, 200); assert.equal(require('../../shared/conformance-policy').serviceProviderOwnTokenIntrospection(read()).enabled, preset !== 'strict');
    }
});

test('forged Strict drafts cannot make locked controls appear Off after rejection', () => {
    seed('strict');
    const html=router._test.renderAdminHtml({path:'/admin/config/simulation',query:{section:'security'},body:{adminForm:'simulation',sourceId:'','control.publicClientMtls':'false'}},{adminError:{message:'Strict controls are fixed',statusCode:400}});
    assert.match(html,/<input type="checkbox" id="simulation-publicClientMtls"[^>]*checked[^>]*disabled/);
});

test('a registered prototype-name source inherits actual global policy and can explicitly override then inherit again', () => {
    const source=require('../src/data-sources').toConfigDataSource({id:'constructor',name:'Exact dynamic identity',endpoint:'https://constructor-source.test/fhir',clientId:'pcm-constructor-source',enabled:true});source.pcmClientAuth.certThumbprint='A'.repeat(43);
    const config=seed('connectathon-easy',{organizations:{dataSources:[source]}});
    const selected=require('../src/source-policy').sourceControls(null,buildEffectivePolicy(config),config,{clientId:source.clientId});
    assert.equal(selected.clientAssertionAudience,false);
    assert.equal(require('../../shared/conformance-policy').sourceSimulationControls(buildEffectivePolicy(config),config,{resource:source.endpoint}).clientAssertionAudience,false);
    const html=router._test.renderAdminHtml({query:{section:'security',source:source.id}});assert.match(html,/Saved Inherit · Effective Off · Inherited global value/);
    const body=form(config,source.id);body['control.clientAssertionAudience']='true';assert.equal(submit(body).status,200);assert.equal(buildEffectivePolicy(read()).simulation.perSource.constructor.clientAssertionAudience,true);
    assert.equal(submit(form(read(),source.id)).status,200);assert.equal(require('../src/source-policy').sourceControls(null,buildEffectivePolicy(read()),read(),{clientId:source.clientId}).clientAssertionAudience,false);
});
