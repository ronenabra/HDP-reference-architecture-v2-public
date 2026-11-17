'use strict';

/** New-authoring policy, closed validation, canonical precedence and legacy compatibility. */
const test = require('node:test'), assert = require('node:assert/strict');
const { serviceDefinitionDraft: serviceDefinition, existingRegistration } = require('../src/service-definition-form');
const { compileConsentScope, BUCKET_RESOURCES } = require('../src/grant-compiler');
const { approvalScopeOptions } = require('../src/approval-scopes');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { SENSITIVITY_LABELS } = require('../../shared/information-buckets');
const { URL, SYSTEM, readPolicy, policyExtension } = require('../../shared/service-confidentiality-policy');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const fixed = Date.parse('2028-05-31T12:00:00Z') / 1000;

/** Use the ordinary maintained template, changing only the policy being tested. */
function definition(overrides = {}) {
    return { ...structuredClone(require('../../../config/service-templates.json').templates[0].definition), ...overrides };
}

/** Detached canonical lookup makes a forged inherited copy observably non-authoritative. */
function fixture(input = definition()) {
    const canonical = serviceDefinition(input), service = existingRegistration('canonical');
    const store = { get: () => canonical, privateRecords: { services: { getDefinition: () => ({ status: 'ok', ...require('../src/public-fhir').splitProduced(canonical).definition }) } } };
    const scope = input.permissions.map(item => `patient/${item.type}.${item.actions}`).join(' ');
    const compile = (approved = scope, requested = scope) => compileConsentScope({ store, service, approved, scope: requested,
        now: fixed, patient: { system: 'urn:exact', value: 'one' } });
    return { canonical, service, store, scope, compile };
}

test('new ordinary authoring defaults R/V independently of sensitivity and template names', () => {
    for (const name of ['Basic example', 'sandbox-full-access', 'Ordinary service']) {
        const f = fixture(definition({ name }));
        assert.deepEqual(readPolicy(f.canonical), { allowRestricted: false });
        for (const token of f.compile().split(' ')) for (const code of ['R', 'V']) assert.ok(token.includes(`_security:not=${SYSTEM}|${code}`));
    }
    for (const permissions of [[], [{ type: 'Observation', actions: 'rs' }], [{ type: 'Patient', actions: 'r' }], [{ type: 'Patient', actions: 's' }]]) {
        assert.throws(() => serviceDefinition(definition({ permissions })));
    }
    for (const confidentialityPolicy of [null, {}, [], { allowRestricted: 'true' }, { allowRestricted: false, allowVeryRestricted: true }, { allowRestricted: false, sensitivity: [] }]) {
        assert.throws(() => serviceDefinition(definition({ confidentialityPolicy })));
    }
});

test('every bucket and sensitivity alternative retains service confidentiality and history across approval choices', () => {
    for (const [code, resources] of Object.entries(BUCKET_RESOURCES)) for (const allowRestricted of [false, true]) {
        const f = fixture(definition({ confidentialityPolicy: { allowRestricted },
            buckets: [{ code, history: 2, historyUnit: 'a', sensitivity: SENSITIVITY_LABELS.map(label => `${label.system}|${label.code}`) }],
            permissions: ['Patient', ...Object.keys(resources)].map(type => ({ type, actions: 'rs' })) }));
        const choices = approvalScopeOptions(f.store, f.service);
        for (const option of choices) for (const token of option.value.split(' ')) {
            assert.ok(token.includes(`_security:not=${SYSTEM}|V`));
            assert.equal(token.includes(`_security:not=${SYSTEM}|R`), !allowRestricted);
        }
        for (const approved of [...choices.map(option => option.value), f.scope, f.scope.replace(/\.rs/g, '.r')]) {
            const tokens = f.compile(approved).split(' ');
            for (const token of tokens) {
                assert.ok(token.includes(`_security:not=${SYSTEM}|V`));
                assert.equal(token.includes(`_security:not=${SYSTEM}|R`), !allowRestricted);
                if (token.startsWith('patient/Patient.')) assert.ok(token.includes('identifier=urn:exact|one'));
                else { assert.ok(token.includes(`|${code}`)); assert.ok(token.includes('ge2026-05-31T12:00:00.000Z')); }
            }
        }
        f.service.extension.push(policyExtension({ allowRestricted: !allowRestricted }));
        assert.equal(f.compile().includes(`_security:not=${SYSTEM}|R`), !allowRestricted, 'inherited policy cannot override canonical authority');
    }
});

