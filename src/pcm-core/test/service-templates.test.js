'use strict';
/** Complete declarative definitions, unchanged compiler semantics and safe ordinary duplicate handling. */
const test = require('node:test'), assert = require('node:assert/strict');
const { validateTemplates, loadTemplates, addTemplate } = require('../src/service-templates');
const { historyStart } = require('../src/grant-compiler');
const { EXTENSIONS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const { SENSITIVITY_LABELS } = require('../../shared/information-buckets');
const { BUCKET_RESOURCES } = require('../../shared/clinical-resource-mapping');
const { readServiceGrant, inspectScope } = require('../../shared/service-grant');
const { serviceDefinitionDraft: serviceDefinition } = require('../src/service-definition-form');
const catalog = require('../../../config/service-templates.json');
const fixed = Date.parse('2028-05-31T12:00:00Z') / 1000;
const R = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|R';
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
/** Compile at the creation event, then read its authoritative saved text. */
function compile(template, now = fixed) { return readServiceGrant(serviceDefinition(template.definition, { now })).scope; }

test('five recipes have exactly one explicit basic R exception and complete honest query metadata', () => {
    const templates = loadTemplates(); assert.equal(templates.length, 5);
    assert.deepEqual(templates.filter(t => t.definition.confidentialityPolicy.allowRestricted).map(t => t.key), ['basic-patient-data']);
    for (const t of templates) {
        assert.equal(t.definition.category, '35');
        assert.ok(t.definition.permissions.some(p => p.type === 'Patient' && p.actions === 'rs'));
        const grant = t.privateDefinition.grant; assert.deepEqual(grant.diagnostics, { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] });
        for (const clause of inspectScope(grant.scope).clauses) {
            assert.ok(clause.filters.includes(V)); assert.equal(clause.filters.includes(R), t.key !== 'basic-patient-data');
        }
        assert.ok(!grant.scope.includes('['));
        assert.ok(t.exampleQueries.every(q => q.query.endsWith('?_count=10')));
        assert.equal(t.request.identifier, undefined); assert.equal(t.request.id, undefined); assert.equal(t.request.providedBy, undefined);
    }
    const basic = templates.find(t => t.key === 'basic-patient-data');
    assert.equal(basic.definition.scopeOrigin, 'custom'); assert.equal(basic.definition.buckets.length, 2);
    assert.equal(compile(basic), ['Patient', 'Observation', 'Condition'].map(type => `patient/${type}.rs?${V}`).join(' '));
    const expanded = structuredClone(catalog); expanded.templates.push({ ...structuredClone(expanded.templates[0]), key: 'another-laboratory', definition: { ...structuredClone(expanded.templates[0].definition), name: 'Another laboratory service' } });
    assert.equal(validateTemplates(expanded).length, 6, 'a new recipe needs no UI code');
});

test('malformed/duplicate definitions, codes, actions, unusable policy and unbounded query examples fail closed', () => {
    const mutations = [v => v.templates.push(v.templates[0]), v => v.templates[1].definition.name = v.templates[0].definition.name,
        v => v.templates[0].definition.duration = 0, v => v.templates[0].definition.category = '999', v => v.templates[0].definition.buckets[0].code = 'clinicalNotes',
        v => v.templates[0].definition.permissions[1].type = 'DocumentReference', v => v.templates[0].definition.permissions[1].type = 'Organization',
        v => v.templates[0].definition.permissions[1].type = 'Condition', v => v.templates[0].definition.permissions[1].actions = 'cruds',
        v => v.templates[0].definition.buckets[0].sensitivity = ['unknown|tag'], v => v.templates[0].definition.buckets.push(v.templates[0].definition.buckets[0]),
        v => v.templates[0].definition.active = true, v => v.templates[0].definition.permissions.push(v.templates[0].definition.permissions[0]),
        v => v.templates[0].exampleQueries.pop(), v => v.templates[0].file = '/private-path', v => v.schemaVersion = 'future',
        v => v.templates[4].definition.approvalScope = `patient/Patient.rs?${V} patient/Observation.rs`,
        v => v.templates[4].definition.confidentialityPolicy.allowRestricted = false,
        v => v.templates[4].definition.approvalScope += ` patient/Organization.s?${V}`,
        v => v.templates[4].definition.includeMasterData = true,
        v => v.templates[4].definition.approvalScope += ` patient/Organization.r?${V}`,
        v => v.templates[4].definition.approvalScope = `patient/Patient.rs?${V} patient/Condition.rs?${V}`,
        v => { v.templates[0].definition.scopeOrigin = 'custom'; v.templates[0].definition.approvalScope = `patient/Patient.rs?${R}&${V} patient/Observation.rs?_security=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|R&${R}&${V}`; }];
    for (const mutate of mutations) { const value = structuredClone(catalog); mutate(value); assert.throws(() => validateTemplates(value), /Service templates/); }
    for (const query of ['POST [FHIR BASE]/Observation?_count=10', 'GET https://foreign.test/Observation', 'GET [FHIR BASE]/Observation',
        'GET [FHIR BASE]/Observation?_count=0', 'GET [FHIR BASE]/Observation?_count=101', 'GET [FHIR BASE]/Observation?_count=10&_count=2',
        'GET [FHIR BASE]/Observation?patient=[PATIENT]&_count=10', 'GET [FHIR BASE]/Observation?date=ge[LOOKBACK_DATE]&_count=10',
        'GET [FHIR BASE]/Observation?clinical-status=active&_count=10', 'GET [FHIR BASE]/Observation?_include=Observation:subject&_count=10',
        'GET [FHIR BASE]/Observation?_count=10&code=a,,b', 'GET [FHIR BASE]/Observation?_count=10#fragment', 'GET [FHIR BASE]/Observation?_count=10&', 'GET [FHIR BASE]/Observation?_count=10&code', 'GET [FHIR BASE]/Observation?_count=10&code=', 'GET [FHIR BASE]/Patient?identifier=urn:patient|1&_count=10']) {
        const value = structuredClone(catalog); value.templates[0].exampleQueries[1].query = query;
        assert.throws(() => validateTemplates(value), /Service templates/, query);
    }
});

