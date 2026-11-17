'use strict';

/** Browser regressions for Doctor diagnostics, client context and live authorization changes. */
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const { isBackendCertificateDenial, isCertificateGuardBody } = require('./backend-client-denial');
const { doctorServiceSelection } = require('../../scripts/sanity-data-state');
const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require('../../../src/shared/assertion-keys');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const publicRoot = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const { validateClinicalGrant } = require(path.join(publicRoot, 'src/sp-client/src/permission-plan'));
const sp = process.env.PCM_UI_SP_URL;
const pcm = process.env.PCM_UI_PCM_URL;
const CERTS = process.env.PCM_UI_CERTS_DIR || '/certs';
const CANONICAL = 'http://pcm.fhir.health.gov.il';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** Authenticate only to the selected disposable team's Admin listener. */
test.beforeEach(async ({ page }) => {
    if (process.env.PCM_UI_ADMIN_PASSWORD) {
        const response = await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
        expect(response.ok()).toBeTruthy();
    }
});

test('Doctor diagnostics preserves text, selection and explicit log read states @smoke', async ({ page }) => {
    const live = await page.request.get(`${sp}/api/logs`);
    expect(live.ok()).toBeTruthy();
    expect(Array.isArray(await live.json())).toBeTruthy();
    expect(['available', 'empty', 'missing']).toContain(live.headers()['x-log-state']);
    // Controlled payloads exercise browser rendering without rewriting live log files.
    const markup = '<img src=x onerror="window.doctorLogInjected=true">';
    let response = { status: 200, state: 'available', body: [{ id: 'stable-log-id', level: 'info', timestamp: '2026-01-01T00:00:00Z', message: markup, details: { raw: markup, sequence: 1 } }] };
    await page.route('**/api/logs', route => route.fulfill({ status: response.status,
        headers: { 'Content-Type': 'application/json', 'X-Log-State': response.state }, body: JSON.stringify(response.body) }));
    await page.goto(`${sp}/logs-view`);
    const row = page.locator('[data-log-id="stable-log-id"]');
    await expect(row).toContainText(markup);
    await row.click();
    await expect(page.locator('#details-pane pre')).toContainText('"sequence": 1');
    await expect(page.locator('#details-pane')).toContainText(markup);
    expect(await page.evaluate(() => Boolean(window.doctorLogInjected))).toBe(false);
    await expect(page.locator('#log-list img, #details-pane img')).toHaveCount(0);
    response.body[0].details.sequence = 2;
    await page.evaluate(() => refreshLogs());
    await expect(row).toHaveClass(/selected/);
    await expect(page.locator('#details-pane pre')).toContainText('"sequence": 2');
    response = { status: 503, state: 'unavailable', body: { error: 'fixture read failure' } };
    await page.evaluate(() => refreshLogs());
    await expect(page.locator('#local-log-status')).toContainText('HTTP 503');
    await expect(page.locator('#details-pane pre')).toContainText('"sequence": 2');
    response = { status: 200, state: 'empty', body: [] };
    await page.evaluate(() => refreshLogs());
    await expect(page.locator('#local-log-status')).toHaveText('Doctor App log file is empty.');
    await expect(page.locator('#details-pane')).toContainText('Selected event is no longer');
    response.state = 'missing';
    await page.evaluate(() => refreshLogs());
    await expect(page.locator('#local-log-status')).toHaveText('No Doctor App log file has been created.');
});

test('Doctor identity selection preserves labels and management client context @smoke', async ({ page }) => {
    await page.goto(`${sp}/`);
    const doctor = page.locator('#doctor-identity');
    const offered = await doctor.locator('option').evaluateAll(options => options.map(option => ({ id: option.value, label: option.textContent.trim() })));
    expect(offered.map(item => item.id)).toEqual(['hospital-a', 'hospital-b', 'untrusted', 'untrusted-assertion']);
    expect(offered.every(item => item.label && !item.label.includes('[object Object]'))).toBeTruthy();
    await doctor.selectOption('hospital-b');
    await expect(page).toHaveURL(/identity=hospital-b/);
    await expect(doctor).toHaveValue('hospital-b');
    await page.goto(`${sp}/manage?identity=hospital-b`);
    await expect(page.locator('#manage-identity')).toHaveValue('hospital-b');
    const context = await page.locator('input[type="hidden"][name="identity"]').evaluateAll(inputs => inputs.map(input => input.value));
    expect(context.length).toBeGreaterThan(0);
    expect(context.every(value => value === 'hospital-b')).toBeTruthy();
    expect((await page.request.get(`${sp}/manage?identity=unknown`)).status()).toBe(400);
});