test('closed wire metadata rejects duplicate/unknown fields and registration policy overrides', () => {
    const f = fixture();
    for (const mutate of [r => r.extension.push(policyExtension()), r => r.extension.find(x => x.url === URL).valueBoolean = true,
        r => r.extension.find(x => x.url === URL).extension.push({ url: 'allowVeryRestricted', valueBoolean: true }),
        r => r.extension.find(x => x.url === URL).extension[0].valueBoolean = 'false']) {
        const request = structuredClone(f.canonical); mutate(request);
        assert.throws(() => lifecycle.classifyRegistrationRequest(request), /policy/i);
    }
    assert.throws(() => lifecycle.classifyRegistrationRequest({ ...f.service, extension: [...f.service.extension, policyExtension()] }), /override/);
});

test('legacy omission preserves exact compiler behavior and does not write metadata', () => {
    const f = fixture(); f.canonical.extension = f.canonical.extension.filter(item => item.url !== URL);
    const before = structuredClone(f.canonical), grant = f.compile();
    assert.equal(readPolicy(f.canonical), null);
    assert.equal(grant.split(' ')[0], 'patient/Patient.rs?identifier=urn:exact|one');
    assert.equal(grant.includes(`_security:not=${SYSTEM}|R`), false);
    assert.ok(grant.includes(`_security:not=${SYSTEM}|V`));
    assert.deepEqual(f.canonical, before);
    const savedGrant = f.compile(); f.canonical.extension.push(policyExtension());
    assert.ok(f.compile().includes(`_security:not=${SYSTEM}|R`));
    assert.equal(savedGrant, grant, 'a prior compiled string remains immutable');
});

