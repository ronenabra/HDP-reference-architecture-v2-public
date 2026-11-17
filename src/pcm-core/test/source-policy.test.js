'use strict';

/** Exercise legacy budget/security identities through effective policy and real OAuth services. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const { grantHarness } = require('../../../test-support/pcm-042-grants');
const { NOW } = require('../../../test-support/data-grants');
const { buildEffectivePolicy, NATIVE_FILTER_CONTROLS } = require('../../shared/conformance-policy');
const { registeredSourceId, sourceLimits, sourceControls } = require('../src/source-policy');
const { participantEndpoint, replaceEndpoint } = require('../src/fhir/participant-lifecycle');
const { newDataSourceConfig, syncDataSourcesToStore, getConfiguredDataSources } = require('../src/data-sources');
const { FHIRStore } = require('../src/fhir/store');
const { createClientAssertionVerifier, CLIENT_ASSERTION_TYPE } = require('../src/client-assertion');
const { MemoryExpiryClaimStore } = require('../src/state-store');

/** Add legacy to the real caller registry and Consent, preserving complete normative actors. */
function fixture(t, preset = 'connectathon-balanced') {
    const f = grantHarness(preset); t.after(f.close);
    const legacy = f.config.organizations.referenceDataSource;
    f.clients.push({ clientId: legacy.clientId, organizationId: legacy.id, role: 'data-source', scopes: ['introspection'] });
    const consent = f.store.get('Consent', f.consent.id);
    consent.provision.actor.push({ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] },
        reference: { reference: `Organization/${legacy.id}` } });
    f.store.update(consent);
    f.legacy = legacy;
    f.legacyEndpoint = () => participantEndpoint(f.store, f.store.get('Organization', legacy.id));
    f.issueLegacy = () => f.service({ body: { ...f.body, resource: f.legacyEndpoint().address } });
    return f;
}

/** Use the supported lifecycle to replace an Endpoint address, leaving configuration intact. */
function moveEndpoint(f, organizationId) {
    const owner = f.store.get('Organization', organizationId);
    let endpoint = participantEndpoint(f.store, owner);
    const request = { status: 'suspended', address: endpoint.address, connectionType: endpoint.connectionType, payloadType: endpoint.payloadType };
    endpoint = replaceEndpoint({ store: f.store, callerOrganization: owner, existing: endpoint, request });
    return replaceEndpoint({ store: f.store, callerOrganization: owner, existing: endpoint,
        request: { ...request, status: 'active', address: endpoint.address + '/moved' } });
}

/** Preserve the existing grouped legacy native-filter override when changing one named control. */
function legacyOverrides(f, values) {
    f.config.securitySimulation.perSource[f.config.legacyDataSource.id] = {
        ...f.config.securitySimulation.perSource[f.config.legacyDataSource.id], ...values
    };
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) {
    test(`${preset}: legacy budget alias and security ID retain separate effective policy and native-filter defaults`, t => {
        const f = fixture(t, preset);
        f.config.presence.sources = { legacy: { maxPatients: 7 }, [f.source.id]: { maxPatients: 3 } };
        for (const moved of [false, true]) {
            if (moved) moveEndpoint(f, f.legacy.id);
            const policy = buildEffectivePolicy(f.config);
            for (const selector of [{ id: 'legacy' }, { id: 'legacy-ds' }, { organizationId: f.legacy.id },
                { clientId: f.legacy.clientId }, { resource: f.legacyEndpoint().address }]) {
                assert.equal(registeredSourceId(f.store, f.config, selector), 'legacy');
                assert.equal(sourceLimits(f.store, f.config, selector).maxPatients, 7);
                assert.deepEqual(sourceControls(f.store, policy, f.config, selector), policy.simulation.perSource['legacy-ds'] || policy.simulation.controls);
                for (const control of NATIVE_FILTER_CONTROLS) assert.equal(sourceControls(f.store, policy, f.config, selector)[control], true, control);
            }
            assert.equal(sourceLimits(f.store, f.config, { clientId: f.source.clientId }).maxPatients, 3);
            assert.deepEqual(sourceControls(f.store, policy, f.config, { clientId: f.source.clientId }), policy.simulation.controls);
            const issued = f.issueLegacy(); assert.equal(issued.status, 400);
            assert.match(issued.body.error_description, /Legacy Node source/);
        }
        const malformed = structuredClone(f.config);
        malformed.securitySimulation.perSource['legacy-ds'] = { resultFiltering: true };
        assert.throws(() => buildEffectivePolicy(malformed), /invalid|unknown/);
    });
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) {
    for (const enabled of [false, true]) test(`${preset}: legacy tokenExpiry=${enabled} is rejected before save/reload or issuance`, t => {
        const f = fixture(t, preset), original = structuredClone(f.config);
        f.config.securitySimulation.global.tokenExpiry = enabled; legacyOverrides(f, { tokenExpiry: !enabled });
        assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
        Object.assign(f.config, original);
        const managed = f.issue(); assert.equal(managed.status, 200);
        f.setNow(NOW + 86400); assert.equal(f.inspect(managed.body.access_token).body.active, false);
        assert.equal(f.issueLegacy().status, 400);
    });
}