test('generated alternatives retain independent bucket/history/tagged restrictions and finite direct master reads', () => {
    for (const t of loadTemplates().filter(t => t.key !== 'basic-patient-data')) {
        const request = serviceDefinition(t.definition, { now: fixed }), grant = readServiceGrant(request), clauses = inspectScope(grant.scope).clauses;
        assert.equal(grant.anchor, '2028-05-31T12:00:00.000Z'); assert.equal(grant.historyMode, 'creation-fixed');
        for (const permission of t.definition.permissions.slice(1)) {
            const alternatives = clauses.filter(value => value.type === permission.type);
            const clause = alternatives[0];
            const bucket = t.definition.buckets.find(value => BUCKET_RESOURCES[value.code][permission.type]);
            assert.ok(clause.filters.includes(`_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|${bucket.code}`));
            const cutoff = historyStart(fixed, { system: 'http://unitsofmeasure.org', code: bucket.historyUnit, value: bucket.history });
            assert.ok(clause.filters.includes(`${BUCKET_RESOURCES[bucket.code][permission.type]}=ge${cutoff}`));
            for (const coding of SENSITIVITY_LABELS) assert.ok(clause.filters.includes(`_security:not=${coding.system}|${coding.code}`));
            assert.equal(alternatives.length, bucket.sensitivity.length ? 2 : 1);
            if (bucket.sensitivity.length) {
                const tagged = alternatives[1];
                assert.ok(tagged.filters.includes(`_security=${bucket.sensitivity.join(',')}`));
                for (const predicate of [R, V, `${BUCKET_RESOURCES[bucket.code][permission.type]}=ge${cutoff}`, `_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|${bucket.code}`]) assert.ok(tagged.filters.includes(predicate));
            }
        }
        assert.equal(readServiceGrant(JSON.parse(JSON.stringify(request))).scope, grant.scope, 'exact persisted round trip');
        const later = require('../src/service-scope-authoring').previewDefinition(request);
        assert.equal(later.effectiveScope, grant.scope, 'a read never advances dates');
        assert.equal(clauses.some(c => c.type === 'DiagnosticReport'), false, 'lab subset stays deliberate');
        if (t.definition.includeMasterData) {
            for (const type of ['Organization', 'Practitioner', 'PractitionerRole', 'Location']) assert.deepEqual(clauses.find(c => c.type === type), { context: 'patient', type, actions: 'r', filters: [R, V] });
            for (const type of ['Organization', 'Practitioner', 'PractitionerRole', 'Location']) assert.ok(request.extension.some(e => e.url === EXTENSIONS.exampleQuery && e.valueString === `GET [FHIR BASE]/${type}/[record-id]`));
        }
    }
    const hiv = loadTemplates().find(t => t.key === 'diabetes-follow-up'), mental = loadTemplates().find(t => t.key === 'cardiovascular-follow-up');
    assert.equal(hiv.definition.buckets[0].sensitivity[0], 'http://terminology.hl7.org/CodeSystem/v3-ActCode|HIV');
    assert.equal(mental.definition.buckets[0].sensitivity[0], 'http://fhir.health.gov.il/cs/il-core-sensitivity-labels|mental-health');
    assert.notEqual(hiv.definition.buckets[0].history, mental.definition.buckets[0].history);
    assert.match(compile(loadTemplates().find(t => t.key === 'post-discharge-review')), /date=ge2028-02-29T12:00:00.000Z/);
});