/** Resolve HO roles from their explicit certificate mapping. */
function certificateRole(config, participant, kind) {
    if (!participant.startsWith('healthOrganization:')) return config.certificateRoles[participant][kind];
    const ho = config.healthOrganizations.find(item => item.id === participant.split(':')[1]);
    return kind === 'assertion' ? { key: ho.certificates.gatewayAssertionKey }
        : { cert: ho.certificates.gatewayMtlsCert, key: ho.certificates.gatewayMtlsKey };
}

/** Sign an exact ES256 assertion with the team's independent registered assertion key. */
function assertion(config, participant, clientId, audience) {
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const role = certificateRole(config, participant, 'assertion');
    const privateKey = fs.readFileSync(path.join(CERTS, role.key));
    const algorithm = signingAlgorithm(privateKey);
    const body = `${encode({ alg: algorithm, typ: 'JWT', kid: jwkThumbprint(privateKey) })}.${encode({ iss: clientId, sub: clientId,
        aud: audience, iat: now, exp: now + 120, jti: crypto.randomUUID(), cnf: certificateConfirmation(fs.readFileSync(path.join(CERTS, certificateRole(config, participant, 'mtls').cert))) })}`;
    const signature = crypto.sign(algorithm === 'ES384' ? 'sha384' : 'sha256', Buffer.from(body), {
        key: privateKey, dsaEncoding: 'ieee-p1363'
    });
    return `${body}.${signature.toString('base64url')}`;
}

/** Send a real mTLS request without recording credentials in Playwright attachments. */
function mtlsRequest(config, participant, url, { method = 'GET', form, body, token } = {}) {
    const role = certificateRole(config, participant, 'mtls');
    const payload = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const request = https.request(url, {
            ca: fs.readFileSync(path.join(CERTS, config.certificates.rootCaCert)),
            cert: fs.readFileSync(path.join(CERTS, role.cert)), key: fs.readFileSync(path.join(CERTS, role.key)),
            method, timeout: 20000,
            headers: { Accept: 'application/fhir+json', 'X-Flow-Id': crypto.randomUUID(), ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(payload ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/fhir+json',
                    'Content-Length': Buffer.byteLength(payload) } : {}) }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                let json;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* status still establishes denial */ }
                resolve({ status: response.statusCode, json });
            });
        });
        request.on('timeout', () => request.destroy(new Error('live mTLS authorization probe timed out')));
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

/** Build minimal RAR from the authoritative Consent business identifier. */
function consentDetails(consent) {
    const system = 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id';
    const identifiers = (consent.identifier || []).filter(item => item.system === system && item.value);
    if (identifiers.length !== 1) throw new Error('Missing authoritative Consent identifier');
    return [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access',
        fhirContext: [{ type: 'Consent', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis',
            identifier: { system, value: identifiers[0].value } }] }];
}

/** Resolve Consent through the public FHIR API before requesting a data grant. */
async function readConsent(config, consentId) {
    const credential = await issue(config, config.contract.operational.fhirBase, 'system/*.crus');
    const response = await mtlsRequest(config, 'serviceProvider', `${config.publicBaseUrls.pcmApi}/Consent/${consentId}`, { token: credential.value });
    expect(response.status).toBe(200);
    expect(response.json?.resourceType).toBe('Consent');
    expect(response.json.id).toBe(consentId);
    return response.json;
}

/** Use finite app request intent; public Consent deliberately omits exact approval permissions. */
function clinicalApprovalRequest(consent) {
    if (consent?.status !== 'active') throw new Error('An active public Consent is required for positive clinical issuance');
    return { scope: 'patient/Patient.rs patient/Observation.rs', details: consentDetails(consent) };
}