test('canonical R metadata cannot rewrite frozen approvals; broader issuance needs a new explicit decision', t => {
    const { grantHarness } = require('../../../test-support/pcm-042-grants');
    const { URL: SNAPSHOT_URL } = require('../../shared/consent-scope-snapshot');
    const { consentAuthorizationDetails } = require('../../shared/data-authorization-details');
    const { inspectScope } = require('../../shared/service-grant');
    const f = grantHarness('strict'); t.after(f.close);
    const id = lifecycle.basedOnId(f.store.get('HealthcareService', f.config.service.id));
    const setPolicy = allowRestricted => {
        const canonical = f.store.get('HealthcareService', id);
        const original = f.store.privateRecords.services.getDefinition(canonical.id).grant;
        require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, { ...original.authoring, confidentialityPolicy: { allowRestricted } }, { now: Date.parse(original.anchor) / 1000 });
    };
    setPolicy(false);
    const saved = f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot;
    const approvalBytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot);
    const issued = f.issue(); assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const old = f.inspect(issued.body.access_token); assert.equal(old.body.active, true);
    assert.equal(issued.body.scope, saved.scope); assert.equal(old.body.scope, saved.scope);
    assert.ok(old.body.scope.includes(`_security:not=${SYSTEM}|R`));
    setPolicy(true);
    const preserved = f.inspect(issued.body.access_token);
    assert.equal(preserved.body.active, false, 'canonical mutation still invalidates prior authority generations');
    assert.equal(f.tokenStore.get(issued.body.access_token).scope, saved.scope, 'revocation does not rewrite the issued record');
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot), approvalBytes);
    const fresh = f.issue(); assert.equal(fresh.status, 200);
    assert.equal(fresh.body.scope, saved.scope, 'fresh issuance copies the same approval rather than current R authoring metadata');
    assert.equal(f.inspect(fresh.body.access_token).body.scope, saved.scope);

    // The private sandbox allows a deliberate complete alternative at a new approval.
    const broaderScope = `patient/Patient.rs?_security:not=${SYSTEM}|V patient/Observation.rs?_security:not=${SYSTEM}|V`;
    const replacement = f.newDecision({ scope: broaderScope });
    assert.notEqual(replacement.id, f.consent.id);
    const replacementBytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(replacement.id).snapshot);
    assert.equal(f.store.privateRecords.approvals.getDecision(replacement.id).snapshot.scope, broaderScope);
    const issueReplacement = () => f.service({ body: { ...f.body, scope: inspectScope(broaderScope).requestCeiling,
        authorization_details: JSON.stringify(consentAuthorizationDetails(replacement)) } });
    const broader = issueReplacement(); assert.equal(broader.status, 200);
    assert.equal(broader.body.scope, broaderScope); assert.equal(f.inspect(broader.body.access_token).body.scope, broaderScope);
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot), approvalBytes);
    setPolicy(false);
    assert.equal(f.inspect(fresh.body.access_token).body.active, false);
    assert.equal(f.inspect(broader.body.access_token).body.active, false, 'restoring metadata cannot restore revoked authority');
    const current = f.issue(), currentBroader = issueReplacement();
    assert.equal(current.body.scope, saved.scope); assert.equal(f.inspect(current.body.access_token).body.scope, saved.scope);
    assert.equal(currentBroader.body.scope, broaderScope); assert.equal(f.inspect(currentBroader.body.access_token).body.scope, broaderScope);
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot), approvalBytes);
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(replacement.id).snapshot), replacementBytes);

    const service = f.store.get('HealthcareService', f.config.service.id);
    f.store.update({ ...service, active: false, extension: service.extension.map(item => item.url === EXTENSIONS.serviceBusinessStatus
        ? lifecycle.statusExtension('suspended') : item) });
    assert.equal(f.issue().status, 400, 'frozen permissions do not bypass current service eligibility');
    assert.equal(f.inspect(current.body.access_token).body.active, false);
    assert.equal(f.inspect(currentBroader.body.access_token).body.active, false);
});


test('new-policy Patient alternatives intersect custom actions and retain selected exclusions', () => {
    const f = fixture(definition({ confidentialityPolicy: { allowRestricted: true } }));
    const grant = f.compile(`patient/Patient.r?_security:not=${SYSTEM}|R patient/Observation.rs`);
    const patient = grant.split(' ')[0];
    assert.ok(patient.startsWith('patient/Patient.r?'));
    assert.ok(patient.includes(`_security:not=${SYSTEM}|R`));
    assert.ok(patient.includes(`_security:not=${SYSTEM}|V`));
    assert.throws(() => f.compile('patient/Observation.rs'), /Patient/);
});

test('service confidentiality does not alter separate authentication, presence or discovery grants', t => {
    const f = require('../../../test-support/pcm-042-grants').grantHarness('strict'); t.after(f.close);
    const service = f.store.get('HealthcareService', f.config.service.id);
    const canonical = f.store.get('HealthcareService', lifecycle.basedOnId(service));
    const original = f.store.privateRecords.services.getDefinition(canonical.id).grant;
    require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, { ...original.authoring, confidentialityPolicy: { allowRestricted: false } }, { now: Date.parse(original.anchor) / 1000 });
    for (const scenario of ['presence-check', 'patient-authentication', 'dependent-discovery']) {
        const issued = f.issue(scenario); assert.equal(issued.status, 200, JSON.stringify(issued.body));
        assert.equal(issued.body.scope.includes(SYSTEM), false);
        assert.equal(f.inspect(issued.body.access_token).body.active, true);
    }
});