test('query validation follows r/s operations and qualified narrowing instead of exact placeholder wording', () => {
    for (const [actions, query] of [['r', 'GET [FHIR BASE]/Observation/[record-id]'], ['rs', 'GET [FHIR BASE]/Observation/known-1'],
        ['s', 'GET [FHIR BASE]/Observation?status=final&_count=5'], ['rs', 'GET [FHIR BASE]/Observation?_count=20&code=http://loinc.org|1234-5'],
        ['rs', 'GET [FHIR BASE]/Observation?date=ge2026-01-01&_count=10']]) {
        const value = structuredClone(catalog); value.templates[0].definition.permissions[1].actions = actions; value.templates[0].exampleQueries[1].query = query;
        assert.equal(validateTemplates(value)[0].exampleQueries[1].query, query);
    }
    for (const [actions, query] of [['r', 'GET [FHIR BASE]/Observation?_count=10'], ['s', 'GET [FHIR BASE]/Observation/[record-id]']]) {
        const value = structuredClone(catalog); value.templates[0].definition.permissions[1].actions = actions; value.templates[0].exampleQueries[1].query = query;
        assert.throws(() => validateTemplates(value), /Service templates/);
    }
});
test('duplicate ordinary registration returns existing identity or assignment, never an overwrite; pagination stays bounded', async () => {
    const t = loadTemplates()[0];
    // Use the real lifecycle-created shape rather than inventing classification coding.
    const f = require('../../../test-support/data-grants').dataGrantFixture(); const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
    let seq = 0; const created = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.store.get('Organization', f.config.organizations.serviceProvider.id), request: t.request, privateDefinition: t.privateDefinition, idGenerator: () => `template-${++seq}` });
    let registrations = 0;
    const client = { search: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: created.instance }] }), read: async () => { throw Object.assign(new Error('Hidden pending definition'), { status: 404 }); }, register: async () => { registrations++; } };
    assert.equal((await addTemplate(client, t, f.config.organizations.serviceProvider.id, { getDefinition: id => f.store.privateRecords.services.getDefinition(id) })).service.id, created.instance.id); assert.equal(registrations, 0);
    const changed = structuredClone(t); changed.request.extraDetails += ' revised'; await assert.rejects(addTemplate(client, changed, f.config.organizations.serviceProvider.id, { getDefinition: id => f.store.privateRecords.services.getDefinition(id) }), error => error.status === 409);
    const cyclic = { search: async () => ({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: 'https://pcm.test/HealthcareService?_page=repeat' }] }) };
    await assert.rejects(addTemplate(cyclic, t, 'provider', {}), /pagination/); assert.equal(registrations, 0);
});

test('missing, malformed and oversized installation config fail before any service operation', t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'template-config-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'service-templates.json'); assert.throws(() => loadTemplates(file), /ENOENT/);
    fs.writeFileSync(file, '{invalid'); assert.throws(() => loadTemplates(file), SyntaxError);
    fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1)); assert.throws(() => loadTemplates(file), /256 KiB/);
});

/** Bind template policy to resolved configuration, generated grant and saved metadata. */
test('template policy agrees with default and explicit R configuration and ordinary saved definitions', () => {
    const { readPolicy } = require('../../shared/service-confidentiality-policy');
    const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
    const f = require('../../../test-support/data-grants').dataGrantFixture();
    let sequence = 0;
    for (const allowRestricted of [false, true]) {
        const configured = structuredClone(catalog);
        if (allowRestricted) configured.templates[0].definition.confidentialityPolicy = { allowRestricted: true };
        const template = validateTemplates(configured)[0];
        template.request.name += allowRestricted ? ' explicit R' : ' default';
        template.privateDefinition.grant.authoring.name = template.request.name;
        const saved = lifecycle.registerHealthcareService({ store: f.store,
            callerOrganization: f.store.get('Organization', f.config.organizations.serviceProvider.id),
            request: template.request, privateDefinition: template.privateDefinition, idGenerator: () => `policy-copy-${++sequence}` });
        assert.deepEqual(f.store.privateRecords.services.getDefinition(saved.instance.id).confidentialityPolicy, { allowRestricted });
        assert.deepEqual(f.store.privateRecords.services.getDefinition(lifecycle.basedOnId(saved.instance)).confidentialityPolicy, { allowRestricted });
        for (const token of compile(template).split(' ')) {
            assert.equal(token.includes('Confidentiality|R'), !allowRestricted);
            assert.ok(token.includes('Confidentiality|V'));
        }
    }
});

