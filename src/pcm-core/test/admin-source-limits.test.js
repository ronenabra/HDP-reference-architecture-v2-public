'use strict';
/** Exact budget edits, safe publication and selected-source rendered contracts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
const baseline = installTestRuntime();
const configFile = process.env.TEAM_CONFIG_PATH;
const model = require('../src/admin-source-limits');
const router = require('../src/routes/ui');
const { DataOperationRegistry } = require('../src/data-operations');
const current = () => JSON.parse(fs.readFileSync(configFile));
test.afterEach(() => fs.writeFileSync(configFile, JSON.stringify(baseline)));

/** Build the actual unit-labelled body from existing raw configured budgets. */
function body(config, id) {
    const rows = model.limitRows(config, id ? { id } : null);
    return Object.fromEntries([['expectedRevision', String(config.runtime.revision || 0)], ...rows.flatMap(row => [[row.key, row.value], ...(id ? [[`mode.${row.key}`, row.custom ? 'custom' : 'inherit']] : [])])]);
}
/** Execute the real protected mutation handler with bounded response capture. */
function command(route, input, params = {}, html = false) {
    const handler = router.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
    const req = { path: route.replace(':id', params.id || '').replace(':serverId', params.serverId || ''), body: input, params,
        query: { section: 'sources', source: baseline.healthOrganizations[1].dataSourceOrganization.id, view: 'registration' }, get: () => html ? 'text/html' : 'application/json' };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; }, send(value) { this.value = value; return this; }, redirect(code, url) { this.code = code; this.url = url; }, format(types) { return types[html ? 'html' : 'json'](); } };
    handler(req, res); return res;
}
const sourceRoute = '/admin/config/data-sources/:id/limits';
const defaultsRoute = '/admin/config/presence-limits';
const uploadRoute = '/admin/config/fhir-servers/:serverId/limits';

test('exact decimal units round-trip boundaries and reject nonfinite, precision and off-by-one values', () => {
    for (const field of [...model.FIELDS, ...model.UPLOAD_FIELDS]) {
        for (const raw of [field.minimum, field.maximum]) assert.equal(model.parseValue(model.displayValue(raw, field.scale), field), raw);
        for (const raw of [field.minimum - 1, field.maximum + 1]) assert.throws(() => model.parseValue(String(raw / field.scale), field));
        for (const invalid of ['', 'NaN', 'Infinity', '-1', '1e3', ' 1', '1,000', '0.0000001', '0.0001x', {}, ['1']]) assert.throws(() => model.parseValue(invalid, field));
    }
    assert.equal(model.parseValue('27.465318', model.UPLOAD_FIELDS[0]), 27465318);
    assert.equal(model.parseValue('0.001', model.FIELDS[2]), 1);
});

test('source set/inherit removes only owned overrides and saves preserve all four presets', () => {
    for (const preset of ['strict','connectathon-mtls','connectathon-balanced','connectathon-easy']) {
        const config = buildTeamConfig({}, preset); config.runtime = baseline.runtime;
        config.presence.sources = { 'ho-b': { maxPatients: 4 }, 'legacy': { maxPatients: 3 } };
        fs.writeFileSync(configFile, JSON.stringify(config));
        const id = config.healthOrganizations[0].dataSourceOrganization.id, draft = body(config, id);
        draft['mode.maxPatients'] = 'custom'; draft.maxPatients = '105';
        const saved = command(sourceRoute, draft, { id }); assert.equal(saved.code, 200, JSON.stringify(saved.value));
        let next = current(); assert.equal(next.presence.sources['ho-a'].maxPatients, 105);
        assert.deepEqual(next.presence.sources['ho-b'], { maxPatients: 4 }); assert.deepEqual(next.presence.sources.legacy, { maxPatients: 3 });
        assert.deepEqual(next.security, config.security); assert.deepEqual(next.securitySimulation, config.securitySimulation); assert.deepEqual(next.conformance, config.conformance);
        const inherited = body(next, id); inherited['mode.maxPatients'] = 'inherit';
        assert.equal(command(sourceRoute, inherited, { id }).code, 200); next = current(); assert.equal(next.presence.sources['ho-a'], undefined);
        assert.deepEqual(next.presence.sources['ho-b'], { maxPatients: 4 });
    }
});