for (const control of ['consentState', 'serviceState']) for (const enabled of [false, true]) {
    test(`legacy ${control}=${enabled} cannot bypass current authority`, t => {
        const f = fixture(t), token = f.issue(); assert.equal(token.status, 200);
        legacyOverrides(f, { [control]: enabled }); assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
        delete f.config.securitySimulation.perSource[f.config.legacyDataSource.id];
        const original = control === 'consentState' ? f.store.get('Consent', f.consent.id) : f.store.get('HealthcareService', f.config.service.id);
        f.store.update({ ...original, ...(control === 'consentState' ? { status: 'inactive' } : { active: false }) });
        assert.equal(f.issue().status, 400); assert.equal(f.inspect(token.body.access_token).body.active, false);
        assert.equal(f.issueLegacy().status, 400);
    });
}

for (const [audience, binding] of [[true, true], [false, true], [true, false], [false, false]]) {
    test(`legacy audience=${audience}/binding=${binding} rejects configuration and cannot cross source authority`, t => {
        const f = fixture(t), token = f.issue(); assert.equal(token.status, 200);
        legacyOverrides(f, { tokenAudience: audience, tokenResourceBinding: binding }); assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
        delete f.config.securitySimulation.perSource[f.config.legacyDataSource.id];
        assert.equal(f.inspect(token.body.access_token, f.legacy.clientId).body.active, false);
        assert.equal(f.tokenStore.get(token.body.access_token).revoked, undefined);
        assert.equal(f.inspect(token.body.access_token).body.active, true);
    });
}

for (const kind of ['legacy', 'managed', 'custom']) {
    for (const enabled of [false, true]) {
        test(`${kind}: current Endpoint and caller identity select clientAssertionSignature=${enabled} with actual wrong-key verification`, t => {
            const f = fixture(t);
            let source = kind === 'legacy' ? { id: f.config.legacyDataSource.id, clientId: f.legacy.clientId, organizationId: f.legacy.id }
                : { ...f.source, organizationId: f.source.dataSourceOrganization.id };
            if (kind === 'custom') {
                const custom = newDataSourceConfig('Security custom', 'https://custom-security.example.invalid/fhir', { pcmClientAuthCertThumbprint: 'A'.repeat(43) });
                f.config.organizations.dataSources ||= []; f.config.organizations.dataSources.push(custom);
                syncDataSourcesToStore(f.store, f.config, 'A'.repeat(43));
                source = { ...custom, organizationId: custom.id };
            }
            f.config.securitySimulation.global.clientAssertionSignature = !enabled;
            if (kind === 'legacy') legacyOverrides(f, { clientAssertionSignature: enabled });
            else f.config.securitySimulation.perSource[source.id] = { clientAssertionSignature: enabled };
            const registered = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
            const wrong = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
            const verifier = createClientAssertionVerifier({ findClient: id => id === source.clientId ? { clientId: id, assertionKeys: { ES256: registered.publicKey } } : null,
                getPolicy: () => buildEffectivePolicy(f.config), replayStore: new MemoryExpiryClaimStore({ localOnly: true }), clock: () => NOW });
            for (const moved of [false, true]) {
                if (moved) moveEndpoint(f, source.organizationId);
                const endpoint = participantEndpoint(f.store, f.store.get('Organization', source.organizationId));
                for (const selector of [{ resource: endpoint.address }, { clientId: source.clientId }, { organizationId: source.organizationId }]) {
                    const controls = sourceControls(f.store, buildEffectivePolicy(f.config), f.config, selector);
                    const assertion = jwt.sign({ iss: source.clientId, sub: source.clientId, aud: 'https://pcm.example.invalid/token', jti: crypto.randomUUID(), iat: NOW, exp: NOW + 30 }, wrong.privateKey, { algorithm: 'ES256', header: { typ: 'JWT' } });
                    const verified = verifier({ assertion, assertionType: CLIENT_ASSERTION_TYPE, exactAudience: 'https://pcm.example.invalid/token', controls });
                    assert.equal(Boolean(verified.errorStatus), enabled);
                    if (!enabled) assert.equal(verified.client.clientId, source.clientId);
                }
            }
            assert.equal(sourceControls(f.store, buildEffectivePolicy(f.config), f.config, { clientId: f.config.healthOrganizations[1].clientId }).clientAssertionSignature, !enabled);
        });
    }
}