/** Resolve the exact public service association using this SP's ordinary API credentials. */
async function readPublicService(config, consent) {
    const reference = consent.extension?.find(item => item.url === `${CANONICAL}/StructureDefinition/ext-pcm-service`)?.valueReference?.reference;
    if (!/^HealthcareService\/[A-Za-z0-9.-]{1,64}$/.test(reference || '')) throw new Error('Public Consent service association unavailable');
    const credential = await issue(config, config.contract.operational.fhirBase, 'system/*.crus');
    const response = await mtlsRequest(config, 'serviceProvider', `${config.publicBaseUrls.pcmApi}/${reference}`, { token: credential.value });
    expect(response.status).toBe(200);
    return response.json;
}

/** Validate obtained public scope and every typed binding, without a hidden approval shape. */
function clinicalResponse(response, consent, config, service) {
    return validateClinicalGrant(response, consent, service, { allowSandboxGuid: config.conformance?.preset !== 'strict' }).scope;
}

/** Obtain a real opaque token; returned credentials stay in this Node process only. */
async function issue(config, resource, scope, consentId) {
    const provider = config.organizations.serviceProvider;
    const consent = consentId ? await readConsent(config, consentId) : undefined;
    const approval = consent ? clinicalApprovalRequest(consent) : undefined;
    const details = approval?.details;
    const service = consent ? await readPublicService(config, consent) : undefined;
    const endpoint = `${config.publicBaseUrls.pcmApi}/token`;
    const result = await mtlsRequest(config, 'serviceProvider', endpoint, { method: 'POST', form: {
        grant_type: 'client_credentials', client_assertion_type: ASSERTION_TYPE,
        client_assertion: assertion(config, 'serviceProvider', provider.clientId, `${config.contract.operational.oauthBase}/token`), scope: approval ? approval.scope : scope, resource,
        ...(details ? { authorization_details: JSON.stringify(details) } : {})
    } });
    expect(result.status, 'live opaque token issuance').toBe(200);
    expect(typeof result.json?.access_token).toBe('string');
    const effectiveScope = approval ? clinicalResponse(result.json, consent, config, service) : undefined;
    return { value: result.json.access_token, expiresAt: Date.now() + result.json.expires_in * 1000, effectiveScope };
}

/** Inspect the same bearer at PCM immediately after a lifecycle transition. */
async function introspect(config, ho, token) {
    const endpoint = `${config.publicBaseUrls.pcmApi}/introspect`;
    const participant = `healthOrganization:${ho.id}`;
    return mtlsRequest(config, participant, endpoint, { method: 'POST', form: {
        token, token_type_hint: 'access_token', client_assertion_type: ASSERTION_TYPE,
        client_assertion: assertion(config, participant, ho.clientId, `${config.contract.operational.oauthBase}/introspect`)
    } });
}

/** Build the closed owner transition instead of sending an authoritative resource back as input. */
function serviceTransition(id, code) {
    return { resourceType: 'HealthcareService', id,
        meta: { profile: [`${CANONICAL}/StructureDefinition/pcm-healthcareservice-instance-business-status-update`] },
        extension: [{ url: `${CANONICAL}/StructureDefinition/ext-service-business-status`,
            valueCoding: { system: `${CANONICAL}/cs/pcm-service-business-status`, code } }] };
}