test('shared defaults preserve every source override; legacy UI identity saves the budget alias', () => {
    const config = current(); config.presence.sources = { 'ho-a': { maxPatients: 105 }, legacy: { maxPatients: 8 } }; fs.writeFileSync(configFile, JSON.stringify(config));
    const defaults = body(config); defaults.maxPatients = '99'; assert.equal(command(defaultsRoute, defaults).code, 200);
    assert.deepEqual(current().presence.sources, config.presence.sources);
    const legacy = require('../src/data-sources').getConfiguredDataSources(current(), { includeDisabled: true }).find(source => source.compatibilityOnly);
    const input = body(current(), legacy.id); input['mode.maxPatients'] = 'custom'; input.maxPatients = '9';
    assert.equal(command(sourceRoute, input, { id: legacy.id }).code, 200); assert.equal(current().presence.sources.legacy.maxPatients, 9); assert.equal(current().presence.sources['legacy-ds'], undefined);
});

test('invalid, unknown, removed and stale edits preserve config bytes/revision and exact safe drafts', () => {
    const before = fs.readFileSync(configFile); const id = baseline.healthOrganizations[0].dataSourceOrganization.id;
    for (const [input, params, status] of [[{ ...body(current(), id), expectedRevision: '-1' }, {id}, 409],
        [{ ...body(current(), id), 'mode.maxPatients': 'custom', maxPatients: '1' }, {id}, 400],
        [{ ...body(current(), id), malicious: 'x' }, {id}, 400], [body(current(), id), {id:'removed-exact'}, 404]]) {
        const res = command(sourceRoute, input, params, true); assert.equal(res.code, status, String(res.value).slice(0,200));
        assert.deepEqual(fs.readFileSync(configFile), before);
        if (status === 404) assert.doesNotMatch(res.value, /data-source-workspace=/);
        else { assert.match(res.value, new RegExp(`data-source-workspace="${id}"`)); assert.match(res.value, /Save source limits/); }
    }
    assert.equal(command(defaultsRoute, {...body(current()), 'mode.maxPatients':'custom'}).code,400); assert.deepEqual(fs.readFileSync(configFile),before);
    const defaultFailure = command(defaultsRoute, { ...body(current()), maxPatients:'1' }, {}, true);
    assert.equal(defaultFailure.code, 400); assert.match(defaultFailure.value, /value="1"/); assert.match(defaultFailure.value, /aria-invalid="true" aria-errormessage="admin-error-summary"/); assert.match(defaultFailure.value, /Save default limits/);
});

test('managed upload edit uses canonical bounds and refuses active/uncertain captured contracts', () => {
    const registry = new DataOperationRegistry(); const original = current(); const ho = original.healthOrganizations[0];
    const upload = { expectedRevision: String(original.runtime.revision || 0), maxBytes:'27.465318', maxEntries:'7155' };
    assert.equal(command(uploadRoute, { ...upload, maxBytes:'27.465317' }, {serverId:ho.clinicalData.serverId}).code, 400);
    assert.equal(command(uploadRoute, upload, {serverId:'custom-external'}).code, 404);
    const operation = registry.create(ho.clinicalData.serverId, 'import', {targetIdentity:JSON.stringify(ho), limits:structuredClone(ho.clinicalData.limits)});
    try {
        for (const uncertain of [false,true]) {
            if (uncertain) registry.transition(operation.id, 'failed', { mutationSubmitted:true, needsReconciliation:true });
            const before = fs.readFileSync(configFile), captured = fs.readFileSync(registry.file(operation.id));
            assert.equal(command(uploadRoute, upload, {serverId:ho.clinicalData.serverId}).code, 409);
            assert.deepEqual(fs.readFileSync(configFile), before); assert.deepEqual(fs.readFileSync(registry.file(operation.id)), captured);
        }
    } finally { fs.rmSync(registry.directory, {recursive:true,force:true}); }
    assert.equal(command(uploadRoute, upload, {serverId:ho.clinicalData.serverId}).code, 200);
    const next = current(); assert.deepEqual(next.healthOrganizations[0].clinicalData.limits, {maxBytes:27465318,maxEntries:7155});
    assert.deepEqual(next.healthOrganizations.slice(1), original.healthOrganizations.slice(1)); assert.deepEqual(next.presence, original.presence);
});

test('selected/default editor renders saved effective origins, exact units and honest adoption without writes', () => {
    const config = current(), id = config.healthOrganizations[0].dataSourceOrganization.id;
    const before = fs.readFileSync(configFile);
    const render = source => router._test.renderAdminHtml({ query:{section:'sources',source,view:source?'limits':'defaults'} });
    const html = render(id); for (const field of model.FIELDS) assert.ok(html.includes(`data-help-key="admin.limit-${field.key}"`)); assert.match(html, /Saved (?:effective|value)/); assert.match(html, /Shared default/); assert.match(html, /Managed (?:upload limits|source imports)/); assert.match(html, /supporting services are installed/);
    assert.match(html, /name="mode.maxPayloadBytes"/); assert.match(html, /1 MB = 1,000,000 bytes/); assert.match(render(''), /Save default limits/);
    const legacy = require('../src/data-sources').getConfiguredDataSources(config, {includeDisabled:true}).find(s=>s.compatibilityOnly);
    assert.doesNotMatch(render(legacy.id), /Save upload limits/); assert.deepEqual(fs.readFileSync(configFile), before);
});

