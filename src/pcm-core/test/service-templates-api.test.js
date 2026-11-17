'use strict';
/** Real ordinary provider OAuth/mTLS/FHIR creation, persistence, activation, Consent, token and introspection. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const { loadTemplates } = require('../src/service-templates');
const { csrf } = require('../src/sandbox-service-command');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { requestJson } = require('../src/system-workflow-client');
const { createClientAssertion, buildTokenForm } = require('../../sp-client/src/oauth');
const { environmentEndpoints } = require('../../shared/pcm-environment');
const { certificateConfirmation } = require('../../shared/assertion-keys');
function credentials(f, role) {
    const { certPath } = require('../src/team-config');
    return { ca: fs.readFileSync(path.join(process.env.CERTS_DIR, 'rootCA.crt')), cert: fs.readFileSync(certPath(f.config, role, 'cert', 'mtls')), key: fs.readFileSync(certPath(f.config, role, 'key', 'mtls')), rejectUnauthorized: true };
}
function assertion(clientId, key, cert, audience) { return createClientAssertion({ clientId, privateKey: fs.readFileSync(key), audience, cnfThumbprint: certificateConfirmation(cert)['x5t#S256'] }); }
test('all templates create/read through ordinary ownership, remain pending, compile real grants and preserve separate provider assignment', async t => {
    const f = await startServicesFixture(); t.after(() => f.close());
    const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
    const post = (route, body, additional = {}) => fetch(`${f.base}/admin/services${route}`, { method: 'POST', headers: { ...headers, ...additional }, body: JSON.stringify(body) });
    const add = (key, providerRole = 'serviceProvider') => post('/templates', { providerRole, csrf: csrf(providerRole), templateKey: key });
    const change = (id, action) => { const version = f.store.get('HealthcareService', id).meta.versionId; return post(`/${id}/sandbox`, { action, expectedVersion: version, csrf: csrf('', id, version) }); };
    const endpoints = environmentEndpoints(f.config.contract.environment), tls = credentials(f, 'serviceProvider');
    const { certPath } = require('../src/team-config');
    const signed = audience => assertion(f.config.organizations.serviceProvider.clientId, certPath(f.config, 'serviceProvider', 'key', 'assertion'), tls.cert, audience);
    const send = (suffix, options = {}) => requestJson(f.config.internalBaseUrls.pcmFhir + suffix, { tls, timeoutMilliseconds: 10000, acceptedStatuses: [200, 201], ...options });
    const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const management = await send('/token', form(buildTokenForm({ grantType: 'client_credentials', assertion: signed(endpoints.tokenEndpoint), scope: 'system/*.crus', resource: endpoints.fhirBase })));
    const ordinary = await require('../src/provider-management-client').providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
    const original = f.store.getAll('HealthcareService');
    let first;
    for (const template of loadTemplates()) {
        const response = await add(template.key); assert.equal(response.status, 200, await response.clone().text()); const result = await response.json();
        assert.match(result.message, /^Added — waiting for activation/); assert.ok(result.businessIdentifier?.value && result.reference === `HealthcareService/${result.id}`);
        const instance = await ordinary.read(result.id), catalogId = lifecycle.basedOnId(instance); first ||= { instance, catalogId, template };
        assert.equal(lifecycle.ownerId(instance), f.config.organizations.serviceProvider.id); assert.equal(lifecycle.businessStatus(instance), 'pending');
        assert.equal(instance.identifier[0].value, result.businessIdentifier.value); assert.equal(result.canonicalReference, `HealthcareService/${catalogId}`);
        const duplicate = await add(template.key); assert.equal(duplicate.status, 200, await duplicate.clone().text()); assert.equal((await duplicate.json()).alreadyAdded, true);
        assert.equal((await change(catalogId, 'activate')).status, 200); assert.equal((await change(instance.id, 'activate')).status, 200);
        const canonical = await ordinary.read(catalogId);
        assert.deepEqual(canonical.extension.filter(item => item.url === EXTENSIONS.exampleQuery).map(item => item.valueString), template.request.extension.filter(item => item.url === EXTENSIONS.exampleQuery).map(item => item.valueString));
        assert.equal(f.store.privateRecords.services.getDefinition(canonical.id).options[0].extension.find(item => item.url === 'scope').valueString, template.scope);
        const submit = require('../../sp-client/src/fhir-builders').buildConsentSubmit({ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }, instance.id, require('../../shared/identity-mapping').sandboxIdentityOptions(f.config));
        const consent = await send('/Consent', { method: 'POST', body: submit, headers: { Authorization: `Bearer ${management.access_token}`, 'Content-Type': 'application/fhir+json' } });
        assert.equal(consent.status, 'active');
        // Exercise the saved option exactly; HTEST automatic approval is explicitly separate from person OTP.
        const savedScope = f.store.privateRecords.services.getDefinition(canonical.id).grant.scope;
        assert.equal(f.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope, savedScope);
        // OAuth's integer-second clock must be within the just-approved millisecond period.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.ceil(Date.parse(consent.provision.period.start) / 1000) * 1000 - Date.now()) + 5));
        assert.equal(lifecycle.serviceIsOperational(f.store, f.store.get('HealthcareService', instance.id)), true);
        assert.equal(require('../src/fhir/consent-lifecycle').consentIsActive(f.store.get('Consent', consent.id), Math.floor(Date.now() / 1000)), true);
        const source = f.config.healthOrganizations[0];
        const token = await send('/token', form(buildTokenForm({ grantType: 'client_credentials', assertion: signed(endpoints.tokenEndpoint), scope: require('../../shared/service-grant').inspectScope(savedScope).requestCeiling, resource: source.endpoint,
            authorizationDetails: require('../../shared/data-authorization-details').consentAuthorizationDetails(consent) })));
        assert.ok(token.access_token); assert.ok(!token.scope.includes('[')); assert.equal(token.scope, savedScope); assert.doesNotMatch(token.scope, /identifier=|patient=/);
        for (const clinical of token.scope.split(' ').slice(1)) assert.ok(clinical.includes('_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V'));
        const cert = fs.readFileSync(path.join(process.env.CERTS_DIR, source.certificates.gatewayMtlsCert)), key = fs.readFileSync(path.join(process.env.CERTS_DIR, source.certificates.gatewayMtlsKey));
        const proof = assertion(source.clientId, path.join(process.env.CERTS_DIR, source.certificates.gatewayAssertionKey), cert, endpoints.introspectionEndpoint);
        const active = await requestJson(f.config.internalBaseUrls.pcmFhir + '/introspect', { ...form(new URLSearchParams({ token: token.access_token, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: proof })), tls: { ...tls, cert, key }, timeoutMilliseconds: 10000 });
        assert.equal(active.active, true); assert.equal(active.scope, token.scope);
    }
    for (const service of original) assert.deepEqual(f.store.get('HealthcareService', service.id), service, 'seed/previous service preserved');
    const other = await add(first.template.key, 'hospitalBServiceProvider'); assert.equal(other.status, 200, await other.clone().text()); const registration = await other.json();
    assert.notEqual(registration.id, first.instance.id); assert.equal(registration.canonicalReference, `HealthcareService/${first.catalogId}`);
    assert.equal(lifecycle.ownerId(f.store.get('HealthcareService', registration.id)), f.config.organizations.hospitalBServiceProvider.id);
    const repeat = await add(first.template.key, 'hospitalBServiceProvider'); assert.equal((await repeat.json()).alreadyAdded, true);
    assert.ok(f.requests.some(request => request.method === 'POST' && request.path.endsWith('/HealthcareService') && request.organization === f.config.organizations.hospitalBServiceProvider.id && request.certificate));
    assert.equal((await post('/templates', { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), templateKey: first.template.key, owner: 'forged' })).status, 400);
    assert.equal((await post('/templates', { providerRole: 'serviceProvider', csrf: 'forged', templateKey: first.template.key })).status, 403);
    assert.equal((await add('unknown-template')).status, 400);
});

test('template failures, stale definition, unknown ownership and concurrent adds do not mutate existing services', async t => {
    const f = await startServicesFixture(); t.after(() => f.close());
    const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
    const post = (route, body, extra = {}) => fetch(`${f.base}/admin/services${route}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const add = (key, role = 'serviceProvider') => post('/templates', { providerRole: role, csrf: csrf(role), templateKey: key });
    const first = loadTemplates()[0], baseline = f.store.getAll('HealthcareService');
    assert.equal((await post('/templates', { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), templateKey: first.key }, { 'x-admin-password': '' })).status, 401);
    assert.equal((await post('/templates', { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), templateKey: first.key }, { Origin: 'https://foreign.test' })).status, 403);
    assert.equal((await add(first.key, 'pcm')).status, 400);
    const key = require('../src/team-config').certPath(f.config, 'hospitalBServiceProvider', 'key', 'assertion'), original = fs.readFileSync(key);
    try { fs.unlinkSync(key); assert.equal((await add(first.key, 'hospitalBServiceProvider')).status, 503); }
    finally { fs.writeFileSync(key, original, { mode: 0o600 }); }
    assert.deepEqual(f.store.getAll('HealthcareService'), baseline);
    const create = await post('/create', { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), definition: { ...first.definition, purpose: 'Different retained purpose' } }); assert.equal(create.status, 200);
    const beforeConflict = f.store.getAll('HealthcareService'); const conflict = await add(first.key); assert.equal(conflict.status, 409); assert.match((await conflict.json()).error, /different definition/); assert.deepEqual(f.store.getAll('HealthcareService'), beforeConflict);
    const outcomes = await Promise.all([add('diabetes-follow-up'), add('diabetes-follow-up')]);
    assert.ok(outcomes.every(response => [200, 409].includes(response.status)));
    assert.equal(f.store.getAll('HealthcareService').filter(service => service.name === 'Diabetes follow-up').length, 2, 'exactly one canonical and one owned instance');
});

test('strict template registration stays pending and cannot activate through private actions', async t => {
    const f = await startServicesFixture('strict'); t.after(() => f.close());
    const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
    const add = await fetch(`${f.base}/admin/services/templates`, { method: 'POST', headers, body: JSON.stringify({ providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), templateKey: 'laboratory-follow-up' }) });
    assert.equal(add.status, 200, await add.clone().text()); const result = await add.json(); assert.equal(result.state, 'pending');
    const before = f.store.getAll('HealthcareService'); const version = f.store.get('HealthcareService', result.id).meta.versionId;
    const action = await fetch(`${f.base}/admin/services/${result.id}/sandbox`, { method: 'POST', headers, body: JSON.stringify({ action: 'activate', expectedVersion: version, csrf: csrf('', result.id, version) }) });
    assert.equal(action.status, 403); assert.deepEqual(f.store.getAll('HealthcareService'), before);
});

/** Ordinary draft route revalidates edited content without trusting a template key. */
test('template-hinted ordinary draft create preserves edits, duplicate identity, visibility and failures', async t => {
    const f = await startServicesFixture(); t.after(() => f.close());
    const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
    const template = loadTemplates()[0];
    const definition = { ...structuredClone(template.definition), name: 'Editable ordinary template', purpose: '<script>never execute</script>', scopeOrigin: 'generated', exampleQueries: template.exampleQueries };
    const body = { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), templateKey: template.key, definition };
    const post = (value = body, extra = {}) => fetch(`${f.base}/admin/services/create`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    const baseline = f.store.getAll('HealthcareService');
    for (const invalid of [{ ...body, owner: 'forged' }, { ...body, templateKey: 'stale' }, { ...body, definition: { ...definition, id: 'forged' } }, { ...body, definition: { ...definition, exampleQueries: [{ type: 'NotSelected', query: 'x' }] } }]) assert.equal((await post(invalid)).status, 400);
    assert.equal((await post({ ...body, csrf: 'forged' })).status, 403);
    assert.equal((await post(body, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await post({ ...body, providerRole: 'pcm' })).status, 400);
    assert.deepEqual(f.store.getAll('HealthcareService'), baseline);
    const response = await post(); assert.equal(response.status, 200, await response.clone().text()); const result = await response.json(); assert.equal(result.state, 'pending');
    const ordinary = await require('../src/provider-management-client').providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
    const saved = await ordinary.read(result.id); assert.equal(saved.extraDetails, definition.purpose);
    assert.equal(saved.active, false); assert.equal(lifecycle.ownerId(saved), f.config.organizations.serviceProvider.id);
    assert.deepEqual(saved.extension.filter(item => item.url === EXTENSIONS.exampleQuery).map(item => item.valueString), template.exampleQueries.map(item => item.query));
    assert.equal(f.store.privateRecords.services.getDefinition(saved.id).options[0].extension.find(item => item.url === 'origin').valueString, 'generated');
    const writes = () => f.requests.filter(item => item.method === 'POST' && item.path.endsWith('/HealthcareService'));
    assert.equal(writes().length, 0); assert.ok(f.events.some(event => event.operation === 'service-owner-create' && event.visibility === 'diagnostic'));
    const duplicate = await post(); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).alreadyAdded, true); assert.equal(writes().length, 0);
    const beforeConflict = f.store.getAll('HealthcareService'); assert.equal((await post({ ...body, definition: { ...definition, purpose: 'Conflict' } })).status, 409); assert.deepEqual(f.store.getAll('HealthcareService'), beforeConflict);
    const renamed = await post({ ...body, definition: { ...definition, name: 'New customized name', duration: 7 } }); assert.equal(renamed.status, 200); assert.equal(writes().length, 0);
    const output = process.env.TEMPLATE_FORM_EVIDENCE; if (output) fs.writeFileSync(path.join(output, 'ordinary-draft-requests.json'), JSON.stringify({ writes: writes(), saved, result }, null, 2));
});