/** Build the closed Consent deactivation request. */
function consentDeactivation(id) {
    return { resourceType: 'Consent', id, meta: { profile: [`${CANONICAL}/StructureDefinition/pcm-consent-deactivate`] },
        status: 'inactive', scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] },
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA' }] }],
        policy: [{ authority: 'https://www.gov.il/', uri: 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024' }] };
}

test('Doctor live Consent and service transitions invalidate warm authorization within its cache bound', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'live mutation matrix runs once per disposable preset');
    test.setTimeout(180000);
    const original = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    if (process.env.PCM_UI_REQUIRE_CLINICAL !== 'true') test.skip(true, 'ordinary empty-server smoke excludes the required clinical matrix');
    const config = original;
    let serviceId;
    let serviceSuspended = false;
    const createdIds = [];
    // Clinical eligibility is invariant; exercise this owned team's actual preset.
    const ho = config.healthOrganizations[0];
    const sourceUrl = config.publicBaseUrls.healthOrganizations[ho.id];
    const resource = ho.endpoint;
    const read = bearer => mtlsRequest(config, 'serviceProvider', `${sourceUrl}/Observation`, { token: bearer });
    const managementWrite = async (type, id, body) => {
        const credential = await issue(config, config.contract.operational.fhirBase, 'system/*.crus');
        return mtlsRequest(config, 'serviceProvider', `${config.publicBaseUrls.pcmApi}/${type}/${id}`, { method: 'PUT', body, token: credential.value });
    };
    const createActiveConsent = async () => {
        const before = new Set((await (await page.request.get(`${pcm}/admin/consents`)).json()).consents.map(consent => consent.id));
        const composer = await page.request.get(`${sp}/?identity=hospital-a`);
        expect(composer.ok()).toBeTruthy();
        const selection = doctorServiceSelection(await composer.text(), config, 'hospital-a');
        await page.request.post(`${sp}/create-consent`, { form: { identity: 'hospital-a', ...selection,
            patientId: 'http://fhir.health.gov.il/identifier/il-national-id|000000018' } });
        const consents = (await (await page.request.get(`${pcm}/admin/consents`)).json()).consents;
        const consent = consents.find(item => !before.has(item.id));
        expect(consent, 'new consent created through Doctor').toBeTruthy();
        createdIds.push(consent.id);
        const approved = await page.request.post(`${pcm}/admin/consents/${consent.id}/approve`, { headers: { Accept: 'application/json' },
            data: { expectedVersion: consent.meta.versionId, scopeChoice: 'service-provided' } });
        expect(approved.ok()).toBeTruthy();
        const result = (await approved.json()).consent;
        expect(result.status).toBe('active');
        return result;
    };
    const verifyRevocation = async credential => {
        expect(Date.now(), 'token must still be unexpired at the authoritative lifecycle decision').toBeLessThan(credential.expiresAt - 2000);
        const decision = await introspect(config, ho, credential.value);
        expect(decision.status).toBe(200);
        expect(decision.json?.active).toBe(false);
        // The environment determines lifetime independently of preset. Prove
        // immediate authoritative invalidation before waiting out the cache.
        const untilExpiry = Math.max(0, credential.expiresAt - Date.now() + 1500);
        const cacheWait = Math.min(untilExpiry, 31500);
        await page.waitForTimeout(cacheWait);
        if (untilExpiry > 31500) expect(Date.now()).toBeLessThan(credential.expiresAt);
        expect([401, 403]).toContain((await read(credential.value)).status);
    };
    try {
        const consent = await createActiveConsent();
        const first = await issue(config, resource, undefined, consent.id);
        const firstActive = await introspect(config, ho, first.value);
        expect(firstActive.json?.active).toBe(true); expect(firstActive.json.scope).toBe(first.effectiveScope);
        const positive = await read(first.value);
        expect(positive.status).toBe(200);
        expect(positive.json?.entry?.some(entry => entry.resource?.resourceType === 'Observation'
            && entry.resource.id === `observation-${ho.id}-0001`)).toBeTruthy();
        expect((await read(first.value)).status).toBe(200); // warm the same bearer cache
        expect((await managementWrite('Consent', consent.id, consentDeactivation(consent.id))).status).toBe(200);
        await verifyRevocation(first);

        const serviceConsent = await createActiveConsent();
        serviceId = serviceConsent.extension.find(extension => extension.url === `${CANONICAL}/StructureDefinition/ext-pcm-service`).valueReference.reference.split('/')[1];
        const second = await issue(config, resource, undefined, serviceConsent.id);
        const secondActive = await introspect(config, ho, second.value);
        expect(secondActive.json?.active).toBe(true); expect(secondActive.json.scope).toBe(second.effectiveScope);
        expect((await read(second.value)).status).toBe(200);
        expect((await read(second.value)).status).toBe(200);
        expect((await managementWrite('HealthcareService', serviceId, serviceTransition(serviceId, 'suspended'))).status).toBe(200);
        serviceSuspended = true;
        await verifyRevocation(second);
        expect((await managementWrite('HealthcareService', serviceId, serviceTransition(serviceId, 'active'))).status).toBe(200);
        serviceSuspended = false;
        const restored = Date.now() >= second.expiresAt
            ? await issue(config, resource, undefined, serviceConsent.id) : second;
        const restoredActive = await introspect(config, ho, restored.value);
        expect(restoredActive.json?.active).toBe(true); expect(restoredActive.json.scope).toBe(restored.effectiveScope);
        expect((await read(restored.value)).status).toBe(200);
    } finally {
        if (serviceSuspended) expect((await managementWrite('HealthcareService', serviceId, serviceTransition(serviceId, 'active'))).status).toBe(200);
        for (const id of createdIds) {
            const listed = (await (await page.request.get(`${pcm}/admin/consents`)).json()).consents.find(consent => consent.id === id);
            if (['active', 'proposed'].includes(listed?.status)) expect((await managementWrite('Consent', id, consentDeactivation(id))).status).toBe(200);
        }
        expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config.conformance).toEqual(original.conformance);
    }
});

