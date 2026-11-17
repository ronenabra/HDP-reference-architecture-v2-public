'use strict';
/** Owned public-only PCM HTTPS fixture and actual Doctor app, with a closed network allowlist. */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), https = require('node:https'), http = require('node:http');
const { doctorPublicFixture } = require('./doctor-public-fixture');
const { EXTENSIONS, IDENTIFIER_SYSTEMS } = require('../src/shared/pcm-contract');
const { TYPE } = require('../src/shared/data-authorization-details');
const issuer = 'https://pcm2mtest.health.gov.il/api/fhir-service/r4';
/** Listen only on a disposable loopback port. */
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
/** Read the small fixture form/resource request. */
const body = request => new Promise(resolve => { let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => resolve(data)); });

/** Start public PCM/FHIR/OAuth operations; every private/Admin/unknown path is a recorded failure. */
async function startDoctorPublicServer({ application = true, sampling = false } = {}) {
    const previous = { ...process.env }, directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-public08-'));
    const certs = require('./certificates').certificates();
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../pcm-connectathon/example-team-config.json')));
    const f = doctorPublicFixture(), requests = [], violations = [], issued = new Map();
    const consents = new Map();
    f.instance.providedBy.reference = `Organization/${config.organizations.serviceProvider.id}`;
    f.provider.id = config.organizations.serviceProvider.id;
    f.instance.name = 'Clinical summary'; f.canonical.name = 'Clinical summary';
    for (const [index, id] of ['123e4567-e89b-42d3-a456-426614174000', '123e4567-e89b-42d3-a456-426614174001'].entries()) {
        const consent = structuredClone(f.consent); consent.id = id;
        consent.identifier[0].value = 'PCM-PUBLIC-' + index;
        consent.patient.identifier = { system: IDENTIFIER_SYSTEMS.syntheticTest, value: String(index + 1) };
        consent.provision.period = { start: new Date(Date.now() - 60000).toISOString(), end: new Date(Date.now() + 86400000).toISOString() };
        consent.meta.versionId = '1'; consent.meta.security = [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }]; consents.set(id, consent);
    }
    const state = { introspection: 'active', rejectClinical: false, scope: f.scope, lifetime: 30, sourceMode: 'normal', tokenDelay: null, statusDelay: null };
    if (sampling) {
        state.sampleMode = 'loaded'; state.sampleDelay = null;
        config.sandboxSampling = { sourceIds: ['ho-a', 'ho-b'] };
        config.serviceCatalog = { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: f.instance.id, instanceIdentifier: 'OWNED-LIBRARY-SERVICE' }] };
        for (const role of ['serviceProvider', 'hospitalBServiceProvider']) config.systemAuthorization.clientEntitlements[config.organizations[role].clientId] = ['sandbox-patient-sample'];
        fs.mkdirSync(path.join(directory, 'config'));
        fs.copyFileSync(path.resolve(__dirname, '../config/demo-services.json'), path.join(directory, 'config/demo-services.json'));
    }
    let base;
    const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/fhir+json' }); res.end(JSON.stringify(data)); };
    const pcm = https.createServer({ cert: fs.readFileSync(path.join(certs, 'pcm-core.crt')), key: fs.readFileSync(path.join(certs, 'pcm-core.key')),
        ca: fs.readFileSync(path.join(certs, 'rootCA.crt')), requestCert: true, rejectUnauthorized: true }, async (req, res) => {
        try {
            const url = new URL(req.url, base), data = ['POST', 'PUT'].includes(req.method) ? await body(req) : '';
            requests.push({ method: req.method, path: url.pathname, query: url.search, ...(url.pathname.endsWith('/Consent') && req.method === 'POST' ? { body: JSON.parse(data) } : {}), ...(url.pathname.endsWith('/token') ? { requestedScope: new URLSearchParams(data).get('scope') } : {}) });
            if (/admin|approval|permission|private/.test(url.pathname)) { violations.push(req.url); return send(res, 500, { error: 'Proprietary reads forbidden' }); }
            const prefix = '/api/fhir-service/r4';
            if (url.pathname === prefix + '/.well-known/smart-configuration') return send(res, 200, {
                issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', introspection_endpoint: issuer + '/introspect',
                authorization_details_types_supported: [TYPE], grant_types_supported: ['authorization_code', 'client_credentials'], response_types_supported: ['code'],
                code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: sampling ? ['ES256', 'ES384'] : ['ES256'],
                tls_client_certificate_bound_access_tokens: false, capabilities: ['launch-standalone', 'client-confidential-asymmetric', 'permission-patient', 'permission-v2'] });
            if (url.pathname === prefix + '/token' && req.method === 'POST') {
                const form = new URLSearchParams(data), requested = form.has('authorization_details') ? JSON.parse(form.get('authorization_details')) : null;
                const sample = sampling && requested?.[0]?.fhirContext?.[0]?.type === 'Contract';
                const clinical = !!requested && !sample;
                const subject = require('jsonwebtoken').decode(form.get('client_assertion'))?.sub;
                const assertionFile = sampling && subject === config.organizations.hospitalBServiceProvider.clientId ? 'hospital-b-sp-assertion.crt' : 'sp-client-assertion.crt';
                const assertion = require('jsonwebtoken').verify(form.get('client_assertion'), new (require('node:crypto').X509Certificate)(fs.readFileSync(path.join(certs, assertionFile))).publicKey, { algorithms: sampling ? ['ES256', 'ES384'] : ['ES256'], audience: issuer + '/token' });
                if (clinical && state.rejectClinical) return send(res, 400, { error: 'invalid_scope', error_description: 'External PCM rejects requested scope for this approval; review your intended operations.' });
                const details = clinical ? JSON.parse(form.get('authorization_details')) : null;
                const consent = clinical ? [...consents.values()].find(value => value.identifier[0].value === details[0].fhirContext[0].identifier.value) : null;
                if (clinical && (!consent || consent.status !== 'active')) return send(res, 400, { error: 'invalid_grant' });
                if (clinical && state.tokenDelay) await state.tokenDelay;
                const effective = clinical ? structuredClone(f.details) : null;
                if (effective) { effective[0].fhirContext[0].identifier = { system: consent.identifier[0].system, value: consent.identifier[0].value }; effective[0].fhirContext[2].identifier = consent.patient.identifier; }
                const response = { access_token: 'opaque-doctor-public-' + issued.size, token_type: 'Bearer', expires_in: state.lifetime,
                    scope: clinical ? state.scope : form.get('scope'), ...(effective ? { authorization_details: effective } : {}) };
                if (sample) {
                    const { ROLE, SERVICE } = require('../src/shared/data-authorization-details');
                    const definition = require('../config/demo-services.json').sandboxSampling;
                    if (requested[0].fhirContext[0].identifier.value !== definition.policyIdentifier || form.get('scope') !== 'system/Patient.s'
                        || !config.healthOrganizations.slice(0, 2).some(source => source.endpoint === form.get('resource'))
                        || !config.systemAuthorization.clientEntitlements[assertion.sub]?.includes('sandbox-patient-sample')) throw new Error('Invalid fixture sampler grant request');
                    response.authorization_details = [{ type: TYPE, purposeOfUse: [{ system: 'urn:pcm:sandbox:authorization-scenario', code: 'sandbox-patient-sample' }],
                        fhirContext: [...requested[0].fhirContext, { type: 'HealthcareService', role: ROLE + 'healthcare-service', identifier: { system: SERVICE.Contract, value: definition.serviceIdentifier } }] }];
                    Object.assign(requests.at(-1), { authorizationBasis: 'Contract', clientId: assertion.sub });
                }
                issued.set(response.access_token, { ...response, client_id: assertion.sub, aud: form.get('resource'), exp: Math.floor(Date.now() / 1000) + state.lifetime });
                return send(res, 200, response);
            }
            if (url.pathname === prefix + '/introspect' && req.method === 'POST') {
                if (state.statusDelay) await state.statusDelay;
                if (['refused', 'unsupported', 'unavailable'].includes(state.introspection)) return send(res, { refused: 403, unsupported: 404, unavailable: 503 }[state.introspection], { error: 'access_denied' });
                const form = new URLSearchParams(data);
                const claims = require('jsonwebtoken').verify(form.get('client_assertion'), new (require('node:crypto').X509Certificate)(fs.readFileSync(path.join(certs, 'sp-client-assertion.crt'))).publicKey, { algorithms: ['ES256'], audience: issuer + '/introspect' });
                const subject = issued.get(form.get('token'));
                if (subject && claims.sub !== subject.client_id) return send(res, 403, { error: 'access_denied' });
                if (!subject || state.introspection === 'inactive') return send(res, 200, { active: false });
                const result = { active: true, scope: subject.scope, authorization_details: subject.authorization_details, client_id: subject.client_id, aud: subject.aud, exp: subject.exp };
                if (state.introspection === 'issuer-valid') result.iss = issuer;
                if (state.introspection === 'issuer-mismatch') result.iss = issuer + '/another-issuer';
                if (state.introspection === 'contradictory') result.scope = 'patient/Patient.rs';
                if (state.introspection === 'malformed') result.active = 'true';
                return send(res, 200, result);
            }
            const bearer = req.headers.authorization?.slice(7);
            if (!issued.has(bearer)) return send(res, 401, { error: 'invalid_token' });
            if (sampling && /^\/sample\/ho-[ab]\/Patient$/.test(url.pathname)) {
                const { URI, SYSTEM } = require('../src/shared/sandbox-patients');
                const source = config.healthOrganizations.find(source => source.endpoint + '/Patient' === base + url.pathname);
                const token = issued.get(bearer);
                if (req.method !== 'GET' || '/fhir/Patient' + url.search !== URI || token.scope !== 'system/Patient.s' || token.aud !== source?.endpoint) throw new Error('Unbounded or unbound sampler request');
                Object.assign(requests.at(-1), { sampleClient: token.client_id });
                const mode = state.sampleMode, delay = state.sampleDelay;
                if (delay) await delay;
                if (mode === 'failed') return send(res, 503, { error: 'Owned sample source unavailable' });
                const entries = mode === 'empty' ? [] : [0, 1, 2].map(index => ({ resource: { resourceType: 'Patient',
                    identifier: [{ system: SYSTEM, value: `Ab123456-1234-5678-9012-${String(index + 1).padStart(12, '0')}` }],
                    ...(index < 2 ? { birthDate: index === 0 ? '1985-03-12' : '1985-03' } : {}),
                    name: [{ text: index === 0 ? '<img src=x onerror="window.injected=true"> Alex Example' : index === 1 ? 'Jordan Sample' : '' }],
                    meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } } }));
                if (mode === 'partial') entries.push(entries[0], { resource: { resourceType: 'Patient' } });
                return send(res, 200, { resourceType: 'Bundle', type: 'searchset', entry: entries,
                    link: [{ relation: 'next', url: base + '/forbidden-next-page' }] });
            }
            if (url.pathname === prefix + '/HealthcareService' && req.method === 'GET') return send(res, 200, { resourceType: 'Bundle', type: 'searchset', total: 2, entry: [{ resource: f.instance }, { resource: f.canonical }] });
            const resource = [f.instance, f.canonical, f.provider].find(value => url.pathname === `${prefix}/${value.resourceType}/${value.id}`);
            if (resource && req.method === 'GET') return send(res, 200, resource);
            if (url.pathname === prefix + '/Consent' && req.method === 'POST') {
                const request = JSON.parse(data), consent = structuredClone([...consents.values()][0]);
                consent.id = require('node:crypto').randomUUID(); consent.patient = request.patient; consent.identifier[0].value = 'PCM-' + consent.id; consent.status = 'proposed'; consents.set(consent.id, consent);
                return send(res, 201, consent);
            }
            if (url.pathname === prefix + '/Consent' && req.method === 'GET') {
                const selected = url.searchParams.get('_id'), matches = [...consents.values()].filter(value => !selected || selected === value.id);
                return send(res, 200, { resourceType: 'Bundle', type: 'searchset', total: matches.length, entry: [...matches.map(resource => ({ search: { mode: 'match' }, resource })), ...sources()] });
            }
            if (url.pathname.startsWith(prefix + '/Consent/') && req.method === 'PUT') {
                const consent = consents.get(url.pathname.split('/').at(-1));
                if (!consent) return send(res, 404, {});
                consent.status = 'inactive'; consent.meta.versionId = String(Number(consent.meta.versionId) + 1); return send(res, 200, consent);
            }
            if (/^\/source-[12]\/[A-Z][A-Za-z]+$/.test(url.pathname) && req.method === 'GET') {
                if (state.sourceMode === 'partial' && url.pathname.endsWith('/Condition')) return send(res, 403, { resourceType: 'OperationOutcome' });
                const type = url.pathname.split('/').at(-1), more = state.sourceMode === 'more';
                return send(res, 200, { resourceType: 'Bundle', type: 'searchset', total: state.sourceMode === 'empty' ? 0 : state.sourceMode === 'restricted-fixture' ? 2 : more ? 20 : 1,
                    // Synthetic R/V display fixture only; real enforcement remains the native owner matrix.
                    entry: state.sourceMode === 'empty' ? [] : state.sourceMode === 'restricted-fixture'
                        ? ['R', 'V'].map(code => ({ resource: { resourceType: type, id: 'public-' + code, status: 'final', effectiveDateTime: '2001-01-01T00:00:00Z',
                            meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code }] } } }))
                        : [{ resource: { resourceType: type, id: 'public-result', status: 'final' } }],
                    ...(more ? { link: [{ relation: 'next', url: base + '/source-1/' + type + '?opaque=next' }] } : {}) });
            }
            violations.push(req.method + ' ' + req.url); send(res, 500, { error: 'Undocumented fixture operation' });
        } catch (error) { violations.push(error.message); send(res, 500, { error: error.message }); }
    });
    /** Public source Organizations/Endpoints in the exact Consent include graph. */
    function sources() {
        return [1, 2].flatMap(index => [
            { resource: { resourceType: 'Organization', id: 'public-source-' + index, active: true, identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'PUBLIC-SOURCE-' + index }], name: 'Public source ' + index, endpoint: [{ reference: 'Endpoint/public-endpoint-' + index }] } },
            { resource: { resourceType: 'Endpoint', id: 'public-endpoint-' + index, status: 'active', address: base + '/source-' + index, managingOrganization: { reference: 'Organization/public-source-' + index } } }
        ]);
    }
    await listen(pcm); base = `https://127.0.0.1:${pcm.address().port}`;
    if (sampling) for (const source of config.healthOrganizations.slice(0, 2)) source.endpoint = base + '/sample/' + source.id;
    for (const consent of consents.values()) consent.provision.actor = [...consent.provision.actor.filter(actor => !actor.role?.coding?.some(code => code.code === 'CST')).map(actor => ({ ...actor, reference: { reference: `Organization/${config.organizations.serviceProvider.id}` } })), ...[1].map(index => ({ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: 'Organization/public-source-' + index } }))];
    config.internalBaseUrls.pcmFhir = base + '/api/fhir-service/r4'; config.internalBaseUrls.pcmAuth = config.internalBaseUrls.pcmFhir;
    process.env.TEAM_CONFIG_PATH = path.join(directory, 'team-config.json'); process.env.CERTS_DIR = certs; process.env.LOG_DIR = path.join(directory, 'logs');
    delete process.env.PCM_FHIR_URL; delete process.env.PCM_CONFORMANCE_MODE;
    let doctor, doctorBase;
    if (application) {
        config.publicBaseUrls.spClient = 'http://localhost:13100';
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
        doctor = http.createServer(require('../src/sp-client/src/index').app); await listen(doctor); doctorBase = `http://127.0.0.1:${doctor.address().port}`;
        // A new fixture must not inherit another runtime's process-local dashboard or selections.
        await fetch(doctorBase + '/reset', { method: 'POST', redirect: 'manual' });
    }
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    return { ...f, base, doctorBase, state, config, requests, violations, consents, directory,
        async close() {
            for (const server of [doctor, pcm].filter(Boolean)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            require('../src/sp-client/src/client').resetCache(); fs.rmSync(directory, { recursive: true, force: true });
            for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
        }
    };
}
module.exports = { startDoctorPublicServer };
