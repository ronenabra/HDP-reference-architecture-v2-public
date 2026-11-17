#!/usr/bin/env node
const crypto = require('crypto');
const { readEnvironmentValue } = require('./team-credentials');
const fs = require('fs');
const path = require('path');
const { URL, URLSearchParams } = require('url');
const { inspectTeamFixtures } = require('./fixture-patients');
const { request, referenceDataSourceUrl, backendMtlsDenied } = require('./sanity-request');
const { consentMatchesOwner, doctorServiceSelection, doctorConsentQuery, doctorConsentCreated, hasPositiveObservation, presencePrerequisite, presenceIsConfigured, presenceAuthorizationDetails, jwksIsAbsent } = require('./sanity-data-state');
const { parseArgs, readValidatedTeamConfig, sharedModuleRoot } = require('./lib');
const { buildEffectivePolicy, effectivePolicyReport } = require(path.join(sharedModuleRoot(), 'conformance-policy'));
const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require(path.join(sharedModuleRoot(), 'assertion-keys'));

const args = parseArgs(process.argv);
const configPath = path.resolve(args.config || 'pcm-connectathon/example-team-config.json');
const config = readValidatedTeamConfig(configPath);
const certsDir = path.resolve(args['certs-dir'] || path.join(path.dirname(configPath), 'certs'));
const teamEnvPath = path.resolve(args['team-env'] || path.join(path.dirname(configPath), '.env'));
const teamEnvText = fs.existsSync(teamEnvPath) ? fs.readFileSync(teamEnvPath, 'utf8') : '';
const teamEnvValue = name => readEnvironmentValue(teamEnvText, name);
const effectivePolicy = buildEffectivePolicy(config, process.env);
const identity = args.identity || 'hospital-a';
const requestedPatientId = args.patientId || args['patient-id'] || '';
let patientId = '';
let selectedPatient = null;
const adminPassword = args['admin-password']
    || args.adminPassword
    || process.env.TEAM_ADMIN_PASSWORD
    || teamEnvValue('TEAM_ADMIN_PASSWORD');
const spBase = args['sp-base-url'] || args.spBaseUrl || config.publicBaseUrls.spClient;
const pcmUiBase = args['pcm-ui-base-url'] || args.pcmUiBaseUrl || config.publicBaseUrls.pcmUi;
const referenceDsBaseUrl = referenceDataSourceUrl(config, args['reference-ds-base-url'] || args.referenceDsBaseUrl);
const referenceDsHealthUrl = args['reference-ds-health-url'] || args.referenceDsHealthUrl || '';
const useInternalUrls = Boolean(args['use-internal-urls']);
const canonicalPcmApi = config.contract.operational.oauthBase;
const canonicalPcmMetadata = config.publicBaseUrls.pcmMetadata.replace(/\/+$/, '');
const pcmApiTransport = (args['pcm-api-base-url'] || (useInternalUrls ? config.internalBaseUrls?.pcmAuth : '') || config.publicBaseUrls.pcmApi).replace(/\/+$/, '');
const pcmMetadataTransport = (args['pcm-metadata-base-url'] || (useInternalUrls ? 'https://pcm-core:3005/api/fhir-service/r4' : '') || canonicalPcmMetadata).replace(/\/+$/, '');
const healthOrganizationTransportUrls = useInternalUrls
    ? config.internalBaseUrls?.healthOrganizations || config.publicBaseUrls.healthOrganizations
    : config.publicBaseUrls.healthOrganizations;
const latencyProbeTimeoutMs = Number(args['latency-probe-timeout-ms'] || 5000);
const fetchTimeoutMs = Number(args['fetch-timeout-ms'] || 30000);
const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * Create a short check result.
 * @param {string} name
 * @param {boolean} passed
 * @param {object} details
 * @returns {object}
 */
const check = (name, passed, details = {}) => ({ name, status: passed ? 'pass' : 'fail', ...details });
const adminHeaders = () => (adminPassword ? { Accept: 'application/json', 'x-admin-password': adminPassword } : { Accept: 'application/json' });