/** Validate the actual outbound assertion without attaching its credentials to browser artifacts. */
function negativeAssertionReachedRemote(config, entry, identity) {
    const encoded = new URLSearchParams(entry.details.data).get('client_assertion');
    if (!encoded) return false;
    const [header, claims, signature] = encoded.split('.');
    const jose = JSON.parse(Buffer.from(header, 'base64url'));
    const payload = JSON.parse(Buffer.from(claims, 'base64url'));
    const clientId = identity === 'untrusted' ? config.organizations.untrustedClient.clientId
        : config.organizations.serviceProvider.clientId;
    const filename = config.certificateRoles.untrustedClient.assertion.key;
    return jose.alg === 'ES256' && jose.typ === 'JWT' && payload.iss === clientId && payload.sub === clientId
        && payload.aud === `${config.contract.operational.oauthBase}/token`
        && crypto.verify('sha256', Buffer.from(`${header}.${claims}`), {
            key: crypto.createPublicKey(fs.readFileSync(path.join(CERTS, filename))), dsaEncoding: 'ieee-p1363'
        }, Buffer.from(signature, 'base64url'));
}

test('Doctor negative identities reach the actual transport and assertion boundaries with observed remote results', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'actual negative request matrix runs once per disposable preset');
    test.skip(process.env.PCM_UI_REQUIRE_CLINICAL !== 'true', 'ordinary empty-server smoke excludes the required clinical matrix');
    test.setTimeout(120000);
    const status = await page.request.get(`${pcm}/admin/status`);
    expect(status.ok()).toBeTruthy();
    const config = (await status.json()).config;
    const patient = require('./fixture-facts').selectedFixtureFacts().patients.find(item => item.idValue === '000000018');
    expect(patient, 'verified known CI Patient prerequisite').toBeTruthy();
    const mtls = config.conformance.preset === 'strict' || config.security.pcmApi.clientAuth === 'mtls';
    const signatureEnforced = config.conformance.preset === 'strict'
        || (config.securitySimulation.global.clientAssertionSignature ?? config.conformance.preset !== 'connectathon-easy');
    const readConsents = async () => (await (await page.request.get(`${pcm}/admin/consents`)).json()).consents;
    const tokenUrl = entry => entry.details?.url && new URL(entry.details.url).pathname === '/api/fhir-service/r4/token';
    const beforeConsents = new Set((await readConsents()).map(item => item.id));
    try {
        for (const identity of ['untrusted', 'untrusted-assertion']) {
            const oldLogIds = new Set((await (await page.request.get(`${sp}/api/logs`)).json()).map(entry => entry.id));
            const flowId = crypto.randomUUID();
            // Non-provider identities have no owned picker registration. The existing
            // manual refresh reaches their real token boundary without creating authority.
            const requested = await page.request.post(`${sp}/discover`, { maxRedirects: 0,
                headers: { 'x-flow-id': flowId }, form: { identity, consentId: crypto.randomUUID() } });
            expect(requested.status()).toBe(302);
            const logs = (await (await page.request.get(`${sp}/api/logs`)).json())
                .filter(entry => !oldLogIds.has(entry.id) && entry.details?.flowId === flowId);
            const sent = logs.find(entry => entry.details?.type === 'OUTGOING_REQUEST'
                && String(entry.details.method).toUpperCase() === 'POST' && tokenUrl(entry));
            expect(Boolean(sent), `${identity} must reach the real PCM token endpoint`).toBeTruthy();
            expect(negativeAssertionReachedRemote(config, sent, identity), `${identity} must send a valid independently signed ES256 JWT`).toBe(true);
            const failure = logs.find(entry => entry.details?.type === 'OUTGOING_ERROR' && tokenUrl(entry));
            const completed = logs.find(entry => entry.details?.type === 'HARNESS_ACTION_COMPLETED'
                && entry.details.operation === 'discover-source' && entry.details.identity === identity);
            const localFailures = logs.filter(entry => entry.details?.type === 'HARNESS_ACTION_FAILED')
                .map(entry => entry.details?.error?.message || entry.message).join(' ');
            expect(localFailures).not.toMatch(/P-256 assertion key is missing|transport keys cannot sign|asymmetricKeyType|Unknown Doctor identity/);
            if (identity === 'untrusted' && mtls) {
                // The certificate-optional TLS listener also serves normative browser authorization.
                // Backend certificate enforcement may reject this identity with an OAuth HTTP denial.
                expect(isBackendCertificateDenial(failure), 'untrusted backend certificate must be denied by TLS or HTTP authentication').toBe(true);
                if (failure.details.status === 401) expect(isCertificateGuardBody(failure.details.data), 'certificate guard must explain the denied certificate').toBe(true);
                expect(Boolean(completed)).toBe(false);
            } else if (identity === 'untrusted' || signatureEnforced) {
                expect(failure?.details.status, `${identity} must be rejected remotely by OAuth`).toBe(401);
                expect(failure.details.data?.error).toBe('invalid_client');
                expect(Boolean(completed)).toBe(false);
            } else {
                // Easy intentionally disables the source simulation signature check.
                // Record its real accepted request instead of claiming TLS/key enforcement.
                expect(logs.some(entry => entry.details?.type === 'OUTGOING_RESPONSE'
                    && tokenUrl(entry) && entry.details.status === 200)).toBeTruthy();
                expect(Boolean(completed)).toBe(true);
                expect(completed.details.status).toBe('not-found');
            }
            expect((await readConsents()).map(item => item.id).sort(), 'read-only diagnostic must not create Consent').toEqual([...beforeConsents].sort());
        }
    } finally {
        // An accepted relaxed request, or an unexpectedly accepted negative case,
        // must not leave a new pending/active Consent behind after this probe.
        const created = (await readConsents()).filter(item => !beforeConsents.has(item.id)
            && ['proposed', 'active'].includes(item.status));
        for (const consent of created) {
            const credential = await issue(config, config.contract.operational.fhirBase, 'system/*.crus');
            const cancelled = await mtlsRequest(config, 'serviceProvider', `${config.publicBaseUrls.pcmApi}/Consent/${consent.id}`, {
                method: 'PUT', body: consentDeactivation(consent.id), token: credential.value
            });
            expect(cancelled.status, 'negative-identity probe Consent cleanup').toBe(200);
        }
    }
});