test('registered custom source has independent budgets and removal never falls back to a managed source', () => {
    const config=current();
    const source=require('../src/data-sources').toConfigDataSource({id:'org-limits-independent',name:'Independent',endpoint:'https://independent.test/fhir'});
    source.pcmClientAuth.certThumbprint='A'.repeat(43);config.organizations.dataSources.push(source);fs.writeFileSync(configFile,JSON.stringify(config));
    const input=body(config,source.id);input['mode.maxPayloadBytes']='custom';input.maxPayloadBytes='2.000001';
    assert.equal(command(sourceRoute,input,{id:source.id}).code,200);assert.equal(current().presence.sources[source.id].maxPayloadBytes,2000001);
    assert.deepEqual(current().healthOrganizations,config.healthOrganizations);
    const next=current();next.organizations.dataSources=[];delete next.presence.sources[source.id];fs.writeFileSync(configFile,JSON.stringify(next));
    const before=fs.readFileSync(configFile);assert.equal(command(sourceRoute,{...input,expectedRevision:String(next.runtime.revision)},{id:source.id}).code,404);assert.deepEqual(fs.readFileSync(configFile),before);
});


test('registered prototype-name identity creates its own source row without mutating shared prototypes', () => {
    const config=current();const source=require('../src/data-sources').toConfigDataSource({id:'constructor',name:'Exact constructor source',endpoint:'https://constructor.test/fhir'});
    source.pcmClientAuth.certThumbprint='A'.repeat(43);config.organizations.dataSources.push(source);fs.writeFileSync(configFile,JSON.stringify(config));
    const input=body(config,source.id);input['mode.maxPatients']='custom';input.maxPatients='7';
    assert.equal(command(sourceRoute,input,{id:source.id}).code,200);
    assert.equal(Object.hasOwn(current().presence.sources,'constructor'),true);assert.deepEqual(current().presence.sources.constructor,{maxPatients:7});
    assert.equal(Object.maxPatients,undefined);assert.equal(Object.prototype.maxPatients,undefined);
});

/** Build the independent clinical form with exact raw integer units. */
function queryBody(config, id) {
    return Object.fromEntries([['expectedRevision', String(config.runtime.revision || 0)], ...model.queryRows(config, id ? {id} : null).flatMap(row => [[row.key, row.value], ...(id ? [[`mode.${row.key}`, row.custom ? 'custom' : 'inherit']] : [])])]);
}
const queryRoute = '/admin/config/data-sources/:id/clinical-query-limits';
const queryDefaultsRoute = '/admin/config/clinical-query-limits';
test('clinical query defaults, source isolation, inherit and stable security revision use the real publication owner', () => {
    const { DEFAULTS, MINIMA, MAXIMA, clinicalQueryLimits } = require('../../shared/clinical-query-limits');
    const config = current(), id = config.healthOrganizations[0].dataSourceOrganization.id;
    assert.deepEqual(clinicalQueryLimits(config), DEFAULTS);
    for (const field of model.QUERY_FIELDS) {
        assert.equal(model.parseValue(String(MINIMA[field.key]), field), MINIMA[field.key]);
        assert.equal(model.parseValue(String(MAXIMA[field.key]), field), MAXIMA[field.key]);
        for (const invalid of [String(MINIMA[field.key] - 1), String(MAXIMA[field.key] + 1), '1.1', 'NaN']) assert.throws(() => model.parseValue(invalid, field));
    }
    const schema = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname,'../../../pcm-connectathon/team-config.schema.json'))).$defs.clinicalQueryLimits.properties;
    const java = fs.readFileSync(require('node:path').resolve(__dirname,'../../ho-fhir-server/src/main/java/org/hl7/hdp/pcm/hapi/PcmQueryLimits.java'),'utf8');
    for (const field of model.QUERY_FIELDS) {
        assert.equal(schema[field.key].minimum, field.minimum); assert.equal(schema[field.key].maximum, field.maximum);
        assert.ok(java.includes(`java.util.Map.entry("${field.key}", new long[]{${field.minimum}L, ${field.maximum}L})`));
    }
    const shared = queryBody(config); shared.maxPageIdVisits = '6';
    assert.equal(command(queryDefaultsRoute, shared).code, 200);
    assert.equal(current().runtime.revision - current().runtime.queryLimitsRevisionOffset, config.runtime.revision || 0);
    const source = queryBody(current(), id); source['mode.maxPageIdVisits'] = 'custom'; source.maxPageIdVisits = '3';
    assert.equal(command(queryRoute, source, {id}).code, 200);
    assert.equal(clinicalQueryLimits(current(), {id:'ho-a'}).maxPageIdVisits, 3);
    assert.equal(clinicalQueryLimits(current(), {id:'ho-b'}).maxPageIdVisits, 6);
    assert.deepEqual(current().presence, config.presence);
    assert.deepEqual(current().healthOrganizations, config.healthOrganizations);
    assert.equal(command(queryRoute, queryBody(current(), id), {id}).code, 200);
    const inherit = queryBody(current(), id); inherit['mode.maxPageIdVisits'] = 'inherit';
    assert.equal(command(queryRoute, inherit, {id}).code, 200);
    assert.equal(current().clinicalQuery.sources['ho-a'], undefined);
    const candidate = current(); require('../src/team-config').markRuntimeChange(candidate, 'security');
    assert.equal(candidate.runtime.revision - candidate.runtime.queryLimitsRevisionOffset, (current().runtime.revision - current().runtime.queryLimitsRevisionOffset) + 1);
});

