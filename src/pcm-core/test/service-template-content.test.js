'use strict';
/** Template recipes freeze creation/approval history and preserve exact later grants. */
const test = require('node:test'), assert = require('node:assert/strict');
const { dataGrantFixture, NOW, rar } = require('../../../test-support/data-grants');
const { loadTemplates } = require('../src/service-templates');
const { registerHealthcareService } = require('../src/fhir/healthcare-service-lifecycle');
const { applyServiceCommand } = require('../src/sandbox-service-command');
const { createConsent, approveConsent } = require('../src/fhir/consent-lifecycle');
const { inspectScope } = require('../../shared/service-grant');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { resolveGrant } = require('../src/data-grant');
const { createTokenService } = require('../src/token-service');
const { evaluateSubjectToken } = require('../src/introspection-service');

test('every template freezes default and explicit bucket approval separately, with unchanged later issuance/introspection', () => {
    for (const template of loadTemplates()) {
        const f = dataGrantFixture({ legacy: true }), createdAt = NOW - 86400 * 20, approvedAt = NOW;
        const authored = require('../src/service-definition-form').serviceDefinitionCommand(template.definition, { now: createdAt });
        const request = authored.resource;
        const created = registerHealthcareService({ store: f.store, callerOrganization: f.store.get('Organization', f.client.organizationId), request, privateDefinition: authored.definition,
            clock: () => new Date(createdAt * 1000) });
        for (const service of [created.canonical, created.instance]) applyServiceCommand({ store: f.store, config: f.config, id: service.id, action: 'activate',
            expectedVersion: service.meta.versionId, operator: 'owned-template-unit', audit() {}, now: new Date(createdAt * 1000) });
        const saved = f.store.privateRecords.services.getDefinition(created.canonical.id).grant;
        assert.equal(saved.anchor, new Date(createdAt * 1000).toISOString());
        const body = structuredClone(require('../../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        body.patient.identifier = f.strongPatient;
        body.extension.find(e => e.url === EXTENSIONS.pcmService).valueReference.reference = 'HealthcareService/' + created.instance.id;
        const pending = createConsent({ store: f.store, config: f.config, callerOrganization: f.store.get('Organization', f.client.organizationId), request: body,
            clock: () => new Date(approvedAt * 1000) });
        const consent = approveConsent({ store: f.store, consent: pending, scopeChoice: 'service-provided',
            sourceOrganizationIds: [f.source.dataSourceOrganization.id], clock: () => new Date(approvedAt * 1000) });
        const snapshot = f.store.privateRecords.approvals.getDecision(consent.id).snapshot;
        assert.equal(snapshot.scope, saved.scope); assert.equal(snapshot.anchor, saved.anchor);
        const coarse = inspectScope(saved.scope).requestCeiling;
        let now = approvedAt + 86400;
        const recordStore = [];
        const issuer = createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore,
            tokenStore: { issue(kind, claims, lifetime) { const record = { ...structuredClone(claims), kind, iat: now, exp: now + lifetime }; recordStore.push(record); return { token: 'owned-template-token', record }; } },
            authenticate: req => { req.mtls = { thumbprint: f.client.mtlsThumbprint }; return { client: f.client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: f.client.assertionThumbprint }; },
            getConfig: () => f.config, getIssuer: () => f.config.contract.operational.fhirBase, getPolicy: () => ({}), getLifetime: () => 86400,
            clock: () => now, logger: { info() {}, warn() {} } });
        for (const offset of [86400, 86400 * 2]) {
            now = approvedAt + offset;
            const resolved = resolveGrant({ ...f.request, requested: rar('Consent', consent.identifier[0].value), scope: coarse, now });
            assert.equal(resolved.scope, saved.scope);
            const response = issuer({ body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion: 'owned-double', scope: coarse, resource: f.source.endpoint, authorization_details: JSON.stringify(rar('Consent', consent.identifier[0].value).details) } });
            assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.scope, saved.scope);
            const record = recordStore.at(-1);
            const active = evaluateSubjectToken({ token: record, caller: { clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id },
                store: f.store, config: f.config, firstUseStore: f.firstUseStore, now, findClient: id => id === f.client.clientId ? f.client : id === f.source.clientId ? { clientId: id, organizationId: f.source.dataSourceOrganization.id, role: 'data-source' } : null });
            assert.equal(active?.scope, saved.scope); assert.ok(record.exp > now); assert.ok(active.exp <= now + 30);
        }
        const second = createConsent({ store: f.store, config: f.config, callerOrganization: f.store.get('Organization', f.client.organizationId), request: body,
            clock: () => new Date((approvedAt + 1) * 1000) });
        const fresh = approveConsent({ store: f.store, consent: second, scopeChoice: 'auto-buckets', sourceOrganizationIds: [f.source.dataSourceOrganization.id],
            clock: () => new Date((approvedAt + 1) * 1000) });
        const freshSnapshot = f.store.privateRecords.approvals.getDecision(fresh.id).snapshot;
        assert.equal(freshSnapshot.anchor, new Date((approvedAt + 1) * 1000).toISOString());
        assert.equal(freshSnapshot.historyMode, 'approval-fixed'); assert.notEqual(freshSnapshot.scope, saved.scope);
        assert.equal(f.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope, saved.scope);
        assert.equal(JSON.parse(JSON.stringify(f.store.privateRecords.services.getDefinition(created.canonical.id).grant)).scope, saved.scope);
    }
});