/** Config failures and stale defaults never change a live definition or block unhinted manual create. */
test('invalid current config disables picker, rejects hints and leaves manual creation available', async t => {
    const first = loadTemplates()[0]; let invalid = false;
    const f = await startServicesFixture('connectathon-mtls', { templateLoader: () => { if (invalid) throw new Error('owned invalid config'); return [{ ...first, definition: { ...first.definition, purpose: '<script>never execute this config text</script>' } }]; } }); t.after(() => f.close());
    const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
    const draft = { ...first.definition, name: 'Stale edited draft retained', purpose: 'Authored before config reload', scopeOrigin: 'generated', exampleQueries: first.exampleQueries };
    const post = body => fetch(`${f.base}/admin/services/create`, { method: 'POST', headers, body: JSON.stringify(body) });
    const body = { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), definition: draft, templateKey: first.key };
    const response = await post(body); assert.equal(response.status, 200); const saved = f.store.get('HealthcareService', (await response.json()).id); assert.equal(saved.extraDetails, draft.purpose, 'current defaults never replace independently validated edited content');
    const projected = await fetch(`${f.base}/admin/services`, { headers }); const safe = await projected.text(); assert.match(safe, /&lt;script&gt;never execute this config text&lt;\/script&gt;/); assert.doesNotMatch(safe, /<script>never execute this config text<\/script>/);
    invalid = true; const baseline = f.store.getAll('HealthcareService');
    const page = await fetch(`${f.base}/admin/services`, { headers }); const html = await page.text(); assert.equal(page.status, 200); assert.match(html, /Templates unavailable\. New service remains available/); assert.match(html, /data-service-blank/); assert.doesNotMatch(html, /data-service-template-pick/); assert.match(html, /data-service-create/);
    assert.equal((await post(body)).status, 503); assert.deepEqual(f.store.getAll('HealthcareService'), baseline);
    const { templateKey, ...manual } = body; manual.definition = { ...draft, name: 'Manual while templates invalid' }; assert.equal((await post(manual)).status, 200);
});