/** Every supported draft field is authoritative; metadata stays inert and bounded. */
test('editable template fields preserve exact custom origin, all options and inert example text', () => {
    const { serviceDefinitionDraft: serviceDefinition } = require('../src/service-definition-form');
    const { sameDefinition } = require('../src/service-templates');
    const template = loadTemplates()[0], input = structuredClone(template.definition);
    input.name = 'Edited <script>alert(1)</script>';
    input.accessMode = 'one-time'; input.duration = 9; input.durationUnit = 'wk'; input.allowChanges = false;
    input.buckets[0].history = 0; input.buckets[0].historyUnit = 'd'; input.buckets[0].sensitivity = [`${SENSITIVITY_LABELS[0].system}|${SENSITIVITY_LABELS[0].code}`];
    input.confidentialityPolicy = { allowRestricted: true }; input.includeMasterData = true;
    input.permissions[1].actions = 'r'; input.scopeOrigin = 'custom';
    input.approvalScope = 'patient/Patient.rs  patient/Observation.r\npatient/Organization.r patient/Practitioner.r patient/PractitionerRole.r patient/Location.r';
    input.exampleQueries = [{ type: 'Patient', query: '<script>alert(1)</script>' }];
    const request = serviceDefinition(input);
    assert.equal(request.name, input.name);
    assert.equal(request.extension.find(item => item.url === EXTENSIONS.exampleQuery).valueString, input.exampleQueries[0].query);
    const option = request.extension.find(item => item.url === SANDBOX_EXTENSIONS.approvalScopeOption);
    assert.equal(option.extension.find(item => item.url === 'scope').valueString, input.approvalScope);
    assert.equal(option.extension.find(item => item.url === 'origin').valueString, 'custom');
    const generated = serviceDefinition({ ...template.definition, scopeOrigin: 'generated', exampleQueries: template.exampleQueries });
    assert.equal(sameDefinition(template.request, require('../src/public-fhir').splitProduced(generated).resource), true, 'legacy generated origin stays compatible');
    assert.equal(sameDefinition(require('../src/public-fhir').splitProduced(generated).resource, template.request), true);
    assert.equal(sameDefinition(template.request, request), false, 'custom content remains distinct');
    for (const exampleQueries of [null, {}, [{ type: 'Organization', query: 'x' }], [{ type: 'Patient', query: '' }], [{ type: 'Patient', query: 'x', owner: 'bad' }], [{ type: 'Patient', query: 'x\nunsafe' }]]) assert.throws(() => serviceDefinition({ ...template.definition, exampleQueries }), /Example queries/);
});

/** Authored r/s actions and custom scope metadata reach the same form contract without widening. */
test('maintained config accepts exact read/search subsets and custom scope while preserving five default definitions', () => {
    for (const actions of ['r', 's']) {
        const configured = structuredClone(catalog), entry = configured.templates[0];
        entry.definition.permissions[1].actions = actions;
        entry.definition.includeMasterData = true;
        entry.definition.confidentialityPolicy = { allowRestricted: true };
        entry.definition.scopeOrigin = 'custom';
        entry.definition.approvalScope = `patient/Patient.rs?${V} patient/Observation.${actions}?code=exact&${V} patient/Organization.r?${V} patient/Practitioner.r?${V} patient/PractitionerRole.r?${V} patient/Location.r?${V}`;
        if (actions === 'r') entry.exampleQueries[1].query = 'GET [FHIR BASE]/Observation/[record-id]';
        const result = validateTemplates(configured)[0];
        assert.equal(result.scope, entry.definition.approvalScope);
        assert.equal(result.definition.permissions[1].actions, actions);
        assert.equal(result.definition.includeMasterData, true);
        assert.equal(result.privateDefinition.options[0].extension.find(item => item.url === 'origin').valueString, 'custom');
    }
    assert.deepEqual(require('../../../config/service-templates.json'), catalog);
});