function readCertificateRole(participant, role) {
    const binding = config.certificateRoles?.[participant]?.[role];
    if (!binding?.cert || !binding?.key) throw new Error(`missing ${participant}.${role} certificate role`);
    return {
        cert: fs.readFileSync(path.join(certsDir, binding.cert)),
        key: fs.readFileSync(path.join(certsDir, binding.key)),
        ca: fs.readFileSync(path.join(certsDir, config.certificates.rootCaCert)),
        rejectUnauthorized: true
    };
}

function assertion(clientId, audience, participant) {
    const hoId = participant.startsWith('healthOrganization:') ? participant.split(':')[1] : null;
    const ho = hoId ? config.healthOrganizations.find(item => item.id === hoId) : null;
    const role = ho
        ? { key: ho.certificates.gatewayAssertionKey }
        : config.certificateRoles?.[participant]?.assertion;
    if (!role?.key) throw new Error(`missing ${participant}.assertion key role`);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const key = fs.readFileSync(path.join(certsDir, role.key));
    const algorithm = signingAlgorithm(key);
    const signingInput = `${encode({ alg: algorithm, typ: 'JWT', kid: jwkThumbprint(key) })}.${encode({
        iss: clientId,
        sub: clientId,
        aud: audience,
        iat: now,
        exp: now + 300,
        jti: crypto.randomUUID(),
        cnf: certificateConfirmation(fs.readFileSync(path.join(certsDir, ho ? ho.certificates.gatewayMtlsCert : config.certificateRoles[participant].mtls.cert)))
    })}`;
    const signature = crypto.sign(algorithm === 'ES384' ? 'sha384' : 'sha256', Buffer.from(signingInput), {
        key,
        dsaEncoding: 'ieee-p1363'
    });
    return `${signingInput}.${signature.toString('base64url')}`;
}

async function issueClientCredentials(participant, clientId, resource, scope, authorizationDetails) {
    const tokenUrl = `${pcmApiTransport}/token`;
    return request('POST', tokenUrl, {
        tls: readCertificateRole(participant, 'mtls'),
        form: {
            grant_type: 'client_credentials',
            client_assertion_type: assertionType,
            client_assertion: assertion(clientId, `${canonicalPcmApi}/token`, participant),
            scope,
            ...(authorizationDetails ? { authorization_details: JSON.stringify(authorizationDetails) } : {}),
            resource
        }
    });
}

async function latencyProbe(name, url, options = {}) {
    if (!url) return null;
    const res = await request(options.method || 'GET', url, {
        headers: options.headers,
        tls: options.tls,
        timeout: options.timeout || 30000
    });
    const expectedStatuses = options.expectedStatuses || [[200, 299]];
    const expected = expectedStatuses.some(range => {
        if (Array.isArray(range)) return res.statusCode >= range[0] && res.statusCode <= range[1];
        return res.statusCode === range;
    });
    return {
        name,
        url,
        httpStatus: res.statusCode,
        durationMs: res.durationMs,
        error: res.error,
        expectedStatus: expected
    };
}

async function collectLatencyProbes(publicBaseUrls = config.publicBaseUrls || {}) {
    if (args['skip-latency-probes']) return [];
    const urls = publicBaseUrls || {};
    const serviceProviderTls = readCertificateRole('serviceProvider', 'mtls');
    const hoTargets = Object.entries(urls.healthOrganizations || {});
    const probes = await Promise.all([
        latencyProbe('pcm-oauth-metadata-mtls', urls.pcmMetadata ? `${urls.pcmMetadata}/.well-known/oauth-authorization-server` : null, { timeout: latencyProbeTimeoutMs, tls: serviceProviderTls }),
        latencyProbe('pcm-fhir-capability-mtls', urls.pcmApi ? `${urls.pcmApi}/metadata` : null, { timeout: latencyProbeTimeoutMs, tls: serviceProviderTls }),
        ...hoTargets.map(([hoId, base]) => latencyProbe(`${hoId}-observation-without-token`, `${base}/Observation`, {
            expectedStatuses: (effectivePolicy.simulation.perSource[hoId] || effectivePolicy.simulation.controls).oauthBearer
                ? [401, 403]
                : [[200, 299]],
            timeout: latencyProbeTimeoutMs,
            tls: serviceProviderTls
        }))
    ]);
    return probes.filter(Boolean);
}

/**
 * Poll admin consents until the consent created for this run is visible.
 * @returns {Promise<object|null>}
 */