test('configured legacy security identity does not rename presence settings or merge an unrelated source key', t => {
    const f = fixture(t);
    f.config.legacyDataSource.id = 'registered-legacy-security';
    const defaults = f.config.securitySimulation.perSource['legacy-ds'];
    delete f.config.securitySimulation.perSource['legacy-ds'];
    f.config.securitySimulation.perSource['registered-legacy-security'] = { ...defaults, clientAssertionReplay: false };
    // The old legacy security spelling can belong to a different registered source; never merge it by alias.
    const custom = { ...newDataSourceConfig('Distinct source', 'https://distinct-source.example.invalid/fhir', { pcmClientAuthCertThumbprint: 'A'.repeat(43) }), id: 'legacy-ds' };
    f.config.organizations.dataSources ||= []; f.config.organizations.dataSources.push(custom);
    f.config.securitySimulation.perSource[custom.id] = { clientAssertionReplay: true };
    f.config.presence.sources = { legacy: { maxPatients: 7 }, [custom.id]: { maxPatients: 3 } };
    syncDataSourcesToStore(f.store, f.config, 'A'.repeat(43));
    const policy = buildEffectivePolicy(f.config);
    assert.equal(registeredSourceId(f.store, f.config, { id: 'registered-legacy-security' }), 'legacy');
    assert.equal(sourceLimits(f.store, f.config, { clientId: f.legacy.clientId }).maxPatients, 7);
    assert.equal(sourceControls(f.store, policy, f.config, { resource: f.legacyEndpoint().address }).clientAssertionReplay, false);
    assert.equal(sourceLimits(f.store, f.config, { resource: custom.endpoint }).maxPatients, 3);
    assert.equal(sourceControls(f.store, policy, f.config, { resource: custom.endpoint }).clientAssertionReplay, true);
    const consent = f.store.get('Consent', f.consent.id);
    consent.provision.actor.push({ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] },
        reference: { reference: `Organization/${custom.id}` } });
    f.store.update(consent);
    assert.equal(f.service({ body: { ...f.body, resource: custom.endpoint } }).status, 200, 'custom source is independently entitled before the lifecycle change');
    f.store.update({ ...f.store.get('Consent', consent.id), status: 'inactive' });
    assert.equal(f.issueLegacy().status, 400);
    assert.equal(f.service({ body: { ...f.body, resource: custom.endpoint } }).status, 400);
    f.config.securitySimulation.perSource.legacy = { clientAssertionReplay: false };
    assert.throws(() => buildEffectivePolicy(f.config), /unknown per-source/);
});

test('strict preset keeps legacy excluded and rejects per-source simulation overrides', t => {
    const f = fixture(t, 'strict');
    assert.equal(f.config.legacyDataSource.enabled, false);
    assert.equal(buildEffectivePolicy(f.config).simulation.controls.resultFiltering, true);
    const sources = getConfiguredDataSources(f.config);
    assert.equal(sources.some(source => source.id === f.legacy.id), false);
    // The shared grant harness initially seeds an easy graph; qualify strict registration in a fresh graph.
    const strictStore = new FHIRStore(); syncDataSourcesToStore(strictStore, f.config, 'A'.repeat(43));
    assert.equal(strictStore.get('Organization', f.legacy.id), null);
    legacyOverrides(f, { tokenExpiry: false });
    assert.throws(() => buildEffectivePolicy(f.config), /unknown per-source|strict mode/);
});