test('UI OPS real PCM approval states and protected source/requester/expiry matrix', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop' || !process.env.PCM_OPS_STATE_DIR,
        'requires explicitly mounted state from the owned disposable operator team');
    test.setTimeout(180000);
    const config = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    const ho = config.healthOrganizations[0];
    const source = config.publicBaseUrls.healthOrganizations[ho.id];
    const headers = { Accept: 'application/json' };
    const outcomes = { preset: config.conformance.preset, clinicalEligibilityRequired: true, decisions: [] };
    const list = async () => (await (await page.request.get(`${pcm}/admin/consents`)).json()).consents;
    /** Create through Doctor and inspect the independent authoritative PCM registry. */
    async function create(patientId) {
        const before = new Set((await list()).map(item => item.id));
        const composer = await page.request.get(`${sp}/?identity=hospital-a`);
        expect(composer.ok()).toBeTruthy();
        const selection = doctorServiceSelection(await composer.text(), config, 'hospital-a');
        const response = await page.request.post(`${sp}/create-consent`, { form: { identity: 'hospital-a', ...selection, patientId } });
        expect(response.ok()).toBeTruthy();
        const consent = (await list()).find(item => !before.has(item.id));
        expect(consent).toBeTruthy();
        return consent;
    }
    /** Request a real source token with the exact calling Organization, not a forged client context. */
    async function requestToken(consentId, resource = ho.endpoint, participant = 'serviceProvider', negativeScope) {
        const provider = config.organizations[participant];
        const consent = await readConsent(config, consentId);
        // Pending/rejected probes deliberately send an explicit old wire request to
        // reach PCM's remote eligibility denial. Positive issuance has no fallback.
        const approval = negativeScope === undefined ? clinicalApprovalRequest(consent) : undefined;
        const details = consentDetails(consent);
        const service = approval ? await readPublicService(config, consent) : undefined;
        const endpoint = `${config.publicBaseUrls.pcmApi}/token`;
        const result = await mtlsRequest(config, participant, endpoint, { method: 'POST', form: {
            grant_type: 'client_credentials', client_assertion_type: ASSERTION_TYPE,
            client_assertion: assertion(config, participant, provider.clientId, `${config.contract.operational.oauthBase}/token`),
            authorization_details: JSON.stringify(details), scope: approval ? approval.scope : negativeScope, resource
        } });
        const effectiveScope = result.status === 200 && approval ? clinicalResponse(result.json, consent, config, service) : undefined;
        return { ...result, effectiveScope };
    }
    const automatic = [];
    for (const value of ['1', '2']) {
        const consent = await create(`http://fhir.health.gov.il/identifier/il-hdp-test-id|${value}`);
        expect(consent.status).toBe('active');
        expect(consent.testAutoApproved).toBe(true);
        automatic.push(consent);
        const token = await requestToken(consent.id);
        expect(token.status).toBe(200);
        const active = await introspect(config, ho, token.json.access_token);
        expect(active.json.active).toBe(true); expect(active.json.scope).toBe(token.effectiveScope);
        expect((await mtlsRequest(config, 'serviceProvider', `${source}/Observation`, { token: token.json.access_token })).status).toBe(200);
        outcomes.decisions.push({ case: `exact-test-${value}`, status: consent.status, token: token.status, source: 200 });
    }
    const ordinary = await create('http://fhir.health.gov.il/identifier/il-national-id|000000018');
    expect(ordinary.status).toBe('proposed');
    expect(ordinary.testAutoApproved).toBe(false);
    const pending = await requestToken(ordinary.id, ho.endpoint, 'serviceProvider', 'patient/Observation.rs');
    expect([400, 401, 403]).toContain(pending.status);
    const fetchPending = await page.request.post(`${sp}/fetch-data`, { headers, data: {
        identity: 'hospital-a', consentId: ordinary.id, endpointUrl: ho.endpoint, requestedScope: 'patient/Observation.rs'
    } });
    expect(fetchPending.ok()).toBe(false);
    expect((await fetchPending.json()).status).toBe('fail');
    expect((await list()).find(item => item.id === ordinary.id).status).toBe('proposed');
    await page.goto(`${sp}/`);
    const pendingCard = page.locator(`.card:has(input[name="consentId"][value="${ordinary.id}"])`);
    await expect(pendingCard.locator('[data-help-key="doctor.consent-status"]')).toHaveText('Recorded: proposed');
    await expect(pendingCard.locator('[data-help-key="consent.test-approved"]')).toHaveCount(0);
    await page.screenshot({ path: `/artifacts/${config.conformance.preset}-doctor-pending.png` });
    outcomes.decisions.push({ case: 'ordinary-pending', token: pending.status, fetch: fetchPending.status(), stored: 'proposed' });
    const currentPending = (await list()).find(item => item.id === ordinary.id);
    expect(currentPending?.status).toBe('proposed');
    const approved = await page.request.post(`${pcm}/admin/consents/${ordinary.id}/approve`, { headers,
        data: { sourceIds: [ho.dataSourceOrganization.id], expectedVersion: currentPending.meta.versionId, scopeChoice: 'service-provided' } });
    expect(approved.ok()).toBeTruthy();
    expect((await approved.json()).consent.status).toBe('active');
    const token = await requestToken(ordinary.id);
    expect(token.status).toBe(200);
    const active = await introspect(config, ho, token.json.access_token);
    expect(active.json.active).toBe(true); expect(active.json.scope).toBe(token.effectiveScope);
    expect((await mtlsRequest(config, 'serviceProvider', `${source}/Observation`, { token: token.json.access_token })).status).toBe(200);
    const denied = await create('http://fhir.health.gov.il/identifier/il-national-id|000000026');
    const decision = await page.request.post(`${pcm}/admin/consents/${denied.id}/decline`, { headers, data: {} });
    expect(decision.ok()).toBeTruthy();
    expect((await list()).find(item => item.id === denied.id).status).toBe('rejected');
    const rejectedToken = await requestToken(denied.id, ho.endpoint, 'serviceProvider', 'patient/Observation.rs');
    expect([400, 401, 403]).toContain(rejectedToken.status);
    const wrongSource = await requestToken(ordinary.id, config.healthOrganizations[1].endpoint);
    expect([400, 401, 403]).toContain(wrongSource.status);
    const wrongClient = await requestToken(ordinary.id, ho.endpoint, 'hospitalBServiceProvider');
    expect([400, 401, 403]).toContain(wrongClient.status);
    const wrongGateway = await mtlsRequest(config, 'serviceProvider', `${config.publicBaseUrls.healthOrganizations['ho-b']}/Observation`, { token: token.json.access_token });
    expect([401, 403]).toContain(wrongGateway.status);
    // Backdate only a newly minted token in this explicitly mounted disposable state.
    const expires = await requestToken(ordinary.id);
    expect(expires.status).toBe(200);
    const hash = crypto.createHash('sha256').update(expires.json.access_token).digest('hex');
    const file = path.join(process.env.PCM_OPS_STATE_DIR, 'access-tokens', `token-${hash}.json`);
    const record = JSON.parse(fs.readFileSync(file));
    record.iat = Math.floor(Date.now() / 1000) - 1000;
    record.exp = Math.floor(Date.now() / 1000) - 1;
    fs.writeFileSync(file, JSON.stringify(record));
    expect((await introspect(config, ho, expires.json.access_token)).json.active).toBe(false);
    const expiredRead = await mtlsRequest(config, 'serviceProvider', `${source}/Observation`, { token: expires.json.access_token });
    expect([401, 403]).toContain(expiredRead.status);
    outcomes.decisions.push({ case: 'protected-negatives', denied: rejectedToken.status, wrongSource: wrongSource.status,
        wrongClient: wrongClient.status, wrongGateway: wrongGateway.status, expired: expiredRead.status });
    // Creating a Consent selects that patient/service. Reset only Doctor convenience state
    // so the final overview can inspect all four authoritative PCM records together.
    expect((await page.request.post(`${sp}/reset`)).ok()).toBe(true);
    await page.goto(`${sp}/`);
    await expect(page.locator('[data-help-key="consent.test-exception"]')).toContainText('1 and 2');
    for (const consent of automatic) {
        await expect(page.locator(`.card:has(input[name="consentId"][value="${consent.id}"]) [data-help-key="consent.test-approved"]`)).toHaveCount(1);
    }
    await expect(page.locator(`.card:has(input[name="consentId"][value="${ordinary.id}"]) [data-help-key="doctor.consent-status"]`)).toHaveText('active');
    await expect(page.locator(`.card:has(input[name="consentId"][value="${denied.id}"]) [data-help-key="doctor.consent-status"]`)).toHaveText('rejected');
    await expect(page.locator(`.card:has(input[name="consentId"][value="${ordinary.id}"]) [data-help-key="consent.test-approved"]`)).toHaveCount(0);
    await page.screenshot({ path: `/artifacts/${config.conformance.preset}-doctor-approval.png` });
    await page.goto(`${pcm}/ui`);
    await expect(page.locator('[data-help-key="consent.test-exception"]')).toContainText('1 and 2');
    for (const consent of automatic) {
        await expect(page.getByRole('row').filter({ hasText: consent.id }).locator('[data-help-key="consent.test-approved"]')).toHaveCount(1);
    }
    await expect(page.getByRole('row').filter({ hasText: denied.id })).toContainText('rejected');
    await page.screenshot({ path: `/artifacts/${config.conformance.preset}-pcm-approval.png` });
    fs.writeFileSync(`/artifacts/${config.conformance.preset}-approval-results.json`, JSON.stringify(outcomes, null, 2));
});