async function findCreatedConsent() {
    for (let i = 0; i < 10; i += 1) {
        const res = await request('GET', `${pcmUiBase}/admin/consents`, { headers: adminHeaders() });
        const consents = res.json?.consents || [];
        const consent = consents.find(c => {
            const owner = config.organizations[identity === 'hospital-b' ? 'hospitalBServiceProvider' : 'serviceProvider'].id;
            return consentMatchesOwner(c, selectedPatient, owner);
        });
        if (consent) return consent;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
}

(async () => {
    const checks = [];
    const refDsUrl = new URL(referenceDsBaseUrl);
    let latencyProbes = [];

    const pcmUi = await request('GET', `${pcmUiBase}/healthz`);
    checks.push(check('pcm-ui-health', pcmUi.statusCode >= 200 && pcmUi.statusCode < 300, { httpStatus: pcmUi.statusCode, error: pcmUi.error, durationMs: pcmUi.durationMs }));

    const sp = await request('GET', `${spBase}/healthz`);
    checks.push(check('sp-health', sp.statusCode >= 200 && sp.statusCode < 300, { httpStatus: sp.statusCode, error: sp.error, durationMs: sp.durationMs }));

    const spReset = await request('POST', `${spBase}/reset`, { followUiRedirects: true });
    checks.push(check('sp-reset-runtime-state', spReset.statusCode === 200, { httpStatus: spReset.statusCode, error: spReset.error, durationMs: spReset.durationMs }));

    const ds = await request('GET', referenceDsHealthUrl || `${refDsUrl.origin}/healthz`, {
        tls: { ...readCertificateRole('serviceProvider', 'mtls'),
            rejectUnauthorized: effectivePolicy.transport.serviceProviderToDataSource.verifyServerCertificate }
    });
    checks.push(check('reference-ds-health', ds.statusCode >= 200 && ds.statusCode < 300, { httpStatus: ds.statusCode, error: ds.error, durationMs: ds.durationMs }));

    const adminStatus = await request('GET', `${pcmUiBase}/admin/status`, { headers: adminHeaders() });
    checks.push(check('admin-status-api', adminStatus.statusCode === 200 && adminStatus.json?.config?.teamId, { httpStatus: adminStatus.statusCode, error: adminStatus.error, durationMs: adminStatus.durationMs }));
    checks.push(check('effective-conformance-policy', adminStatus.json?.effectivePolicy?.mode === effectivePolicy.mode, {
        expectedMode: effectivePolicy.mode,
        observedMode: adminStatus.json?.effectivePolicy?.mode,
        compatibilityAdapters: adminStatus.json?.effectivePolicy?.compatibility?.enabledAdapters || []
    }));
    const latencyUrls = useInternalUrls
        ? { pcmApi: pcmApiTransport, pcmMetadata: pcmMetadataTransport, healthOrganizations: healthOrganizationTransportUrls }
        : adminStatus.json?.config?.publicBaseUrls || config.publicBaseUrls;
    latencyProbes = await collectLatencyProbes(latencyUrls);

    const fixtureFacts = await inspectTeamFixtures(config, args['fixture-root'], { privateRunner: Boolean(args['private-fixture-runner']),
        noFixtureSetup: Boolean(args['no-fixture-setup']), ca: fs.readFileSync(path.join(certsDir, config.certificates.rootCaCert)) });
    const verifiedPatients = fixtureFacts.patients;
    if (requestedPatientId) {
        const separator = String(requestedPatientId).indexOf('|');
        const requestedSystem = separator > 0 ? String(requestedPatientId).slice(0, separator) : null;
        const requestedValue = separator > 0 ? String(requestedPatientId).slice(separator + 1) : String(requestedPatientId);
        selectedPatient = verifiedPatients.find(patient => String(patient.idValue) === requestedValue
            && (!requestedSystem || patient.idSystem === requestedSystem)) || null;
    } else {
        selectedPatient = verifiedPatients[0] || null;
    }
    patientId = selectedPatient ? `${selectedPatient.idSystem}|${selectedPatient.idValue}` : '';
    checks.push(check('doctor-private-fixture-prerequisite', !fixtureFacts.sources.some(source => source.state === 'failed')
        && (!requestedPatientId || Boolean(selectedPatient)) && (!args['require-clinical'] || Boolean(selectedPatient)), {
        method: fixtureFacts.method, observedAt: fixtureFacts.observedAt, sources: fixtureFacts.sources.map(({ sourceId, state, reason, sha256 }) => ({ sourceId, state, reason, sha256 })),
        verifiedPatientCount: verifiedPatients.length, selected: Boolean(selectedPatient)
    }));

    const serviceProviderTls = readCertificateRole('serviceProvider', 'mtls');
    const pcmApi = canonicalPcmApi;
    const metadata = await request('GET', `${pcmMetadataTransport}/.well-known/oauth-authorization-server`, { tls: serviceProviderTls });
    checks.push(check('pcm-oauth-metadata-0.4.0', metadata.statusCode === 200
        && metadata.json?.issuer === pcmApi
        && metadata.json?.token_endpoint === `${pcmApi}/token`
        && metadata.json?.introspection_endpoint === `${pcmApi}/introspect`
        && metadata.json?.token_endpoint_auth_methods_supported?.includes('private_key_jwt')
        && metadata.json?.token_endpoint_auth_signing_alg_values_supported?.includes('ES256')
        && !Object.hasOwn(metadata.json || {}, 'jwks_uri'), {
        httpStatus: metadata.statusCode,
        issuer: metadata.json?.issuer,
        hasPublicJwks: Object.hasOwn(metadata.json || {}, 'jwks_uri')
    }));

    const missingCertificate = await request('GET', `${pcmApiTransport}/metadata`, { tls: { ca: serviceProviderTls.ca, rejectUnauthorized: true } });
    const untrustedTls = {
        cert: fs.readFileSync(path.join(certsDir, config.certificateRoles.untrustedClient.mtls.cert)),
        key: fs.readFileSync(path.join(certsDir, config.certificateRoles.untrustedClient.mtls.key)),
        ca: serviceProviderTls.ca,
        rejectUnauthorized: true
    };
    const untrustedCertificate = await request('GET', `${pcmApiTransport}/metadata`, { tls: untrustedTls });
    if (config.security.pcmApi.clientAuth === 'mtls') {
        checks.push(check('pcm-mtls-missing-certificate-denied', backendMtlsDenied(missingCertificate), { transportDenied: Boolean(missingCertificate.error), httpStatus: missingCertificate.statusCode }));
        checks.push(check('pcm-mtls-untrusted-certificate-denied', backendMtlsDenied(untrustedCertificate), { transportDenied: Boolean(untrustedCertificate.error), httpStatus: untrustedCertificate.statusCode }));
    }

    const spClientId = config.organizations.serviceProvider.clientId;
    const managementResource = config.contract.operational.fhirBase;
    const management = await issueClientCredentials('serviceProvider', spClientId, managementResource, 'system/*.crus');
    const expectedTokenLifetime = config.security.pcmApi.accessTokenExpiresInSeconds;
    checks.push(check('oauth-management-token-configured-lifetime', management.statusCode === 200
        && typeof management.json?.access_token === 'string'
        && management.json?.token_type === 'Bearer'
        && management.json?.expires_in === expectedTokenLifetime
        && management.json?.scope === 'system/*.crus', {
        httpStatus: management.statusCode,
        tokenType: management.json?.token_type,
        expiresIn: management.json?.expires_in,
        expectedExpiresIn: expectedTokenLifetime,
        scope: management.json?.scope
    }));
    if (management.json?.access_token) {
        // Unknown FHIR routes are protected by bearer authentication before routing.
        const pcmJwks = await request('GET', `${pcmApiTransport}/.well-known/jwks.json`, {
            tls: serviceProviderTls, headers: { Authorization: `Bearer ${management.json.access_token}` }
        });
        checks.push(check('pcm-public-jwks-absent', jwksIsAbsent(pcmJwks), { httpStatus: pcmJwks.statusCode, error: pcmJwks.error }));
        const ho = config.healthOrganizations[0];
        const introspectionUrl = `${pcmApi}/introspect`;
        const introspection = await request('POST', `${pcmApiTransport}/introspect`, {
            tls: {
                cert: fs.readFileSync(path.join(certsDir, ho.certificates.gatewayMtlsCert)),
                key: fs.readFileSync(path.join(certsDir, ho.certificates.gatewayMtlsKey)),
                ca: serviceProviderTls.ca,
                rejectUnauthorized: true
            },
            form: {
                token: management.json.access_token,
                token_type_hint: 'access_token',
                client_assertion_type: assertionType,
                client_assertion: assertion(ho.clientId, `${pcmApi}/introspect`, `healthOrganization:${ho.id}`)
            }
        });
        checks.push(check('oauth-direct-introspection-closed-response', introspection.statusCode === 200
            && typeof introspection.json?.active === 'boolean', {
            httpStatus: introspection.statusCode,
            error: introspection.error,
            active: introspection.json?.active
        }));
    }

    for (const ho of config.healthOrganizations) {
        const requestBase = healthOrganizationTransportUrls[ho.id];
        const resource = ho.endpoint;
        const serverPatient = verifiedPatients.find(patient => patient.sources?.some(source => source.serverId === ho.clinicalData.serverId));
        const readiness = await request('GET', `${requestBase.replace(/\/fhir\/?$/, '')}/healthz`, {
            tls: { ...readCertificateRole('serviceProvider', 'mtls'), rejectUnauthorized:
                effectivePolicy.simulation.perSource[ho.id]?.serverCertificateVerification ?? effectivePolicy.simulation.controls.serverCertificateVerification }
        });
        checks.push(check(`${ho.id}-gateway-readiness`, readiness.statusCode === 200,
            { httpStatus: readiness.statusCode, error: readiness.error }));
        const actualState = serverPatient ? null : await request('GET', `${pcmUiBase}/admin/api/fhir-servers/${ho.clinicalData.serverId}/data`, {
            headers: adminHeaders(), timeout: 180000
        });
        const prerequisite = presencePrerequisite(serverPatient, actualState);
        if (prerequisite.expectedTotal === undefined) {
            checks.push({ name: `${ho.id}-online-presence-count-only`, status: 'incomplete', ...prerequisite });
            continue;
        }
        const presenceIdentifier = prerequisite.identifier;
        if (!presenceIsConfigured(config, presenceIdentifier)) {
            checks.push(check(`${ho.id}-presence-explicit-eligibility`, !args['require-clinical'], {
                executed: false, state: 'unconfigured', reason: 'This identity has no explicit source-presence eligibility. Ordinary smoke does not provision it.'
            }));
            continue;
        }
        const presenceClientId = config.oauthClients.presenceOrchestrator.clientId;
        const presence = await issueClientCredentials(
            'presenceOrchestrator',
            presenceClientId,
            resource,
            'system/Patient.s',
            presenceAuthorizationDetails(presenceIdentifier)
        );
        let total;
        let presenceStatus;
        let directActive;
        if (presence.statusCode === 200 && presence.json?.access_token) {
            const introspectionUrl = `${pcmApi}/introspect`;
            const direct = await request('POST', `${pcmApiTransport}/introspect`, {
                tls: {
                    cert: fs.readFileSync(path.join(certsDir, ho.certificates.gatewayMtlsCert)),
                    key: fs.readFileSync(path.join(certsDir, ho.certificates.gatewayMtlsKey)),
                    ca: serviceProviderTls.ca,
                    rejectUnauthorized: true
                },
                form: {
                    token: presence.json.access_token,
                    token_type_hint: 'access_token',
                    client_assertion_type: assertionType,
                    client_assertion: assertion(ho.clientId, `${pcmApi}/introspect`, `healthOrganization:${ho.id}`)
                }
            });
            directActive = direct.json?.active;
            const query = encodeURIComponent(presenceIdentifier);
            const response = await request('GET', `${requestBase}/Patient?identifier=${query}&_summary=count&_count=0`, {
                tls: readCertificateRole('presenceOrchestrator', 'mtls'),
                headers: { Authorization: `Bearer ${presence.json.access_token}`, Accept: 'application/fhir+json' }
            });
            presenceStatus = response.statusCode;
            total = response.json?.total;
        }
        const expectedTotal = prerequisite.expectedTotal;
        checks.push(check(`${ho.id}-online-presence-count-only`, presence.statusCode === 200 && directActive === true && presenceStatus === 200 && total === expectedTotal, {
            tokenHttpStatus: presence.statusCode,
            directIntrospectionActive: directActive,
            presenceHttpStatus: presenceStatus,
            total,
            expectedTotal,
            verifiedBundlePatient: Boolean(serverPatient)
        }));
    }

    if (selectedPatient) {
        const composer = await request('GET', `${spBase}/?identity=${encodeURIComponent(identity)}`);
        if (composer.statusCode !== 200) throw new Error('Current Doctor composer could not be read');
        const selection = doctorServiceSelection(composer.body, config, identity);
        const create = await request('POST', `${spBase}/create-consent`, { followUiRedirects: true,
            form: { identity, patientId, ...selection } });
        checks.push(check('client-create-consent-request', doctorConsentCreated(create), { httpStatus: create.statusCode, error: create.error, durationMs: create.durationMs }));

        const consent = await findCreatedConsent();
        checks.push(check('admin-list-created-consent', Boolean(consent?.id), { consentId: consent?.id, consentStatus: consent?.status }));

        if (consent?.id) {
        // Synthetic HTEST patients are auto-approved by the authoritative
        // Consent lifecycle. Only invoke the manual transition when the
        // created request is still pending; both paths prove active state.
        if (consent.status === 'active') {
            checks.push(check('admin-approve-consent-api', true, { alreadyActive: true }));
        } else {
            const approve = await request('POST', `${pcmUiBase}/admin/consents/${consent.id}/approve`, { headers: adminHeaders(),
                json: { expectedVersion: consent.meta.versionId, scopeChoice: 'service-provided' } });
            checks.push(check('admin-approve-consent-api', approve.statusCode === 200 && approve.json?.consent?.status === 'active', { httpStatus: approve.statusCode, durationMs: approve.durationMs }));
        }

        const discover = await request('POST', `${spBase}/discover`, { followUiRedirects: true, form: { identity, consentId: consent.id } });
        checks.push(check('client-discover-sources', discover.statusCode === 200 && /Discovery Complete|active|Endpoint/.test(discover.body), { httpStatus: discover.statusCode, durationMs: discover.durationMs }));

        const query = doctorConsentQuery(discover.body, identity, consent.id);
        const fetch = await request('POST', `${spBase}/fetch-data`, {
            form: { identity, consentId: consent.id, ...query },
            headers: { Accept: 'application/json' },
            timeout: fetchTimeoutMs
        });
        checks.push(check('client-fetch-data-with-access-token', fetch.statusCode === 200 && fetch.json?.status === 'success' && hasPositiveObservation(fetch.json?.data), {
            httpStatus: fetch.statusCode,
            error: fetch.error,
            durationMs: fetch.durationMs,
            responseStatus: fetch.json?.status,
            responseError: fetch.json?.error,
            resourceType: fetch.json?.data?.resourceType
        }));
        }
    } else {
        checks.push(check('doctor-flow-not-applicable-without-verified-fixture', !args['require-clinical'], {
            reason: 'No selected fixture has been verified on its named source.'
        }));
    }

    const logs = await request('GET', `${pcmUiBase}/admin/logs`, { headers: adminHeaders() });
    checks.push(check('admin-logs-api', logs.statusCode === 200 && logs.json?.logs && typeof logs.json.logs === 'object', { httpStatus: logs.statusCode, error: logs.error, durationMs: logs.durationMs }));

    const backup = await request('GET', `${pcmUiBase}/admin/backup`, { headers: adminHeaders() });
    checks.push(check('admin-backup-api', backup.statusCode === 200 && backup.json?.teamConfig && backup.json?.certificates, { httpStatus: backup.statusCode, error: backup.error, durationMs: backup.durationMs }));

    const status = checks.some(result => result.status === 'fail') ? 'fail'
        : checks.some(result => result.status === 'incomplete') ? 'incomplete' : 'pass';
    const report = {
        coverage: args['require-clinical'] ? 'required-clinical' : 'ordinary-smoke',
        teamId: config.teamId,
        target: args.target || 'reference-ds',
        identity,
        patientIdHash: patientId ? crypto.createHash('sha256').update(String(patientId)).digest('hex').slice(0, 16) : null,
        status,
        effectivePolicy: effectivePolicyReport(effectivePolicy),
        resultLabel: effectivePolicy.resultLabel,
        latencyProbes,
        checks
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
        const outputPath = path.resolve(args.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, serialized, { mode: 0o600 });
    }
    console.log(serialized.trimEnd());
    process.exit(status === 'pass' ? 0 : 1);
})();