test('clinical invalid/stale/unknown forms preserve bytes and safe drafts; actual renderer separates applicability', () => {
    const config = current(), id = config.healthOrganizations[0].dataSourceOrganization.id;
    const before = fs.readFileSync(configFile);
    for (const [input, status] of [[{...queryBody(config,id),expectedRevision:'-1'},409],
        [{...queryBody(config,id),'mode.maxPageIdVisits':'custom',maxPageIdVisits:'1.1'},400],
        [{...queryBody(config,id),maxPatients:'999'},400]]) {
        const result = command(queryRoute,input,{id},true);
        assert.equal(result.code,status,String(result.value).slice(0,200));
        assert.match(result.value, /data-clinical-query-form/);
        if (input.maxPageIdVisits === '1.1') assert.match(result.value,/id="query-maxPageIdVisits"[^>]*value="1.1"/);
        assert.deepEqual(fs.readFileSync(configFile),before);
    }
    const { clinicalQueryLimits } = require('../../shared/clinical-query-limits');
    for (const block of [{sources:{unknown:{}}},{defaults:{unknown:1}},{defaults:{maxPageIdVisits:1.1}},{sources:null}]) assert.throws(()=>clinicalQueryLimits({...config,clinicalQuery:block}));
    const html = router._test.renderAdminHtml({query:{section:'sources',source:id,view:'limits'}});
    assert.match(html,/Clinical query processing/); assert.match(html,/Request &amp; processing limits/);
    for (const field of model.QUERY_FIELDS) assert.ok(html.includes(`id="query-${field.key}"`));
    const legacy = require('../src/data-sources').getConfiguredDataSources(config,{includeDisabled:true}).find(s=>s.compatibilityOnly);
    const legacyHtml = router._test.renderAdminHtml({query:{section:'sources',source:legacy.id,view:'limits'}});
    assert.match(legacyHtml,/no supported local HAPI query worker/); assert.doesNotMatch(legacyHtml,/data-clinical-query-form/);
    assert.equal(command(queryRoute,queryBody(config,id),{id:legacy.id}).code,400);
    assert.deepEqual(fs.readFileSync(configFile),before);
});


/** A populated graph must retain its exact authority when only operational budgets change. */
test('clinical saves preserve the raw config and an initialized graph without source synchronization', () => {
    const store = require('../src/fhir/store');
    const previous = require('../src/migration-checkpoint').snapshot(store,{privateState:true});
    try {
        require('../src/bootstrap').synchronous();
        const config = current(); delete config.identityMapping; fs.writeFileSync(configFile,JSON.stringify(config));
        const before = require('../src/migration-checkpoint').snapshot(store,{privateState:true});
        const id = config.healthOrganizations[0].dataSourceOrganization.id, input = queryBody(config,id);
        input['mode.maxPagePayloadBytes']='custom';input.maxPagePayloadBytes='1';
        const result = command(queryRoute,input,{id});assert.equal(result.code,200,JSON.stringify(result.value));
        assert.equal(Object.hasOwn(current(),'identityMapping'),false);
        assert.deepEqual(require('../src/migration-checkpoint').snapshot(store,{privateState:true}),before);
        assert.deepEqual(current().healthOrganizations,config.healthOrganizations);
    } finally {
        // The fixture owns this graph; restore only its prior isolated state between tests.
        require('../src/migration-checkpoint').hydrate(store,previous,{rollback:true});
    }
});
