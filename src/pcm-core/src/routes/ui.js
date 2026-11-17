const { browserNavigation, browserDestination, applicationPath } = require('../../../shared/browser-navigation');
/**
 * PCM internal UI routes (dashboard and consent approvals).
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('../fhir/store');
const { tokens } = require('../store');
const bootstrap = require('../bootstrap');
const { getEffectiveConformancePolicy, loadTeamConfig, saveTeamConfig, markRuntimeChange, markCertificateChange } = require('../team-config');
const { certToX5tS256 } = require('../crypto');
const { publishFiles } = require('../../../shared/role-credentials');
const { prepareSourceCredentials, validateServerCa } = require('../source-credentials');
const sourceRegistration = require('../source-registration-command');
const { isTestAutoApproved, relaxedConsentSources } = require('../../../shared/consent-presentation');
const { clearConfiguredLogs } = require('../log-clear');
const { businessIdentifierStorageKey, cleanLocalSubject, parseBusinessIdentifier } = require('../../../shared/identity-mapping');
const logger = require('../logger');
const { diagnoseDataSource } = require('../data-source-readiness');
const { EXTENSIONS } = require('../../../shared/pcm-contract');
const {
    consentServiceId,
    approveConsent: approveConsentLifecycle,
    rejectConsent: rejectConsentLifecycle
} = require('../fhir/consent-lifecycle');
const { POLICY_VERSION, PRESETS, SIMULATION_CONTROLS, effectivePolicyReport, presetSimulationDefaults, presetSourceDefaults, sourceSimulationControls } = require('../../../shared/conformance-policy');
const { guardedFetch, parseOutboundUrl } = require('../../../shared/outbound-destination');
const { sanitizeLogMessage } = require('../../../shared/log-policy');
const { configuredLogComponents } = require('../log-ordering');
const { operationSummary, requestFailure } = require('../../../shared/ui/admin-feedback');
const { DataOperationRegistry, confirmationToken, latestVerifiedLoad, managedFhirServers, requireManagedFhirServer } = require('../data-operations');
const { clinicalDeadlines, deadlineFetch } = require(fs.existsSync('/clinical-data/deadlines.js') ? '/clinical-data/deadlines' : '../../../../clinical-data/deadlines');
const { formatByteLimit } = require('../../../shared/clinical-import-limits');
const {
    getConfiguredDataSources,
    newDataSourceConfig,
    syncDataSourcesToStore
} = require('../data-sources');
const { approvalScopeOptions, approvedScopeOrigin, approvalReview } = require('../approval-scopes');

const sourceChanges = require('../fhir/sandbox-source-change');
const { consentStatus } = require('../../../shared/consent-status');
const cancellation = require('../consent-cancellation');
const sourceCommand = require('../sandbox-source-command');

const EXT_PCM_SERVICE = EXTENSIONS.pcmService;
const SHARED_LOGS_DIR = process.env.SHARED_LOGS_DIR || path.join(process.cwd(), 'shared-logs');
const TEAM_CONFIG_PATH = process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json';
const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';
const SANITY_SCRIPT = process.env.SANITY_SCRIPT || '/workspace/pcm-connectathon/scripts/run-sanity-check.js';
const ADMIN_SANITY_TIMEOUT_MS = Number(process.env.ADMIN_SANITY_TIMEOUT_MS || 55000);
const CERT_FILES = [
    'rootCA.crt',
    'pcm-core.crt',
    'pcm-core.key',
    'sp-client.crt',
    'sp-client.key',
    'sp-client-assertion.crt',
    'sp-client-assertion.key',
    'hospital-b-sp.crt',
    'hospital-b-sp.key',
    'hospital-b-sp-assertion.crt',
    'hospital-b-sp-assertion.key',
    'ds-gateway.crt',
    'ds-gateway.key',
    'ds-gateway-assertion.crt',
    'ds-gateway-assertion.key',
    'ds-fhir-server.crt',
    'ds-fhir-server.key',
    'untrusted-client.crt',
    'untrusted-client.key'
];

const CONNECTATHON_REPO_URL = 'https://github.com/8400TheHealthNetwork/PCM-Connect';
let lastSanityResult = null;
let dataOperationRegistry;

const getDataOperationRegistry = () => {
    dataOperationRegistry ||= new DataOperationRegistry();
    return dataOperationRegistry;
};

/** Build the protected Admin inventory from the latest verified operation per managed server. */
const verifiedPatientInventory = () => {
    const registry = getDataOperationRegistry();
    const verified = managedFhirServers(loadTeamConfig()).flatMap(server => {
        const operation = latestVerifiedLoad(registry, server.id);
        return Array.isArray(operation?.patients)
            ? operation.patients.map(patient => ({ ...patient, serverId: server.id, source: operation.source }))
            : [];
    });
    const merged = new Map();
    for (const patient of verified) {
        const key = `${patient.idSystem}|${patient.idValue}`;
        const current = merged.get(key) || { idSystem: patient.idSystem, idValue: patient.idValue, display: patient.display, sources: [] };
        current.sources.push({ serverId: patient.serverId, source: patient.source });
        merged.set(key, current);
    }
    return [...merged.values()];
};

const loadTransactionBundleContract = () => {
    for (const candidate of [path.resolve(__dirname, '../../../../clinical-data/transaction-bundle'), '/clinical-data/transaction-bundle']) {
        try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    throw new Error('clinical transaction-bundle contract is unavailable');
};

const privateImportHeaders = ho => {
    const credential = process.env[ho.import.credentialEnv];
    if (!credential || credential.length < 32) throw new Error(`${ho.import.credentialEnv} is unavailable to the private maintenance boundary`);
    return { Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json', 'X-PCM-Import-Credential': credential };
};

/** Emit operation-scoped diagnostics through the shared AWS-safe logger. */
const logImportDiagnostic = (operation, stage, level = 'info', details = {}) => {
    const config = loadTeamConfig();
    let target;
    try { target = operation.targetIdentity ? JSON.parse(operation.targetIdentity) : config.healthOrganizations.find(ho => ho.clinicalData?.serverId === operation.serverId); }
    catch { /* A malformed captured identity is unavailable, never replaced by another source. */ }
    logger[level](`IMPORT_${stage.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, {
        type: 'IMPORT_DIAGNOSTIC', category: 'admin', visibility: 'diagnostic',
        actor: process.env.TEAM_ADMIN_PASSWORD ? 'team-admin' : 'sandbox-operator', teamId: config.teamId,
        revision: Number(config.runtime.revision) || 0,
        operationId: operation.id, serverId: operation.serverId, sourceId: target?.dataSourceOrganization?.id, stage, ...details
    });
};

const privateFetch = (url, init = {}) => deadlineFetch(guardedFetch, clinicalDeadlines())(url, init);
const activeDataOperations = new Set();

const privateDataState = (ho, options = {}) => loadTransactionBundleContract().readPrivateDataState({
    endpoint: ho.clinicalData.privateFhirBaseUrl, headers: privateImportHeaders(ho), fetchImpl: privateFetch, ...options
});

const loadClinicalWorkflow = () => require(fs.existsSync('/clinical-data/workflow.js')
    ? '/clinical-data/workflow' : '../../../../clinical-data/workflow');

/** Run Admin maintenance through the same owned lifecycle as the CLI loader. */
const executeQueuedDataOperation = async operation => {
    activeDataOperations.add(operation.id);
    const registry = getDataOperationRegistry();
    const workflow = loadClinicalWorkflow();
    const upload = path.join(process.env.STATE_DIR || '/runtime/state', 'data-uploads', `${operation.id}.json`);
    try {
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, operation.serverId);
        const ho = config.healthOrganizations.find(item => item.id === server.healthOrganizationId);
        if (operation.targetIdentity !== JSON.stringify(ho)) throw new Error('managed target configuration changed; resubmit after review');
        const endpoint = ho.clinicalData.privateFhirBaseUrl;
        const headers = privateImportHeaders(ho);
        await workflow.executeOperation({ registry, operation,
            buffer: operation.kind === 'reset' ? undefined : fs.readFileSync(upload),
            limits: server.limits, endpoint, headers, fetchImpl: guardedFetch,
            onDiagnostic: (stage, level, details) => logImportDiagnostic(operation, stage, level, details),
            legacyStateDir: path.join(process.env.STATE_DIR || '/runtime/state', 'import', ho.import.stateNamespace),
            bundleName: operation.bundleName,
            reset: async () => {
                registry.transition(operation.id, 'resetting', { mutationSubmitted: true, inventoryInvalidated: true });
                await workflow.parseFhirResponse(await privateFetch(`${endpoint}/$expunge`, {
                    method: 'POST', headers: { ...headers, 'X-PCM-Operation-Id': operation.id }, body: JSON.stringify({ resourceType: 'Parameters', parameter: [
                        { name: 'expungeDeletedResources', valueBoolean: true },
                        { name: 'expungePreviousVersions', valueBoolean: true },
                        { name: 'expungeEverything', valueBoolean: true }
                    ] })
                }));
            },
            cleanup: async () => { if (operation.kind !== 'reset') fs.unlinkSync(upload); }
        });
    } catch (error) {
        workflow.failOperation(registry, operation, new Error(sanitizeLogMessage(error.message)));
        logImportDiagnostic(operation, error.clinicalFailureStage || 'failed', 'error', {
            error: sanitizeLogMessage(error.message), timeout: Boolean(error.clinicalDeadlineMs),
            deadlineMs: error.clinicalDeadlineMs || null
        });
    } finally { activeDataOperations.delete(operation.id); }
};

const DEPLOYMENT_ENDPOINT_LABELS = {
    spClient: "Doctor's Portal",
    pcmUi: 'PCM Admin/UI',
    pcmApi: 'PCM FHIR/OAuth API',
    pcmMetadata: 'PCM OAuth metadata',
    referenceDataSource: 'Reference Data Source FHIR',
    dataSourceMetadata: 'Reference Data Source metadata',
    teamDataSource: 'Team Data Source FHIR',
    pcmAuth: 'Internal PCM auth/API',
    pcmFhir: 'Internal PCM FHIR',
    dsAuthAdapter: 'Internal DS Auth Adapter',
    dsFhirServer: 'Internal DS FHIR Server'
};

const listCertificateFiles = () => {
    const files = new Set(CERT_FILES);
    const walk = (dir, prefix = '') => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath, relative);
            } else if (/\.(crt|key|pem)$/.test(entry.name)) {
                files.add(relative);
            }
        }
    };
    walk(CERTS_DIR);
    return [...files].sort();
};

const safeCertFilePath = fileName => {
    const normalized = path.posix.normalize(String(fileName || '').replace(/\\/g, '/'));
    if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || path.isAbsolute(normalized)) {
        throw new Error('invalid certificate file path');
    }
    return path.join(CERTS_DIR, normalized);
};

const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const parseUrlParts = value => {
    try {
        const parsed = new URL(value);
        const defaultPort = parsed.protocol === 'https:' ? '443' : (parsed.protocol === 'http:' ? '80' : '');
        return {
            scheme: parsed.protocol.replace(/:$/, ''),
            host: parsed.hostname,
            port: parsed.port || defaultPort,
            path: parsed.pathname,
            explicitPort: parsed.port || ''
        };
    } catch (err) {
        return { scheme: '', host: '', port: '', path: '', explicitPort: '' };
    }
};


const getPublicBaseUrls = () => {
    const urls = loadTeamConfig().publicBaseUrls || {};
    return {
        spClient: urls.spClient || 'http://localhost:3000',
        pcmUi: urls.pcmUi || 'http://localhost:4000',
        pcmApi: urls.pcmApi || 'https://localhost:4001',
        pcmMetadata: urls.pcmMetadata || process.env.PUBLIC_PCM_METADATA_URL || '',
        referenceDataSource: urls.referenceDataSource || 'https://localhost:8080/fhir',
        dataSourceMetadata: urls.dataSourceMetadata || process.env.PUBLIC_DS_METADATA_URL || 'https://localhost:8080',
        teamDataSource: urls.teamDataSource || ''
    };
};

const inferDeploymentUrl = (key, publicUrls) => {
    if (publicUrls[key]) return publicUrls[key];
    if (key === 'pcmMetadata' && publicUrls.pcmApi) {
        const parsed = parseUrlParts(publicUrls.pcmApi);
        if (parsed.host === 'localhost' && parsed.port) {
            const metadataPort = process.env.PCM_METADATA_PORT || String(Number(parsed.port) + 1);
            return `${parsed.scheme || 'https'}://${parsed.host}:${metadataPort}`;
        }
    }
    if (key === 'dataSourceMetadata' && publicUrls.referenceDataSource) {
        return publicUrls.referenceDataSource.replace(/\/fhir\/?$/, '');
    }
    return '';
};

const buildDeploymentEndpoints = req => {
    const config = loadTeamConfig();
    const policy = getEffectiveConformancePolicy(config);
    const publicUrls = getPublicBaseUrls();
    const publicKeys = ['spClient', 'pcmUi', 'pcmApi', 'pcmMetadata', 'referenceDataSource', 'dataSourceMetadata', 'teamDataSource'];
    const internalKeys = ['pcmAuth', 'pcmFhir', 'referenceDataSource', 'dsAuthAdapter', 'dsFhirServer'];
    const endpoints = [];

    for (const key of publicKeys) {
        const configuredUrl = inferDeploymentUrl(key, publicUrls);
        if (!configuredUrl) continue;
        endpoints.push({
            key,
            label: DEPLOYMENT_ENDPOINT_LABELS[key] || key,
            audience: 'public',
            source: 'team-config',
            url: configuredUrl,
            ...parseUrlParts(configuredUrl)
        });
    }

    for (const key of internalKeys) {
        const configuredUrl = config.internalBaseUrls?.[key];
        if (!configuredUrl) continue;
        endpoints.push({
            key,
            label: DEPLOYMENT_ENDPOINT_LABELS[key] || key,
            audience: 'internal',
            source: 'team-config',
            url: configuredUrl,
            ...parseUrlParts(configuredUrl)
        });
    }

    for (const ho of config.healthOrganizations || []) {
        const additions = [
            { key: `${ho.id}GatewayPublic`, label: `${ho.name} public gateway`, audience: 'public', url: config.publicBaseUrls?.healthOrganizations?.[ho.id], source: 'team-config' },
            { key: `${ho.id}GatewayInternal`, label: `${ho.name} internal gateway`, audience: 'internal', url: config.internalBaseUrls?.healthOrganizations?.[ho.id] || ho.endpoint, source: 'team-config' },
            { key: `${ho.id}AdapterInternal`, label: `${ho.name} auth adapter`, audience: 'internal', url: `http://${ho.id}-adapter:3000`, source: 'derived-service' },
            { key: `${ho.id}HapiInternal`, label: `${ho.name} private HAPI`, audience: 'internal', url: ho.clinicalData?.privateFhirBaseUrl, source: 'team-config' }
        ];
        for (const endpoint of additions.filter(item => item.url)) endpoints.push({ ...endpoint, ...parseUrlParts(endpoint.url) });
    }
    if (config.legacyDataSource) {
        for (const endpoint of [
            { key: 'legacyGatewayPublic', label: 'Legacy Node DS public gateway', audience: 'public', url: config.legacyDataSource.publicFhirBaseUrl, source: 'team-config' },
            { key: 'legacyGatewayInternal', label: 'Legacy Node DS internal gateway', audience: 'internal', url: config.legacyDataSource.internalFhirBaseUrl, source: 'team-config' },
            { key: 'legacyAdapterInternal', label: 'Legacy Node DS auth adapter', audience: 'internal', url: 'http://ds-auth-adapter:3000', source: 'derived-service' },
            { key: 'legacyFhirInternal', label: 'Legacy Node FHIR facade', audience: 'internal', url: config.internalBaseUrls?.dsFhirServer, source: 'team-config' }
        ].filter(item => item.url)) endpoints.push({ ...endpoint, ...parseUrlParts(endpoint.url) });
    }

    for (const source of config.organizations?.dataSources || []) {
        if (source.endpoint) endpoints.push({ key: `custom:${source.id}`, sourceId: source.id,
            label: source.name || source.id, audience: 'public', source: 'team-config',
            url: source.endpoint, ...parseUrlParts(source.endpoint) });
    }
    return endpoints.map(endpoint => {
        const legacy = endpoint.key.startsWith('legacy') || ['referenceDataSource', 'dataSourceMetadata', 'dsAuthAdapter', 'dsFhirServer'].includes(endpoint.key);
        const configuredSource = endpoint.sourceId ? (config.organizations?.dataSources || []).find(item => item.id === endpoint.sourceId)
            : (config.healthOrganizations || []).find(item => endpoint.key.startsWith(item.id));
        const enabled = configuredSource ? configuredSource.enabled !== false : endpoint.key === 'teamDataSource' ? config.organizations?.teamDataSource?.enabled !== false
            : legacy ? config.legacyDataSource?.enabled !== false : true;
        let diagnosticUrl = null;
        let diagnosticLabel = null;
        if (enabled && endpoint.audience === 'public') {
            const base = endpoint.url.replace(/\/+$/, '');
            if (endpoint.key === 'spClient' || endpoint.key === 'pcmUi') {
                diagnosticUrl = endpoint.key === 'pcmUi' ? `${base}/ui` : `${base}/`;
                diagnosticLabel = 'Open application';
            } else if (endpoint.key === 'pcmApi') {
                diagnosticUrl = `${base}/metadata`;
                diagnosticLabel = 'FHIR capability (client certificate when required)';
            } else if (endpoint.key === 'pcmMetadata') {
                diagnosticUrl = `${base}/.well-known/oauth-authorization-server`;
                diagnosticLabel = 'OAuth metadata (client certificate when required)';
            } else if (endpoint.key === 'dataSourceMetadata') {
                // Old generated teams stored the HTTPS FHIR listener here. Do not advertise that as metadata.
                const legacyBase = config.legacyDataSource?.publicFhirBaseUrl?.replace(/\/fhir\/?$/, '');
                if (base !== legacyBase) {
                    diagnosticUrl = `${base}/.well-known/oauth-authorization-server`;
                    diagnosticLabel = 'Legacy HTTP OAuth metadata';
                }
            } else if (endpoint.key === 'referenceDataSource' || endpoint.key.endsWith('GatewayPublic')) {
                // Known gateway routes share the declared proxy prefix before /fhir.
                const gateway = new URL(base);
                if (/\/fhir$/.test(gateway.pathname) && !gateway.search && !gateway.hash) {
                    gateway.pathname = gateway.pathname.replace(/\/fhir$/, '/healthz');
                    diagnosticUrl = gateway.toString();
                    diagnosticLabel = 'Gateway health (client certificate when required)';
                }
            }
        }
        if (diagnosticUrl && endpoint.audience === 'public') diagnosticUrl = browserDestination(diagnosticUrl, req);
        const isApi = ['pcmApi', 'pcmAuth', 'pcmFhir', 'pcmMetadata'].includes(endpoint.key);
        const gateway = endpoint.key.endsWith('GatewayPublic') || endpoint.key.endsWith('GatewayInternal') || endpoint.key === 'referenceDataSource' || endpoint.key.startsWith('custom:');
        const control = configuredSource ? sourceSimulationControls(policy, config, { resource: configuredSource.endpoint }) : null;
        const mtls = isApi ? config.security.pcmApi.clientAuth === 'mtls'
            : gateway ? (control?.publicClientMtls ?? policy.simulation.controls.publicClientMtls) : false;
        const transport = endpoint.scheme === 'https' ? (mtls ? 'TLS + client certificate (mTLS)' : 'TLS') : 'HTTP — no TLS';
        return { ...endpoint, enabled, diagnosticUrl, diagnosticLabel, transport };
    });
};

/**
 * Render the consent dashboard view.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
/** Resolve a known browser route under the configured PCM UI mount. */
const uiUrl = route => applicationPath(loadTeamConfig().publicBaseUrls.pcmUi, route);

const renderDashboard = (req, res) => {
    const enrichedConsents = listEnrichedConsents();
    const config = loadTeamConfig();

    res.render('dashboard', { consents: enrichedConsents, publicBaseUrls: browserNavigation(getPublicBaseUrls(), req, 'pcmUi'), workflowUrl: require('../../../shared/browser-navigation').pcmWorkflowUrl(config, req), teamId: config.teamId, relaxedSources: relaxedConsentSources(getEffectiveConformancePolicy(config)) });
};

/**
 * Return consent resources with display fields needed by the UI/API.
 * @returns {object[]}
 */
const listEnrichedConsents = () => {
    const allConsents = store.getAll('Consent');

    const enrichedConsents = allConsents.map(c => {
        let requesterName = 'Unknown';
        let parentOrgName = 'Unknown';
        let serviceName = 'Unknown';

        const actors = c.provision?.actor || [];
        const requestorActor = actors.find(a => a.role?.coding?.some(code => code.code === 'IRCP'));

        if (requestorActor && requestorActor.reference) {
            requesterName = requestorActor.reference.display || 'Unknown';
            const orgId = requestorActor.reference.reference?.split('/').pop();
            const org = store.get('Organization', orgId);

            if (org && org.partOf && org.partOf.reference) {
                const parentId = org.partOf.reference.split('/').pop();
                const parent = store.get('Organization', parentId);
                if (parent) parentOrgName = parent.name;
            }
        }

        const serviceExt = c.extension?.find(e => e.url === EXT_PCM_SERVICE);
        if (serviceExt && serviceExt.valueReference) {
            const svcId = serviceExt.valueReference.reference?.split('/').pop();
            const svc = store.get('HealthcareService', svcId);
            if (svc) serviceName = svc.name;
        }

        return {
            ...c,
            lifecycle: consentStatus(c, Date.now(), store.privateRecords.lifecycle.getEvents('Consent', c.id)),
            testAutoApproved: isTestAutoApproved(c),
            requesterName,
            parentOrgName,
            serviceName
        };
    });

    enrichedConsents.sort((a, b) => (a.status === 'proposed' ? -1 : 1));

    return enrichedConsents;
};

/**
 * Render the approval page for a single consent.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const renderApproval = (req, res) => {
    const failedReview = res.locals.approvalFailure;
    const consent = store.get('Consent', req.params.id);
    if (!consent) return res.status(404).send('Not Found');

    let requesterName = 'Unknown';
    let serviceName = 'Unknown';

    const actors = consent.provision?.actor || [];
    const requestorActor = actors.find(a => a.role?.coding?.some(code => code.code === 'IRCP'));
    if (requestorActor && requestorActor.reference) {
        requesterName = requestorActor.reference.display || 'Unknown';
    }

    const serviceExt = consent.extension?.find(e => e.url === EXT_PCM_SERVICE);
    if (serviceExt && serviceExt.valueReference) {
        const svcId = serviceExt.valueReference.reference?.split('/').pop();
        const svc = store.get('HealthcareService', svcId);
        if (svc) serviceName = svc.name;
    }

    const selectedSourceIds = new Set((consent.provision?.actor || [])
        .filter(actor => actor.role?.coding?.some(code => code.code === 'CST'))
        .map(actor => actor.reference?.reference?.split('/').pop())
        .filter(Boolean));

    const draftSources = failedReview && consent.status === 'proposed' ? new Set(failedReview.sourceIds) : null;
    const dataSources = getConfiguredDataSources(loadTeamConfig())
        .map(source => ({
            ...source,
            selected: draftSources ? draftSources.has(source.id)
                : (['proposed', 'draft'].includes(consent.status) && selectedSourceIds.size === 0) || selectedSourceIds.has(source.id)
        }));

    const config = loadTeamConfig();
    const service = store.get('HealthcareService', consentServiceId(consent));
    let grantSummary;
    try { grantSummary = require('../../../shared/sandbox-grant-policy').clinicalGrantDecision(config, store, service); }
    catch (error) { grantSummary = { fullAccess: false, reason: error.message, unavailable: true }; }
    const approvalDisplay = approvalReview(store, consent);
    const approvalSnapshot = store.privateRecords.approvals.getDecision(consent.id).snapshot || null;
    logger.info('PRIVATE_CONSENT_REVIEW', { visibility: 'diagnostic', component: 'pcm-consents', operation: 'read-private-review', target: `Consent/${consent.id}`, outcome: approvalSnapshot ? 'recorded' : 'unavailable' });
    let scopeOptions = [];
    try { scopeOptions = approvalScopeOptions(store, service, { now: Date.parse(approvalDisplay.anchor) / 1000 }); } catch (_) { /* Unavailable definitions retain custom input and the status notice. */ }
    const serviceScope = scopeOptions[0]?.value ?? '';
    const draftChoice = failedReview?.choice;
    const selectedChoice = consent.status === 'proposed' && ['service-provided', 'auto-resources', 'auto-buckets', 'custom'].includes(draftChoice)
        ? draftChoice : approvalSnapshot?.choice ?? 'service-provided';
    const reviewedScope = selectedChoice === 'custom' ? failedReview?.customScope ?? ''
        : scopeOptions.find(option => option.id === selectedChoice)?.value ?? serviceScope;
    const selectedScope = consent.status === 'proposed' ? reviewedScope : approvalSnapshot?.scope ?? '';
    const scopeOrigin = approvedScopeOrigin(consent, store);
    res.render('consent', {
        consent: { ...consent, testAutoApproved: isTestAutoApproved(consent) },
        dataSources,
        lifecycle: consentStatus(consent, Date.now(), store.privateRecords.lifecycle.getEvents('Consent', consent.id)),
        cancellation: cancellation.cancellationView({ store, config, consent }),
        relaxedSources: relaxedConsentSources(getEffectiveConformancePolicy(config)),
        publicBaseUrls: browserNavigation(getPublicBaseUrls(), req, 'pcmUi'),
        sourceView: sourceChanges.sourceChangeView({ store, config, consent }),
        sourceCsrf: sourceCommand.csrf(consent.id, consent.meta?.versionId),
        requesterName,
        consentPresentation: require('../../../shared/consent-presentation'),
        scopePresentation: require('../../../shared/ui/approval-scopes'),
        requestedDuration: service?.extension?.find(item => item.url === EXTENSIONS.accessDuration)?.valueDuration,
        accessMode: require('../fhir/consent-lifecycle').accessMode(consent),
        serviceId: service?.id || consentServiceId(consent),
        requesterId: requestorActor?.reference?.reference || 'Not recorded',
        servicePurpose: service?.extraDetails || '',
        serviceName,
        scopeOptions,
        approvalDisplay,
        approvalSnapshot,
        approvalError: failedReview?.message || '',
        scopeOrigin,
        selectedChoice,
        grantSummary,
        selectedScope,
        teamId: loadTeamConfig().teamId
    });
};

/** Render authoritative state and the non-secret draft after a refused review command.
 * Fresh version/review proofs require another deliberate submission; nothing retries.
 * @param {import('express').Request} req Refused form request.
 * @param {import('express').Response} res Existing HTML response.
 * @param {number} status Original refusal status.
 * @param {string} message Actionable failure reason.
 * @returns {void} Renders current state without saving the draft.
 */
function approvalFailure(req, res, status, message) {
    const sources = Array.isArray(req.body.sources) ? req.body.sources : typeof req.body.sources === 'string' ? [req.body.sources] : [];
    res.locals.approvalFailure = { message, choice: req.body.scopeChoice,
        customScope: typeof req.body.customScope === 'string' ? req.body.customScope : '', sourceIds: sources };
    res.status(status);
    return renderApproval(req, res);
}

/**
 * Handle approval or rejection for a consent.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const handleApproval = (req, res) => {
    const consent = store.get('Consent', req.params.id);
    if (!consent) return res.status(404).send('Not Found');

    const { action } = req.body;
    if (!['approve', 'decline'].includes(action) || Object.keys(req.body).some(key => !['action', 'sources', 'scopeChoice', 'customScope', 'expectedVersion', 'approvalReview'].includes(key))) return approvalFailure(req, res, 400, 'Invalid approval command. Review the current request before trying again.');
    if (req.body.expectedVersion !== consent.meta?.versionId) return approvalFailure(req, res, 409, 'Consent changed; review the current state and permissions before trying again.');

    try {
        if (action === 'decline') {
            declineConsent(consent);
            return res.redirect(uiUrl('/ui'));
        }
        if (typeof req.body.approvalReview !== 'string') return approvalFailure(req, res, 400, 'Refresh and review approval permissions before trying again.');
        const review = JSON.parse(req.body.approvalReview);
        if (!review || typeof review !== 'object' || Array.isArray(review)) return approvalFailure(req, res, 400, 'Refresh and review approval permissions before trying again.');
        approveConsent(consent, {
            sourceIds: req.body.sources,
            expectedVersion: req.body.expectedVersion,
            review,
            scopeChoice: req.body.scopeChoice,
            customScope: req.body.customScope
        });
        res.redirect(uiUrl('/ui'));
    } catch (err) {
        console.error('Approval Failed', err);
        return approvalFailure(req, res, err.status || 400, 'Approval failed: ' + err.message + ' Review the current state before trying again.');
    }
};

/**
 * Mark a consent as rejected.
 * @param {object} consent
 * @returns {object}
 */
const declineConsent = consent => {
    const rejected = rejectConsentLifecycle({ store, consent });
    console.log(`[UI] Consent ${consent.id} DECLINED.`);
    return rejected;
};

/**
 * Mark a consent as active and attach the selected source actors/scope.
 * @param {object} consent
 * @param {object} options
 * @returns {object}
 */
const approveConsent = (consent, options = {}) => {
    if (!options || Object.keys(options).some(key => !['sourceIds', 'scopeChoice', 'customScope', 'expectedVersion', 'review'].includes(key))) throw Object.assign(new Error('Approval commands accept explicit scope choices and sources only'), { status: 400 });
    const hasExplicitSourceIds = Object.prototype.hasOwnProperty.call(options, 'sourceIds');
    const requestedSourceIds = Array.isArray(options.sourceIds)
        ? options.sourceIds
        : (options.sourceIds ? [options.sourceIds] : []);
    const allowedSources = getConfiguredDataSources(loadTeamConfig());
    const selectedSourceIds = new Set(hasExplicitSourceIds ? requestedSourceIds : allowedSources.map(source => source.id));
    const sources = allowedSources.filter(source => selectedSourceIds.has(source.id));

    if (!sources.length && (!hasExplicitSourceIds || requestedSourceIds.length)) {
        throw new Error('At least one information source must be selected');
    }

    if (requestedSourceIds.some(id => !allowedSources.some(source => source.id === id))) throw Object.assign(new Error('Unknown or unavailable Data Source'), { status: 400 });
    const approved = approveConsentLifecycle({
        store, consent,
        sourceOrganizationIds: sources.map(source => source.id),
        scopeChoice: options.scopeChoice || 'service-provided', customScope: options.customScope,
        expectedVersion: options.expectedVersion ?? consent.meta?.versionId,
        review: options.review,
        actor: { id: process.env.TEAM_ADMIN_PASSWORD ? 'team-admin' : 'sandbox-operator', simulation: true }
    });
    console.log(`[UI] Consent ${consent.id} Approved.`);
    return approved;
};

/** Common header/Explain and local return contract for auxiliary Admin HTML. */
const renderAdminAuxiliary = (req, { title, body, section = 'overview', source = '', view = '', helpKey = 'common.feedback' }) => {
    const config = loadTeamConfig();
    const basePath = applicationPath(config.publicBaseUrls.pcmUi).replace(/\/$/, '');
    const shell = require('./admin-shell');
    return shell.partial('auxiliary', { title, body, helpKey, config, basePath, shell, CONNECTATHON_REPO_URL,
        urls: browserNavigation(getPublicBaseUrls(), req, 'pcmUi'), returnTo: shell.address(basePath, section, source, view) });
};

/**
 * Protect admin APIs with a small shared password when configured.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireAdmin = (req, res, next) => {
    const expected = process.env.TEAM_ADMIN_PASSWORD;
    if (!expected) return next();

    const cookieSession = (req.headers.cookie || '')
        .split(';')
        .map(part => part.trim().split('='))
        .find(([key]) => key === 'teamAdminSession')?.[1];
    const supplied = req.get('x-admin-password') || req.body?.adminPassword;
    const expectedSession = crypto.createHash('sha256').update(`pcm-admin-session:${expected}${require('../migration-checkpoint').sessionEpoch()}`).digest('base64url');
    const decodedSession = cookieSession ? decodeURIComponent(cookieSession) : '';

    if (supplied === expected || decodedSession === expectedSession) {
        if (supplied === expected) {
            res.cookie('teamAdminSession', expectedSession, { httpOnly: true, sameSite: 'strict', path: uiUrl('/admin') });
        }
        return next();
    }

    if (req.get('accept')?.includes('text/html')) {
        const basePath = uiUrl('/').replace(/\/$/, '');
        const shell = require('./admin-shell');
        const state = shell.sectionState(req, getConfiguredDataSources(loadTeamConfig(), { includeDisabled: true }));
        // Preserve the selected certificate owner through the initial login form,
        // using the same bounded return parser as the authenticated submission.
        const returnTo = shell.safeReturn(shell.address(basePath, state.selected, state.source, req.query?.view || '')
            + (typeof req.query?.owner === 'string' ? `&owner=${encodeURIComponent(req.query.owner)}` : ''), basePath);
        return res.status(401).send(renderAdminAuxiliary(req, { title: 'Sign in to Admin', section: state.selected, source: state.source,
            body: `<form method="post" action="${escapeHtml(basePath)}/admin/login" class="admin-login">
              <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
              <label class="form-label" for="adminPassword" data-help-key="admin.password">Admin password</label>
              <input class="form-control mb-3" id="adminPassword" name="adminPassword" type="password" autocomplete="current-password" autofocus data-help-key="admin.password">
              <button class="btn btn-primary" data-help-key="admin.login">Open Admin</button></form>` }));
    }

    return res.status(401).json({
        error: 'Admin authentication is required.',
        help: 'Open /admin in a browser and submit the login form, or send the x-admin-password header for API requests.'
    });
};

/** Preserve the Admin logs map and disclose any source that could not be exported. */
const readAllLogs = () => require('../log-export').readLogExport(SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()));

/** Stage full history asynchronously so export does not block other Admin requests. */
const streamAllLogs = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.path.endsWith('/download')) res.attachment('logs.json');
    return require('../log-export').sendLogExport(req, res, SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig())).catch(next);
};

/** Clear the same current/history scope as the unified operator listener. */
const clearAllLogs = () => clearConfiguredLogs(SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()));

const getCertificateThumbprints = () => {
    const result = {};
    for (const fileName of listCertificateFiles().filter(name => name.endsWith('.crt') || name.endsWith('.pem'))) {
        const filePath = safeCertFilePath(fileName);
        if (!fs.existsSync(filePath)) continue;
        try {
            result[fileName] = certToX5tS256(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            // Skip non-certificate PEM files.
        }
    }
    return result;
};

const readCertificateFiles = () => {
    const result = {};
    for (const fileName of listCertificateFiles()) {
        const filePath = safeCertFilePath(fileName);
        if (fs.existsSync(filePath)) result[fileName] = fs.readFileSync(filePath, 'utf8');
    }
    return result;
};

const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
};

const dosDateTime = date => {
    const year = Math.max(date.getFullYear(), 1980);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
};

const buildZip = files => {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = dosDateTime(new Date());

    for (const [fileName, content] of Object.entries(files)) {
        const name = Buffer.from(fileName);
        const data = Buffer.from(content);
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(now.time, 10);
        local.writeUInt16LE(now.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(now.time, 12);
        central.writeUInt16LE(now.date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, end]);
};

const { DEFAULT_LIMITS } = require('../../../shared/clinical-import-limits');
const { parseMultipartForm, captureMultipartBody: captureBoundedMultipartBody } = require('../multipart');

/** Apply the configured managed-target upload ceiling before decoding Admin multipart forms. */
const captureMultipartBody = (req, res, next) => {
    const limit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(DEFAULT_LIMITS.maxBytes, ...managedFhirServers(loadTeamConfig()).map(server => server.limits.maxBytes)) + 1_048_576);
    return captureBoundedMultipartBody(req, res, next, limit);
};

const getRequestField = (req, name) => {
    if (req.multipart?.fields && Object.prototype.hasOwnProperty.call(req.multipart.fields, name)) {
        return req.multipart.fields[name];
    }
    return req.body?.[name];
};

const getRequestFileContent = (req, name) => req.multipart?.files?.[name]?.content || '';

const mergeMultipartFields = (req, res, next) => {
    if (req.rawBody || req.rawBodyPath) {
        try {
            req.multipart = parseMultipartForm(req);
            req.body = { ...(req.body || {}), ...(req.multipart.fields || {}) };
        } finally {
            req.rawBodyCleanup?.();
            delete req.rawBodyPath;
            delete req.rawBodyCleanup;
        }
    }
    next();
};

const uploadedCertThumbprint = (req, fieldName) => {
    const content = getRequestFileContent(req, fieldName);
    if (!content) return '';
    return certToX5tS256(content);
};

const reusePcmClientCertificateForServerTrust = source => {
    const thumbprint = source.pcmClientAuth?.certThumbprint;
    if (!thumbprint) return false;
    source.serverTrust = source.serverTrust || {};
    source.serverTrust.mode = 'pinned-thumbprint';
    source.serverTrust.certThumbprint = thumbprint;
    source.certThumbprint = thumbprint;
    return true;
};

const buildDataSourceClientBundle = (config, source) => {
    // Retained inactive fields are still export inputs. A CA reference may only
    // expose public CA material; optional missing public certificates stay omitted.
    if (source.serverTrust?.caCert) {
        try { validateServerCa(sourceRegistration.managedCertificate(CERTS_DIR, source.serverTrust.caCert)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const certs = {};
    for (const fileName of ['rootCA.crt', source.pcmClientAuth?.cert, source.pcmClientAuth?.key, source.pcmClientAuth?.mtlsCert, source.pcmClientAuth?.mtlsKey, source.serverTrust?.caCert].filter(Boolean)) {
        const filePath = safeCertFilePath(fileName);
        if (fs.existsSync(filePath)) certs[fileName] = fs.readFileSync(filePath, 'utf8');
    }
    return {
        dataSource: source,
        pcm: {
            issuer: config.contract.operational.oauthBase,
            contractEnvironment: config.contract.environment,
            conformanceExceptions: config.contract.conformanceExceptions,
            tokenEndpoint: `${config.publicBaseUrls?.pcmApi || ''}/token`,
            introspectionEndpoint: `${config.publicBaseUrls?.pcmApi || ''}/introspect`,
            metadataEndpoint: `${config.publicBaseUrls?.pcmMetadata || config.publicBaseUrls?.pcmApi || ''}/.well-known/oauth-authorization-server`
        },
        certificates: certs
    };
};

const isAwsRuntime = () => Boolean(process.env.ECS_CONTAINER_METADATA_URI || process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.AWS_EXECUTION_ENV);

const getSanityTargets = config => {
    if (isAwsRuntime()) {
        return {
            spBaseUrl: process.env.SANITY_SP_BASE_URL || 'http://localhost:3002',
            pcmUiBaseUrl: process.env.SANITY_PCM_UI_BASE_URL || 'http://localhost:3001',
            referenceDsBaseUrl: process.env.SANITY_REFERENCE_DS_BASE_URL || 'https://localhost:8080/fhir',
            referenceDsHealthUrl: process.env.SANITY_REFERENCE_DS_HEALTH_URL || 'http://localhost:8081/healthz'
        };
    }
    return {
        spBaseUrl: process.env.SANITY_SP_BASE_URL || 'http://sp-client:3000',
        pcmUiBaseUrl: process.env.SANITY_PCM_UI_BASE_URL || 'http://localhost:3001',
        referenceDsBaseUrl: process.env.SANITY_REFERENCE_DS_BASE_URL
            || config.internalBaseUrls?.healthOrganizations?.[config.healthOrganizations?.[0]?.id]
            || config.internalBaseUrls?.referenceDataSource
            || 'https://ds-gateway:8080/fhir',
        referenceDsHealthUrl: process.env.SANITY_REFERENCE_DS_HEALTH_URL || ''
    };
};

const runSanityCheck = () => new Promise(resolve => {
    const config = loadTeamConfig();
    const targets = getSanityTargets(config);
    const startedAt = Date.now();
    const args = [
        SANITY_SCRIPT,
        '--private-fixture-runner',
        '--config',
        TEAM_CONFIG_PATH,
        '--sp-base-url',
        targets.spBaseUrl,
        '--pcm-ui-base-url',
        targets.pcmUiBaseUrl,
        '--reference-ds-base-url',
        targets.referenceDsBaseUrl
    ];
    if (targets.referenceDsHealthUrl) {
        args.push('--reference-ds-health-url', targets.referenceDsHealthUrl);
    }
    args.push('--fetch-timeout-ms', process.env.ADMIN_SANITY_FETCH_TIMEOUT_MS || '15000');
    args.push('--latency-probe-timeout-ms', process.env.ADMIN_SANITY_LATENCY_PROBE_TIMEOUT_MS || '5000');
    if (!isAwsRuntime()) args.push('--use-internal-urls');
    if (process.env.TEAM_ADMIN_PASSWORD) {
        args.push('--admin-password', process.env.TEAM_ADMIN_PASSWORD);
    }
    logger.info('Sanity Check Started', {
        type: 'SANITY_CHECK_STARTED',
        category: 'harness',
        visibility: 'diagnostic',
        operation: 'sanity-check',
        causesSystemFlow: true,
        targets
    });

    execFile(process.execPath, args, { timeout: ADMIN_SANITY_TIMEOUT_MS }, (error, stdout, stderr) => {
        let result = null;
        try {
            result = JSON.parse(stdout);
        } catch (err) {
            result = {
                status: error ? 'fail' : 'unknown',
                rawOutput: stdout,
                stderr
            };
        }
        const output = {
            ok: !error,
            exitCode: error?.code || 0,
            error: error?.message,
            timedOut: error?.killed === true || error?.signal === 'SIGTERM',
            stderr,
            result,
            targets
        };
        const failedChecks = Array.isArray(result?.checks)
            ? result.checks.filter(check => check.status !== 'pass')
            : [];
        logger[output.ok ? 'info' : 'error'](`Sanity Check ${output.ok ? 'Completed' : 'Failed'}`, {
            type: output.ok ? 'SANITY_CHECK_COMPLETED' : 'SANITY_CHECK_FAILED',
            category: 'harness',
            // The owner classifies this harness summary separately from its real request errors.
            visibility: 'diagnostic',
            operation: 'sanity-check',
            causesSystemFlow: true,
            status: result?.status || (output.ok ? 'pass' : 'fail'),
            exitCode: output.exitCode,
            timedOut: output.timedOut,
            durationMs: Date.now() - startedAt,
            failedChecks,
            targets,
            error: output.error,
            stderr: output.stderr
        });
        resolve(output);
    });
});

const writeCertificateFiles = certs => {
    if (!certs || typeof certs !== 'object') return;
    fs.mkdirSync(CERTS_DIR, { recursive: true });
    for (const [fileName, content] of Object.entries(certs)) {
        if (!CERT_FILES.includes(fileName) && !String(fileName).startsWith('custom/')) continue;
        const filePath = safeCertFilePath(fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
};

const applyTeamConfigToStore = config => {
    syncDataSourcesToStore(store, config, getCertificateThumbprints()['ds-gateway.crt'], { preserveExisting: true });
};

/** Render Admin through bounded local templates; protected operation routes remain here. */
const getCredentialInventory = () => {
    const config = loadTeamConfig();
    return require('../admin-certificates').inventory(config, CERTS_DIR, { sources: getConfiguredDataSources(config, { includeDisabled: true }), clients: require('../store').buildClients(), files: listCertificateFiles() });
};
const renderAdminHtml = (req, options = {}) => require('./admin-view')(req, options, { loadTeamConfig, applicationPath, getEffectiveConformancePolicy, getCertificateThumbprints, getCredentialInventory, browserNavigation, getPublicBaseUrls, buildDeploymentEndpoints, getConfiguredDataSources, SIMULATION_CONTROLS, PRESETS, presetSimulationDefaults, presetSourceDefaults, managedFhirServers, confirmationToken, getDataOperationRegistry, escapeHtml, formatByteLimit, operationSummary, parseBusinessIdentifier, CONNECTATHON_REPO_URL });

/** Bridge old bookmarks to the one Logs application, disclosing unsupported scope. */
function renderAdminLogView(query = {}, req) {
    const bridge = require('../admin-log-context').bridge(query, loadTeamConfig());
    return renderAdminAuxiliary(req, { title: 'Open related diagnostics', section: 'logs', helpKey: 'admin.logs-browse',
        body: `<p role="status">${escapeHtml(bridge.notice)}</p><a class="btn btn-primary" data-help-key="admin.logs-browse" href="${escapeHtml(uiUrl('/logs-view') + bridge.query)}">${bridge.exact ? 'Open related diagnostics' : 'Open broader Logs context'}</a>` });
}

function sendAdminError(req, res, statusCode, message, details = {}) {
    const payload = { error: message, ...details };
    const acceptsHtml = req.get('accept')?.includes('text/html');
    res.status(statusCode);
    if (acceptsHtml) {
        const { expectedConfirmation: _confirmation, ...visibleDetails } = details;
        return res.send(renderAdminHtml(req, {
            section: req.body?.adminForm === 'legacy-upstream' ? 'sources' : require('./admin-shell').operationArea(req.path),
            adminError: {
                statusCode,
                message: /^\/admin\/api\/(?:data-operations|fhir-servers)/.test(req.path || '')
                    ? requestFailure(message, Boolean(details.activeOperationId)) : message,
                details: /^\/admin\/api\/(?:data-operations|fhir-servers)/.test(req.path || '')
                    ? { ...visibleDetails, error: message } : visibleDetails
            }
        }));
    }
    return res.json(payload);
}

router.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
    const expected = process.env.TEAM_ADMIN_PASSWORD;
    const destination = require('./admin-shell').safeReturn(req.body.returnTo, uiUrl('/').replace(/\/$/, ''));
    if (!expected || req.body.adminPassword !== expected) return res.redirect(destination);
    const session = crypto.createHash('sha256').update(`pcm-admin-session:${expected}${require('../migration-checkpoint').sessionEpoch()}`).digest('base64url');
    res.cookie('teamAdminSession', session, { httpOnly: true, sameSite: 'strict', path: uiUrl('/admin') });
    return res.redirect(destination);
});

router.use('/admin', captureMultipartBody, express.json({ limit: '10mb' }), express.urlencoded({ extended: true, limit: '10mb' }), mergeMultipartFields, requireAdmin);
router.use('/admin', require('../admin-outcome').middleware({ logger, getConfig: loadTeamConfig }));

// Old form endpoints return to their owning server-rendered area under this mount.
router.use('/admin', (req, res, next) => {
    const originalRedirect = res.redirect.bind(res);
    res.redirect = (...args) => {
        const index = typeof args[0] === 'number' ? 1 : 0;
        if (args[index] === uiUrl('/admin')) {
            const shell = require('./admin-shell');
            const area = req.body?.adminForm === 'legacy-upstream' ? 'sources' : shell.operationArea(req.path.startsWith('/admin') ? req.path : `/admin${req.path}`);
            if (area) {
                const target = req.params?.id || req.params?.serverId || '';
                const legacyOperation = /identity-mapping/.test(req.path) || req.body?.adminForm === 'legacy-upstream';
                const source = getConfiguredDataSources(loadTeamConfig(), { includeDisabled: true }).find(item => item.id === target || item.healthOrganizationId === target || (legacyOperation && (item.compatibilityOnly || (item.builtIn && !item.healthOrganizationId))));
                const view = legacyOperation ? (/identity-mapping/.test(req.path) ? 'mappings' : 'upstream') : /server-trust/.test(req.path) ? 'trust' : /cert/.test(req.path) ? 'credentials' : '';
                args[index] = shell.address(uiUrl('/').replace(/\/$/, ''), area, source?.id || '', view);
            }
        }
        return originalRedirect(...args);
    };
    next();
});

router.use('/admin/services', require('./services').servicesRouter({ store, getConfig: loadTeamConfig, tokenStore: tokens,
    audit: event => logger.info('SERVICE_ADMIN_OPERATION', { ...event, visibility: 'diagnostic', component: 'pcm-services', operation: event.operation || event.action || 'service-private-command' }) }));

router.post('/admin/consents/:id/cancel', cancellation.handler({ store, getConfig: loadTeamConfig, tokenStore: tokens, audit: event => logger.info('CONSENT_PROVIDER_CANCELLATION', { ...event, visibility: 'diagnostic', component: 'pcm-consents', operation: 'provider-cancellation' }) }));

router.post('/admin/consents/:id/sandbox-sources', sourceCommand.handler({
    store, getConfig: loadTeamConfig, audit: event => logger.info('SANDBOX_SOURCE_CHANGE', { ...event, visibility: 'diagnostic', component: 'pcm-consents', operation: 'source-simulation' })
}));

router.get('/admin', (req, res) => {
    const config = loadTeamConfig();
    const effectivePolicy = effectivePolicyReport(getEffectiveConformancePolicy(config));
    if (req.get('accept')?.includes('text/html')) return res.send(renderAdminHtml(req, { sanityResult: lastSanityResult }));
    res.json({
        teamId: process.env.TEAM_ID || 'local',
        security: config.security,
        adminApi: true,
        config,
        effectivePolicy,
        thumbprints: getCertificateThumbprints(),
        deployment: {
            endpoints: buildDeploymentEndpoints(req),
            connectathonRepoUrl: CONNECTATHON_REPO_URL
        }
    });
});

router.get('/admin/status', (req, res) => {
    const config = loadTeamConfig();
    res.json({
        teamId: process.env.TEAM_ID || 'local',
        security: config.security,
        config,
        effectivePolicy: effectivePolicyReport(getEffectiveConformancePolicy(config)),
        thumbprints: getCertificateThumbprints(),
        deployment: {
            endpoints: buildDeploymentEndpoints(req),
            connectathonRepoUrl: CONNECTATHON_REPO_URL
        }
    });
});

router.get('/admin/api/fhir-servers', (req, res) => {
    const config = loadTeamConfig();
    const registry = getDataOperationRegistry();
    res.json({
        servers: managedFhirServers(config).map(server => ({ ...server, lastOperation: registry.list(server.id)[0] || null })),
        excludedSources: config.legacyDataSource ? [{ id: config.legacyDataSource.id, reason: 'legacy Node Data Source is not a managed HAPI server' }] : []
    });
});

router.get('/admin/api/fhir-servers/:serverId/data', async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(new Error('Count request disconnected')); };
    res.once('close', cancel);
    try {
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, req.params.serverId);
        const ho = config.healthOrganizations.find(item => item.id === server.healthOrganizationId);
        const registry = getDataOperationRegistry();
        const operations = registry.list(server.id);
        const verified = latestVerifiedLoad(registry, server.id);
        const actual = await privateDataState(ho, { signal: controller.signal });
        const active = operations[0] && !['succeeded', 'failed'].includes(operations[0].phase) ? operations[0] : null;
        const state = active?.phase || (actual.currentResourceCount === 0 && !actual.hasHistory ? 'empty' : (verified ? 'loaded' : 'unreconciled'));
        res.json({ server, state, actualResourceCount: actual.currentResourceCount, hasHistory: actual.hasHistory, actualCounts: actual.counts, diagnostics: actual.diagnostics, bundle: verified || null, lastOperation: operations[0] || null });
    } catch (error) { sendAdminError(req, res, error instanceof TypeError ? 404 : 502, sanitizeLogMessage(error.message), { state: 'unavailable' }); }
    finally { res.removeListener('close', cancel); }
});

router.get('/admin/api/data-operations/:operationId', (req, res) => {
    const operation = getDataOperationRegistry().status(req.params.operationId);
    if (!operation) return sendAdminError(req, res, 404, 'Data operation was not found.');
    return res.json(operation);
});

router.post('/admin/api/data-operations/:operationId/recover', async (req, res) => {
    let diagnosticOperation;
    try {
        const registry = getDataOperationRegistry();
        const current = registry.get(req.params.operationId);
        if (!current) throw new Error('unknown data operation');
        diagnosticOperation = current;
        logImportDiagnostic(current, 'reconciliation-request', 'info');
        if (activeDataOperations.has(current.id)) throw new Error('operation worker is still running');
        const stopped = req.body.workersStopped === true || req.body.workersStopped === 'true';
        if (!current.mutationSubmitted && !current.needsReconciliation) {
            const recovered = registry.recover(current.id, { workersStopped: stopped, reconciled: true });
            logImportDiagnostic(current, 'reconciliation-complete', 'info', { result: recovered.result || recovered.phase });
            return res.format({ json: () => res.json(recovered), html: () => res.redirect(uiUrl('/admin')) });
        }
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, current.serverId);
        const ho = config.healthOrganizations.find(item => item.id === server.healthOrganizationId);
        const { reconcileOperation } = require(fs.existsSync('/clinical-data/reconciliation.js')
            ? '/clinical-data/reconciliation' : '../../../../clinical-data/reconciliation');
        const upload = path.join(process.env.STATE_DIR || '/runtime/state', 'data-uploads', `${current.id}.json`);
        const operation = await reconcileOperation({ registry, operationId: current.id, workersStopped: stopped,
            targetIdentity: JSON.stringify(ho), uploadPath: upload, limits: server.limits,
            endpoint: ho.clinicalData.privateFhirBaseUrl, headers: privateImportHeaders(ho),
            fetchImpl: guardedFetch, cleanup: async () => fs.unlinkSync(upload) });
        logImportDiagnostic(current, 'reconciliation-complete', 'info', { result: operation.result || operation.phase });
        res.format({ json: () => res.json(operation), html: () => res.redirect(uiUrl('/admin')) });
    } catch (error) {
        if (diagnosticOperation) logImportDiagnostic(diagnosticOperation, 'reconciliation-failed', 'error', { error: error.message });
        return sendAdminError(req, res, 409, error.message);
    }
});

router.post('/admin/api/data-operations/:operationId/reset', async (req, res) => {
    let diagnosticOperation;
    try {
        const registry = getDataOperationRegistry();
        const current = registry.get(req.params.operationId);
        if (!current) throw new Error('unknown data operation');
        diagnosticOperation = current;
        logImportDiagnostic(current, 'reconciliation-reset-request', 'info');
        if (activeDataOperations.has(current.id)) throw new Error('operation worker is still running');
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, current.serverId);
        const ho = config.healthOrganizations.find(item => item.id === server.healthOrganizationId);
        const { resetUncertainTarget } = require(fs.existsSync('/clinical-data/reconciliation.js')
            ? '/clinical-data/reconciliation' : '../../../../clinical-data/reconciliation');
        const operation = await resetUncertainTarget({ registry, operationId: current.id,
            workersStopped: req.body.workersStopped === true || req.body.workersStopped === 'true',
            confirmation: req.body.confirmation, expectedConfirmation: confirmationToken(server.id, config.teamId),
            targetIdentity: JSON.stringify(ho), endpoint: ho.clinicalData.privateFhirBaseUrl,
            headers: privateImportHeaders(ho), fetchImpl: guardedFetch });
        logImportDiagnostic(current, 'reconciliation-reset-complete', 'info', { result: operation.result || operation.phase });
        res.format({ json: () => res.json(operation), html: () => res.redirect(uiUrl('/admin')) });
    } catch (error) {
        if (diagnosticOperation) logImportDiagnostic(diagnosticOperation, 'reconciliation-reset-failed', 'error', { error: error.message });
        return sendAdminError(req, res, 409, sanitizeLogMessage(error.message));
    }
});

router.post('/admin/api/fhir-servers/:serverId/imports', async (req, res) => {
    let operation;
    const registry = getDataOperationRegistry();
    try {
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, req.params.serverId);
        const upload = req.multipart?.files?.bundle;
        if (!upload?.buffer) throw new TypeError('multipart field bundle is required');
        if (!/\.source\.transaction\.json$/i.test(upload.fileName || '')) throw new TypeError('bundle filename must end in .source.transaction.json');
        const replacing = getRequestField(req, 'replace') === 'true';
        const ho = config.healthOrganizations.find(item => item.id === server.healthOrganizationId);
        operation = registry.create(server.id, replacing ? 'replace' : 'import', {
            targetIdentity: JSON.stringify(ho), bundleName: path.basename(upload.fileName), bytes: upload.buffer.length,
            deadlines: clinicalDeadlines(), diagnostics: ['Target reserved for private HAPI maintenance.']
        });
        registry.recordProgress(operation.id, 'bundle-check-started');
        const inspected = loadTransactionBundleContract().inspectTransactionBundle(upload.buffer, { limits: server.limits, expectedSource: server.bootstrap.expectedSource });
        operation = registry.transition(operation.id, 'validating', {
            sha256: inspected.sha256, bytes: inspected.bytes,
            entries: inspected.entries, source: inspected.source, version: inspected.version, counts: inspected.counts,
            verificationTypeTotal: loadTransactionBundleContract().MANAGED_CLINICAL_RESOURCE_TYPES.length,
            patients: inspected.patients
        });
        registry.recordProgress(operation.id, 'bundle-check-complete');
        registry.recordProgress(operation.id, 'target-preflight-started');
        const preflight = await loadClinicalWorkflow().preflightTarget({ registry, operation, inspected,
            transport: { endpoint: ho.clinicalData.privateFhirBaseUrl, headers: privateImportHeaders(ho), fetchImpl: privateFetch },
            legacyStateDir: path.join(process.env.STATE_DIR || '/runtime/state', 'import', ho.import.stateNamespace)
        });
        operation = registry.transition(operation.id, 'validating', preflight);
        operation = registry.recordProgress(operation.id, 'target-preflight-complete');
        const uploadDir = path.join(process.env.STATE_DIR || '/runtime/state', 'data-uploads');
        fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(path.join(uploadDir, `${operation.id}.json`), upload.buffer, { mode: 0o600 });
        setImmediate(() => executeQueuedDataOperation(operation));
        return res.status(202).json(registry.status(operation.id));
    } catch (error) {
        if (operation) loadClinicalWorkflow().failOperation(registry, operation, error);
        return sendAdminError(req, res, error.statusCode || (error instanceof TypeError ? 400 : 502), sanitizeLogMessage(error.message), { activeOperationId: error.activeOperationId || null });
    }
});

router.delete('/admin/api/fhir-servers/:serverId/data', (req, res) => {
    try {
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, req.params.serverId);
        const expected = confirmationToken(server.id, config.teamId);
        if (req.body?.confirmation !== expected) return sendAdminError(req, res, 409, 'Target-specific delete confirmation is missing or stale.', { expectedConfirmation: expected });
        const operation = getDataOperationRegistry().create(server.id, 'reset', {
            confirmation: expected,
            targetIdentity: JSON.stringify(config.healthOrganizations.find(item => item.id === server.healthOrganizationId)),
            deadlines: clinicalDeadlines(),
            diagnostics: ['Delete-all is queued for the private named-HAPI maintenance worker.']
        });
        setImmediate(() => executeQueuedDataOperation(operation));
        return res.status(202).json(operation);
    } catch (error) { return sendAdminError(req, res, error.statusCode || 404, error.message, { activeOperationId: error.activeOperationId || null }); }
});

router.get('/admin/api/patients', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ patients: verifiedPatientInventory() });
});

/** Publish one bounded limits form inside the existing config/private lifecycle mutex. */
function saveLimits(req, res) {
    try {
        const owner = require('../team-config');
        const clinical = req.path.endsWith('/clinical-query-limits');
        const result = require('../../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || loadTeamConfig().runtime.stateDir, () => {
            // Preserve the canonical document: the general UI loader adds derived identity mappings.
            const current = clinical
                ? require('../../../shared/team-config-validator').readTeamConfig(TEAM_CONFIG_PATH, { env: process.env })
                : loadTeamConfig();
            const candidate = require('../admin-source-limits').editLimits(current, req.body, {
                id: req.params.id, serverId: req.params.serverId, registry: getDataOperationRegistry(), clinical
            });
            owner.markRuntimeChange(candidate, clinical ? 'clinical-query-limits' : 'source-limits');
            // Query budgets cannot synchronize Endpoint credentials or change workflow source membership.
            if (clinical) store.transaction(() => owner.publishTeamConfig(candidate));
            else require('../workflow-source-configuration').withWorkflowSourceConfiguration(store, candidate, () => owner.publishTeamConfig(candidate));
            return candidate;
        });
        const source = req.params.serverId ? result.healthOrganizations.find(ho => ho.clinicalData.serverId === req.params.serverId)?.dataSourceOrganization.id : req.params.id;
        logger.info('Local source limits saved', { type: 'SOURCE_LIMITS_UPDATED', category: 'admin', visibility: 'diagnostic', sourceId: source || 'defaults', revision: result.runtime.revision });
        return res.format({ json: () => res.json({ status: 'saved', revision: result.runtime.revision,
            adoption: 'PCM uses current config on new requests; source adoption pending operator checks. No external capacity changed.' }),
            html: () => res.redirect(303, require('./admin-shell').address(applicationPath(result.publicBaseUrls.pcmUi).replace(/\/$/, ''), 'sources', source || '', source ? 'limits' : 'defaults') + '&limitsSaved=' + result.runtime.revision) });
    } catch (error) { return sendAdminError(req, res, error.statusCode || 400, error.message, error.field ? { field: error.field } : {}); }
}
router.post('/admin/config/clinical-query-limits', saveLimits);
router.post('/admin/config/data-sources/:id/clinical-query-limits', saveLimits);
router.post('/admin/config/presence-limits', saveLimits);
router.post('/admin/config/data-sources/:id/limits', saveLimits);
router.post('/admin/config/fhir-servers/:serverId/limits', saveLimits);

router.post('/admin/config/fhir-servers/:serverId/bootstrap', (req, res) => {
    try {
        const config = loadTeamConfig();
        const server = requireManagedFhirServer(config, req.params.serverId);
        // Browser forms own only this startup mapping; old API callers keep their contract.
        if (req.body?.adminForm === 'clinical-bootstrap' && String(req.body.expectedRevision) !== String(config.runtime.revision || 0)) {
            return sendAdminError(req, res, 409, 'Startup settings changed. Refresh Admin and review the current mapping before saving.');
        }
        const ho = config.healthOrganizations.find(item => item.id === server.healthOrganizationId);
        const policy = String(req.body?.policy || '');
        const bundleReference = String(req.body?.bundleReference || '').trim();
        const expectedSource = String(req.body?.expectedSource || '').trim();
        if (!['disabled', 'if-empty', 'replace'].includes(policy)) throw new TypeError('bootstrap policy must be disabled, if-empty, or replace');
        if (policy !== 'disabled' && (!bundleReference || !expectedSource)) throw new TypeError('enabled bootstrap requires an explicit relative bundle reference and expected source tag');
        if (bundleReference && (path.isAbsolute(bundleReference) || bundleReference.split(/[\\/]+/).includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.source\.transaction\.json$/.test(bundleReference))) {
            throw new TypeError('bootstrap bundle reference must be a safe relative *.source.transaction.json path');
        }
        if (expectedSource && !/^[a-z0-9][a-z0-9._-]*$/.test(expectedSource)) throw new TypeError('expected source tag is invalid');
        ho.clinicalData.bootstrap = { policy, bundleReference: policy === 'disabled' ? '' : bundleReference, expectedSource: policy === 'disabled' ? '' : expectedSource };
        saveTeamConfig(markRuntimeChange(config, `clinical-bootstrap-${server.id}`));
        res.format({ json: () => res.json({ serverId: server.id, bootstrap: ho.clinicalData.bootstrap }), html: () => res.redirect(303, require('./admin-shell').address(applicationPath(config.publicBaseUrls.pcmUi).replace(/\/$/, ''), 'sources', ho.dataSourceOrganization.id, 'data')) });
    } catch (error) { return sendAdminError(req, res, 400, error.message); }
});

router.post('/admin/config/ds-url', (req, res) => {
    const config = loadTeamConfig();
    const endpoint = req.body.endpoint || req.body.teamDataSourceUrl;
    const enabled = req.body.enabled !== 'false' && req.body.enabled !== false;
    if (enabled && (!endpoint || !/^https?:\/\//.test(endpoint))) {
        return sendAdminError(req, res, 400, 'Team Data Source URL must be an absolute HTTP or HTTPS URL.', {
            field: 'endpoint',
            received: endpoint || '(empty)',
            help: 'Use the externally reachable FHIR base URL for the team data source, for example https://team-source.example.org/fhir.'
        });
    }
    if (enabled) {
        try { parseOutboundUrl(endpoint); } catch (error) { return sendAdminError(req, res, 400, error.message, { field: 'endpoint' }); }
    }
    config.organizations.teamDataSource.endpoint = endpoint || '';
    config.organizations.teamDataSource.enabled = enabled;
    config.publicBaseUrls.teamDataSource = enabled ? endpoint : '';
    config.organizations.dataSources = Array.isArray(config.organizations.dataSources) ? config.organizations.dataSources : [];
    config.organizations.dataSources = config.organizations.dataSources.filter(source => source.id !== config.organizations.teamDataSource.id);
    if (enabled) {
        config.organizations.dataSources.push({
            ...config.organizations.teamDataSource,
            enabled: true
        });
    }
    saveTeamConfig(markRuntimeChange(config, 'data-source-url'));
    applyTeamConfigToStore(config);
    res.format({
        json: () => res.json({ status: 'saved', teamDataSource: config.organizations.teamDataSource }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

/** Update classification only; stale forms never overwrite a newer configuration revision. */
router.post('/admin/config/data-sources/:id/institution', (req, res) => {
    const config = loadTeamConfig();
    if (req.body.adminForm === 'source-registration') {
        try {
            const previous = sourceRegistration.customSource(config, req.params.id), source = structuredClone(previous);
            source.name = String(req.body.name || '').trim(); source.endpoint = String(req.body.endpoint || '').trim(); source.institutionType = req.body.institutionType;
            const result = publishSourceInput(req, config, source, previous, {}, 'edit');
            return res.format({ json: () => res.json({ status: 'saved', dataSource: source, revision: result.revision, runtime: 'Not checked' }),
                html: () => res.redirect(require('./admin-shell').address(uiUrl('/').replace(/\/$/, ''), 'sources', source.id)) });
        } catch (error) { return sendAdminError(req, res, error.status || 400, error.message); }
    }
    const institutionType = req.body?.institutionType;
    if (!require('../../../shared/source-institution').INSTITUTION_TYPES.includes(institutionType)) return sendAdminError(req, res, 400, 'Institution type must be HMO, Hospital or Other.');
    if (String(req.body?.expectedRevision) !== String(Number(config.runtime.revision) || 0)) return sendAdminError(req, res, 409, 'Source settings changed. Refresh Admin and review the current institution type before saving.');
    const source = getConfiguredDataSources(config, { includeDisabled: true }).find(item => item.id === req.params.id);
    if (!source) return sendAdminError(req, res, 404, 'Registered data source not found.');
    const target = source.healthOrganizationId === 'legacy-ds' ? config.legacyDataSource
        : source.builtIn ? (source.healthOrganizationId ? config.healthOrganizations?.find(ho => ho.id === source.healthOrganizationId) : config.organizations.referenceDataSource)
        : config.organizations.dataSources.find(item => item.id === source.id);
    target.institutionType = institutionType;
    try { saveTeamConfig(markRuntimeChange(config, 'source-institution')); }
    catch (error) { return sendAdminError(req, res, 400, error.message); }
    logger.info('Source institution type saved', { type: 'SOURCE_INSTITUTION_UPDATED', category: 'admin', sourceId: source.id, previous: source.institutionType, institutionType, revision: config.runtime.revision });
    res.format({ json: () => res.json({ status: 'saved', institutionType, revision: config.runtime.revision, sourceId: source.id }),
        html: () => res.redirect(require('./admin-shell').address(uiUrl('/').replace(/\/$/, ''), 'sources', req.params.id) + '&sourceInstitution=saved') });
});

/** Stage role-specific files without accepting arbitrary credential destinations. */
function sourceCredentialInput(req, config, source, { existing = false } = {}) {
    const mode = getRequestField(req, 'credentialMode') || (getRequestField(req, 'generateCertificate') === 'true' || getRequestField(req, 'generateCertificate') === true ? 'generate' : req.multipart || getRequestField(req, 'generateCertificate') === false || getRequestField(req, 'generateCertificate') === 'false' ? 'upload' : 'generate');
    if (!['retain', 'generate', 'upload'].includes(mode) || (!existing && mode === 'retain')) throw new Error('Choose Generate sandbox credentials or Upload existing credentials');
    if (mode === 'retain') return { material: {} };
    const profile = getRequestField(req, 'credentialProfile') || 'shared-es256';
    if (!['shared-es256','separate-es384'].includes(profile)) throw new Error('Choose a supported credential profile');
    const auth = source.pcmClientAuth;
    // New role filenames are assigned by the backend, including on profile changes.
    auth.cert = `custom/${source.id}.crt`; auth.key = `custom/${source.id}.key`;
    auth.assertionCertificates = { [profile === 'separate-es384' ? 'ES384' : 'ES256']: auth.cert };
    auth.mtlsCert = profile === 'separate-es384' ? `custom/${source.id}-mtls.crt` : null;
    auth.mtlsKey = profile === 'separate-es384' ? `custom/${source.id}-mtls.key` : null;
    const certContent = getRequestFileContent(req, 'pcmClientAuthCertFile');
    const keyContent = getRequestFileContent(req, 'pcmClientAuthKeyFile');
    if (mode === 'upload' && (!certContent || !keyContent)) throw new Error('Upload the matching assertion certificate and private key together');
    if (mode === 'generate' && (certContent || keyContent)) throw new Error('Choose Upload existing credentials to publish selected files');
    return prepareSourceCredentials({ directory: CERTS_DIR, config, source, generate: mode === 'generate', certContent, keyContent,
        transportCertContent: getRequestFileContent(req, 'pcmTransportCertFile'), transportKeyContent: getRequestFileContent(req, 'pcmTransportKeyFile') });
}

/** Stage the independent server trust choice, then validate it before publication. */
function sourceTrustInput(req, source, material) {
    source.serverTrust = { mode: getRequestField(req, 'serverTrustMode') || source.serverTrust?.mode || 'team-root-ca',
        caCert: getRequestField(req, 'serverTrustCaCert') || null,
        certThumbprint: uploadedCertThumbprint(req, 'serverTrustCertFile') || getRequestField(req, 'serverTrustCertThumbprint') || null };
    const ca = getRequestFileContent(req, 'serverTrustCaFile');
    if (ca) {
        if (source.serverTrust.mode !== 'custom-ca') throw new Error('Choose Custom CA before uploading a server CA');
        const name = `custom/${source.id}-server-ca-${crypto.createHash('sha256').update(ca).digest('hex')}.crt`;
        material[name] = validateServerCa(ca); source.serverTrust.caCert = name;
    }
    if (getRequestField(req, 'reusePcmClientCertForServerTrust') === 'true' || getRequestField(req, 'reusePcmClientCertForServerTrust') === true) reusePcmClientCertificateForServerTrust(source);
    source.certThumbprint = source.serverTrust.certThumbprint;
}

/** Run one revision-bound source command under the existing protected Admin boundary. */
function publishSourceInput(req, config, source, previous, material = {}, action = 'save') {
    sourceRegistration.validateSource({ config, source, previous, directory: CERTS_DIR, material, store });
    return sourceRegistration.publishSource({ config, source, previous, material, action, directory: CERTS_DIR, store,
        expectedRevision: getRequestField(req, 'expectedRevision'), saveConfig: next => require('../workflow-source-configuration').withWorkflowSourceConfiguration(store, next, () => require('../team-config').publishTeamConfig(next)),
        configPath: require('../team-config').getConfigPath() });
}

router.post('/admin/config/data-sources/add', (req, res) => {
    const config = loadTeamConfig();
    try {
        const source = newDataSourceConfig(String(getRequestField(req, 'name') || '').trim(), String(getRequestField(req, 'endpoint') || '').trim(), {
            clientId: String(getRequestField(req, 'clientId') || '').trim(), institutionType: getRequestField(req, 'institutionType') || 'other' });
        const prepared = sourceCredentialInput(req, config, source);
        sourceTrustInput(req, source, prepared.material);
        const result = publishSourceInput(req, config, source, null, prepared.material);
        res.format({ json: () => res.status(201).json({ status: 'saved', dataSource: source, revision: result.revision, runtime: 'Not checked' }),
            html: () => res.redirect(require('./admin-shell').address(uiUrl('/').replace(/\/$/, ''), 'sources', source.id, 'registration')) });
    } catch (error) { return sendAdminError(req, res, error.status || 400, error.code === 'ENOENT' ? 'Credential material is missing. Generate or upload every applicable role pair.' : error.message); }
});

router.post('/admin/config/data-sources/:id/cert/generate', (req, res) => {
    const config = loadTeamConfig();
    try {
        const previous = sourceRegistration.customSource(config, req.params.id), source = structuredClone(previous);
        if (source.enabled === false) throw new Error('Re-enable the source before publishing credentials');
        const prepared = sourceCredentialInput(req, config, source, { existing: true });
        const result = publishSourceInput(req, config, source, previous, prepared.material, 'credentials');
        res.format({ json: () => res.json({ status: 'saved', dataSource: source, revision: result.revision, runtime: 'Not checked' }),
            html: () => res.redirect(require('./admin-shell').address(uiUrl('/').replace(/\/$/, ''), 'sources', source.id, 'credentials')) });
    } catch (error) { return sendAdminError(req, res, error.status || 400, error.message); }
});

router.post('/admin/config/data-sources/:id/test', async (req, res) => {
    const config = loadTeamConfig();
    const source = getConfiguredDataSources(config).find(item => item.id === req.params.id && !item.builtIn);
    if (!source) return sendAdminError(req, res, 404, 'Custom data source was not found.', { id: req.params.id });
    const controls = sourceSimulationControls(getEffectiveConformancePolicy(), config, { resource: source.endpoint });
    const tlsOptions = require('../../../shared/source-server-trust').sourceServerTls({ trust: source.serverTrust,
        certsDir: CERTS_DIR, rootCaCert: config.certificates.rootCaCert, verify: controls.serverCertificateVerification !== false });
    const diagnostic = await diagnoseDataSource(source, {
        timeoutMs: Number(req.body.timeoutMilliseconds || 5000), controls, tls: tlsOptions,
        probe: req.body.probeAccessToken ? { accessToken: req.body.probeAccessToken, patient: req.body.probePatient, path: req.body.probePath } : {}
    });
    logger.info('DATA_SOURCE_READINESS_COMPLETED', {
        type: 'DATA_SOURCE_READINESS_COMPLETED', category: 'admin', visibility: 'diagnostic', actor: process.env.TEAM_ADMIN_PASSWORD ? 'team-admin' : 'sandbox-operator', teamId: config.teamId, revision: Number(config.runtime.revision) || 0,
        correlationId: diagnostic.correlationId,
        sourceId: diagnostic.sourceId,
        status: diagnostic.status,
        phases: diagnostic.phases.map(phase => ({ phase: phase.phase, status: phase.status, classification: phase.classification }))
    });
    res.format({
        json: () => res.status(diagnostic.status === 'fail' ? 502 : 200).json(diagnostic),
        html: () => res.status(diagnostic.status === 'fail' ? 502 : 200).send(renderAdminAuxiliary(req, {
            title: 'Source readiness', helpKey: 'admin.source-readiness', section: 'sources', source: source.id, view: 'diagnostics',
            body: `<p role="status">${escapeHtml(source.name)}: ${escapeHtml(diagnostic.status)}. Readiness is not conformance certification.</p><a class="btn btn-primary" data-help-key="admin.operation-logs" href="${escapeHtml(uiUrl('/logs-view'))}?diagnostics=true&amp;inspection=correlationId&amp;correlationId=${encodeURIComponent(diagnostic.correlationId)}">Open related diagnostics</a><details><summary data-help-key="common.details">Readiness phases</summary><pre data-help-key="admin.source-readiness">${escapeHtml(JSON.stringify(diagnostic, null, 2))}</pre></details>` }))
    });
});

router.get('/admin/config/data-sources/:id/client-bundle', (req, res) => {
    const config = loadTeamConfig();
    const source = getConfiguredDataSources(config).find(item => item.id === req.params.id);
    if (!source || source.builtIn) return sendAdminError(req, res, 404, 'Custom data source bundle is not available for this ID.', {
        id: req.params.id,
        help: 'Bundles are available only for custom consent approval data sources, not for the built-in reference data source.'
    });
    res.setHeader('Cache-Control', 'no-store');
    let bundle;
    try { bundle = { ...buildDataSourceClientBundle(config, source), credentialScope: 'Registration and PCM client credentials, including PRIVATE KEYS' }; }
    catch (error) { return sendAdminError(req, res, 400, `Source export refused: ${error.message}`, { help: 'Review this source HTTPS trust reference. CA references must identify public certificates and cannot name authority signing keys.' }); }
    if (req.query.format === 'zip') {
        const files = {
            'bundle.json': JSON.stringify({ ...bundle, certificates: undefined }, null, 2)
        };
        for (const [fileName, content] of Object.entries(bundle.certificates)) files[fileName] = content;
        const zip = buildZip(files);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${source.id}-client-bundle.zip"`);
        return res.send(zip);
    }
    res.json(bundle);
});

router.get('/admin/config/data-sources/:id/client-bundle.zip', (req, res) => {
    const config = loadTeamConfig();
    const source = getConfiguredDataSources(config).find(item => item.id === req.params.id);
    if (!source || source.builtIn) return sendAdminError(req, res, 404, 'Custom data source ZIP bundle is not available for this ID.', {
        id: req.params.id,
        help: 'ZIP bundles are available only for custom consent approval data sources, not for the built-in reference data source.'
    });
    res.setHeader('Cache-Control', 'no-store');
    let bundle;
    try { bundle = { ...buildDataSourceClientBundle(config, source), credentialScope: 'Registration and PCM client credentials, including PRIVATE KEYS' }; }
    catch (error) { return sendAdminError(req, res, 400, `Source export refused: ${error.message}`, { help: 'Review this source HTTPS trust reference. CA references must identify public certificates and cannot name authority signing keys.' }); }
    const files = {
        'bundle.json': JSON.stringify({ ...bundle, certificates: undefined }, null, 2)
    };
    for (const [fileName, content] of Object.entries(bundle.certificates)) files[fileName] = content;
    const zip = buildZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${source.id}-client-bundle.zip"`);
    res.send(zip);
});

/** Existing CA/pin routes share the same source-owned trust publication command. */
function saveSourceTrust(req, res) {
    const config = loadTeamConfig();
    try {
        const previous = sourceRegistration.customSource(config, req.params.id), source = structuredClone(previous);
        if (source.enabled === false) throw new Error('Re-enable the source before publishing HTTPS trust');
        const material = {};
        if (getRequestField(req, 'adminForm') === 'source-trust') sourceTrustInput(req, source, material);
        else if (req.path.endsWith('/ca')) {
            const ca = getRequestFileContent(req, 'serverTrustCaFile') || req.body.serverTrustCa || req.body.caCertContent;
            if (!ca) throw new Error('Choose a custom CA certificate file before uploading');
            const name = `custom/${source.id}-server-ca-${crypto.createHash('sha256').update(ca).digest('hex')}.crt`;
            material[name] = validateServerCa(ca); source.serverTrust = { mode: 'custom-ca', caCert: name, certThumbprint: null };
        } else source.serverTrust = { mode: 'pinned-thumbprint', caCert: null,
            certThumbprint: uploadedCertThumbprint(req, 'serverTrustCertFile') || req.body.thumbprint || req.body.certThumbprint };
        const result = publishSourceInput(req, config, source, previous, material, 'trust');
        res.format({ json: () => res.json({ status: 'saved', id: source.id, dataSource: source, revision: result.revision, runtime: 'Not checked' }),
            html: () => res.redirect(require('./admin-shell').address(uiUrl('/').replace(/\/$/, ''), 'sources', source.id, 'trust')) });
    } catch (error) { return sendAdminError(req, res, error.status || 400, error.message); }
}
router.post('/admin/config/data-sources/:id/server-trust/ca', saveSourceTrust);
router.post('/admin/config/data-sources/:id/server-trust/thumbprint', saveSourceTrust);

router.post('/admin/config/data-sources/remove', (req, res) => {
    const config = loadTeamConfig();
    try {
        const previous = sourceRegistration.customSource(config, req.body.id), source = structuredClone(previous);
        const action = req.body.action || 'remove';
        if (!['disable','enable','remove'].includes(action)) throw new Error('Unknown source lifecycle action');
        source.enabled = action === 'enable';
        if (action === 'enable') prepareSourceCredentials({ directory: CERTS_DIR, config, source });
        const result = publishSourceInput(req, config, source, previous, {}, action);
        res.format({ json: () => res.json({ status: action === 'remove' ? 'removed' : 'saved', id: source.id, revision: result.revision, remoteData: 'Unchanged', runtime: 'Not checked' }),
            html: () => res.redirect(require('./admin-shell').address(uiUrl('/').replace(/\/$/, ''), 'sources', action === 'remove' ? '' : source.id)) });
    } catch (error) { return sendAdminError(req, res, error.status || 400, error.message); }
});

router.post('/admin/config/identity-mapping/add', (req, res) => {
    if (req.body.adminForm === 'legacy-mapping'
        && String(req.body.expectedRevision) !== String(Number(loadTeamConfig().runtime.revision) || 0)) {
        return sendAdminError(req, res, 409, 'Identity mappings changed. Refresh this source and review the current mappings before saving; no mapping was changed.');
    }

    const businessIdInput = String(req.body.businessId || '').trim();
    const parsedBusinessId = parseBusinessIdentifier(businessIdInput);
    const businessId = businessIdentifierStorageKey(businessIdInput);
    const internalId = cleanLocalSubject(req.body.internalId);
    if (!businessId) return sendAdminError(req, res, 400, 'Business ID is required for the identity mapping override.', {
        field: 'businessId',
        help: 'Enter a bare patient business identifier or FHIR system|value, for example http://fhir.health.gov.il/identifier/il-national-id|000000018.'
    });
    if (!internalId) return sendAdminError(req, res, 400, 'Internal patient identifier is required for the identity mapping override.', {
        field: 'internalId',
        help: 'Enter the local FHIR patient reference this data source expects, for example Patient/local-123.'
    });

    const config = loadTeamConfig();
    config.identityMapping = config.identityMapping || {};
    config.identityMapping.businessIdOverrides = config.identityMapping.businessIdOverrides || {};
    config.identityMapping.businessIdOverrides[businessId] = internalId;
    try { saveTeamConfig(markRuntimeChange(config, 'identity-mapping-add')); }
    catch (error) { return sendAdminError(req, res, 400, error.message); }
    res.format({
        json: () => res.status(201).json({ status: 'saved', businessId, internalId }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

router.post('/admin/config/identity-mapping/remove', (req, res) => {
    if (req.body.adminForm === 'legacy-mapping'
        && String(req.body.expectedRevision) !== String(Number(loadTeamConfig().runtime.revision) || 0)) {
        return sendAdminError(req, res, 409, 'Identity mappings changed. Refresh this source and review the current mappings before saving; no mapping was changed.');
    }

    const businessIdInput = String(req.body.businessId || '').trim();
    const parsedBusinessId = parseBusinessIdentifier(businessIdInput);
    const businessId = businessIdentifierStorageKey(businessIdInput);
    if (!businessId) return sendAdminError(req, res, 400, 'Business ID is required to remove an identity mapping override.', {
        field: 'businessId',
        help: 'Use the Remove button next to an existing identity mapping override.'
    });

    const config = loadTeamConfig();
    config.identityMapping = config.identityMapping || {};
    config.identityMapping.businessIdOverrides = config.identityMapping.businessIdOverrides || {};
    delete config.identityMapping.businessIdOverrides[businessId];
    delete config.identityMapping.businessIdOverrides[businessIdInput];
    if (parsedBusinessId) delete config.identityMapping.businessIdOverrides[parsedBusinessId.value];
    try { saveTeamConfig(markRuntimeChange(config, 'identity-mapping-remove')); }
    catch (error) { return sendAdminError(req, res, 400, error.message); }
    res.format({
        json: () => res.json({ status: 'removed', businessId }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

/** Save only bounded local test workflow clocks through the existing private publication owner. */
router.post('/admin/config/test-workflows', (req, res) => {
    try {
        const owner = require('../team-config');
        const result = require('../../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || loadTeamConfig().runtime.stateDir, lock => {
            const candidate = require('../admin-workflows').edit(loadTeamConfig(), req.body);
            owner.markRuntimeChange(candidate, 'admin-test-workflows');
            require('../workflow-source-configuration').publishWorkflowConfiguration(store, candidate, lock);
            // Adopt synchronously: old asynchronous lookups cannot publish a late OTP after Save.
            require('../system-flow-store').getSystemFlowStore(candidate);
            return candidate;
        });
        res.format({ json: () => res.json({ status: 'saved', revision: result.runtime.revision, adoption: 'New local flows use saved settings. Changed settings invalidate outstanding local flows; restart sign-in after a change. Unchanged settings preserve counters and deadlines. No Contract, issued token or grant deadline is extended.' }),
            html: () => res.redirect(303, require('./admin-shell').address(applicationPath(result.publicBaseUrls.pcmUi).replace(/\/$/, ''), 'security') + '&workflowSaved=' + result.runtime.revision + '#test-workflows') });
    } catch (error) { sendAdminError(req, res, error.statusCode || 400, error.message, error.field ? { field: error.field } : {}); }
});

/** Publish bounded Security forms through the existing private config owner. */
function saveSecurityForm(req, res) {
    try {
        const owner = require('../team-config');
        const result = require('../../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || loadTeamConfig().runtime.stateDir, () => {
            const candidate = require('../admin-security').edit(loadTeamConfig(), req.body);
            owner.markRuntimeChange(candidate, 'admin-security');
            require('../workflow-source-configuration').withWorkflowSourceConfiguration(store, candidate, () => owner.publishTeamConfig(candidate));
            return candidate;
        });
        const target = req.body.sourceId || '';
        return res.format({ json: () => res.json({ status: 'saved', revision: result.runtime.revision, adoption: 'Saved. New PCM requests read current configuration; source and listener adoption require operator checks.' }),
            html: () => res.redirect(303, require('./admin-shell').address(applicationPath(result.publicBaseUrls.pcmUi).replace(/\/$/, ''), 'security', target) + '&securitySaved=' + result.runtime.revision) });
    } catch (error) { return sendAdminError(req, res, error.statusCode || 400, error.message, error.field ? { field: error.field } : {}); }
}

router.post('/admin/config/security', (req, res) => {
    if (req.body.adminForm === 'token-duration') return saveSecurityForm(req, res);
    const config = loadTeamConfig();
    if (['legacy-upstream', 'security'].includes(req.body.adminForm)
        && Number(req.body.expectedRevision) !== (Number(config.runtime.revision) || 0)) {
        return sendAdminError(req, res, 409, 'Saved configuration changed. Refresh this area before saving; no settings were changed.');
    }
    if (req.body.adminForm === 'legacy-upstream') {
        req.body = { ...req.body,
            pcmApiClientAuth: config.security.pcmApi.clientAuth,
            dataSourceGatewayClientAuth: config.security.dataSourceGateway.clientAuth,
            dsGatewayToFhirServerProtocol: config.security.dsGatewayToFhirServer.protocol,
            spDsVerifyServerCertificate: config.security.serviceProviderToDataSource.verifyServerCertificate,
            dsGatewayToFhirServerVerifyServerCertificate: config.security.dsGatewayToFhirServer.verifyServerCertificate,
            dsFhirServerEnforceMappedPatients: config.security.dsFhirServer.enforceMappedPatients,
            accessTokenExpiresInSeconds: config.security.pcmApi.accessTokenExpiresInSeconds };
    } else if (req.body.adminForm === 'security') {
        req.body.dsGatewayToFhirServerCustomUrl = config.security.dsGatewayToFhirServer.customUrl || '';
    }
    const pcmApiClientAuth = req.body.pcmApiClientAuth || req.body.pcmApi?.clientAuth;
    const dataSourceGatewayClientAuth = req.body.dataSourceGatewayClientAuth || req.body.dataSourceGateway?.clientAuth;
    const dsGatewayToFhirServerProtocol = req.body.dsGatewayToFhirServerProtocol || req.body.dsGatewayToFhirServer?.protocol;
    const dsGatewayToFhirServerCustomUrl = (req.body.dsGatewayToFhirServerCustomUrl || req.body.dsGatewayToFhirServer?.customUrl || '').trim();
    if (!['tls', 'mtls'].includes(pcmApiClientAuth)) return sendAdminError(req, res, 400, 'PCM API client authentication must be either TLS or mTLS.', {
        field: 'pcmApiClientAuth',
        received: pcmApiClientAuth || '(empty)',
        allowedValues: ['tls', 'mtls'],
        help: 'Choose TLS for encrypted traffic only, or mTLS when PCM API callers must present a trusted client certificate.'
    });
    if (!['tls', 'mtls'].includes(dataSourceGatewayClientAuth)) return sendAdminError(req, res, 400, 'Data Source gateway client authentication must be either TLS or mTLS.', {
        field: 'dataSourceGatewayClientAuth',
        received: dataSourceGatewayClientAuth || '(empty)',
        allowedValues: ['tls', 'mtls'],
        help: 'Choose TLS for HTTPS without client certificate validation, or mTLS to require Doctor Portal client certificates.'
    });
    if (!['http', 'https'].includes(dsGatewayToFhirServerProtocol)) return sendAdminError(req, res, 400, 'Gateway to FHIR server protocol must be either HTTP or HTTPS.', {
        field: 'dsGatewayToFhirServerProtocol',
        received: dsGatewayToFhirServerProtocol || '(empty)',
        allowedValues: ['http', 'https'],
        help: 'Choose the protocol used by the internal gateway when proxying to the configured FHIR server.'
    });
    if (dsGatewayToFhirServerCustomUrl && !/^https?:\/\//.test(dsGatewayToFhirServerCustomUrl)) {
        return sendAdminError(req, res, 400, 'Custom upstream FHIR server URL must be an absolute HTTP or HTTPS URL.', {
            field: 'dsGatewayToFhirServerCustomUrl',
            received: dsGatewayToFhirServerCustomUrl,
            help: 'Use a full FHIR base URL reachable from the gateway container, for example http://host.docker.internal:8088/fhir.'
        });
    }
    if (dsGatewayToFhirServerCustomUrl) {
        try { parseOutboundUrl(dsGatewayToFhirServerCustomUrl); } catch (error) { return sendAdminError(req, res, 400, error.message, { field: 'dsGatewayToFhirServerCustomUrl' }); }
    }
    if (config.security.dsGatewayToFhirServer.customUrl && config.security.dsGatewayToFhirServer.customUrlScope !== 'legacy-ds'
        && req.body.acknowledgeLegacyUpstream !== 'true' && req.body.acknowledgeLegacyUpstream !== true) {
        return sendAdminError(req, res, 409, 'Existing custom upstream affected all gateways; acknowledge migration to legacy-ds only before saving.', {
            code: 'upstream-migration-required', affectedSourcesAfterMigration: ['legacy-ds']
        });
    }
    const requestedTokenLifetime = req.body.accessTokenExpiresInSeconds ?? req.body.pcmApi?.accessTokenExpiresInSeconds;
    const legacyExpiredTokenMode = req.body.introspectionReturnsExpiredTokens === true
        || req.body.introspectionReturnsExpiredTokens === 'true'
        || req.body.pcmApi?.introspectionReturnsExpiredTokens === true;
    const accessTokenExpiresInSeconds = requestedTokenLifetime === undefined || requestedTokenLifetime === ''
        ? (legacyExpiredTokenMode ? -30 : Number(config.security?.pcmApi?.accessTokenExpiresInSeconds ?? 30))
        : Number(requestedTokenLifetime);
    if (!Number.isSafeInteger(accessTokenExpiresInSeconds)) {
        return sendAdminError(req, res, 400, 'PCM access token lifetime must be an integer number of seconds.', {
            field: 'accessTokenExpiresInSeconds',
            received: requestedTokenLifetime ?? '(empty)',
            help: 'Use a positive lifetime within the contract environment maximum: production 30 seconds, test 86400 seconds.'
        });
    }

    config.security = config.security || {};
    config.security.pcmApi = { ...(config.security.pcmApi || {}), clientAuth: pcmApiClientAuth };
    config.security.pcmApi.allowAnyTokenResource = req.body.allowAnyTokenResource === true || req.body.allowAnyTokenResource === 'true' || req.body.pcmApi?.allowAnyTokenResource === true;
    config.security.pcmApi.accessTokenExpiresInSeconds = accessTokenExpiresInSeconds;
    delete config.security.pcmApi.introspectionReturnsExpiredTokens;
    config.security.dataSourceGateway = { ...(config.security.dataSourceGateway || {}), clientAuth: dataSourceGatewayClientAuth };
    config.security.serviceProviderToDataSource = {
        ...(config.security.serviceProviderToDataSource || {}),
        verifyServerCertificate: req.body.spDsVerifyServerCertificate === true || req.body.spDsVerifyServerCertificate === 'true' || req.body.serviceProviderToDataSource?.verifyServerCertificate === true
    };
    config.security.dsGatewayToFhirServer = {
        ...(config.security.dsGatewayToFhirServer || {}),
        protocol: dsGatewayToFhirServerProtocol,
        verifyServerCertificate: req.body.dsGatewayToFhirServerVerifyServerCertificate === true || req.body.dsGatewayToFhirServerVerifyServerCertificate === 'true' || req.body.dsGatewayToFhirServer?.verifyServerCertificate === true,
        customUrl: dsGatewayToFhirServerCustomUrl,
        customUrlScope: 'legacy-ds'
    };
    config.security.dsFhirServer = {
        ...(config.security.dsFhirServer || {}),
        enforceMappedPatients: req.body.dsFhirServerEnforceMappedPatients === true || req.body.dsFhirServerEnforceMappedPatients === 'true' || req.body.dsFhirServer?.enforceMappedPatients === true
    };
    const effectiveVerification = getEffectiveConformancePolicy().simulation.controls.serverCertificateVerification;
    if (config.security.serviceProviderToDataSource.verifyServerCertificate !== effectiveVerification ||
        config.security.dsGatewayToFhirServer.verifyServerCertificate !== effectiveVerification) {
        return sendAdminError(req, res, 400, 'Certificate verification is controlled by serverCertificateVerification in security simulation settings.');
    }
    try {
        saveTeamConfig(markRuntimeChange(config, 'security'));
    } catch (error) {
        return sendAdminError(req, res, 400, 'Security settings conflict with the effective conformance policy.', {
            error: error.message,
            effectivePolicy: effectivePolicyReport(getEffectiveConformancePolicy(loadTeamConfig()))
        });
    }
    res.format({
        json: () => res.json({ status: 'saved', security: config.security, applied: 'runtime-reload' }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

/** Save only the optional diagnostic override; all authority and usage remain unchanged. */
router.post('/admin/config/own-token-introspection', (req, res) => {
    if (req.body.adminForm === 'own-token-capability') return saveSecurityForm(req, res);
    if (Object.keys(req.body).some(name => name !== 'allowServiceProviderOwnTokenIntrospection')) return sendAdminError(req, res, 400, 'Unsupported own-token capability fields.');
    const value = req.body.allowServiceProviderOwnTokenIntrospection;
    if (!['default', 'true', 'false', true, false].includes(value)) return sendAdminError(req, res, 400, 'Choose preset default, enabled or disabled.');
    const config = loadTeamConfig();
    if (value === 'default') delete config.security.pcmApi.allowServiceProviderOwnTokenIntrospection;
    else config.security.pcmApi.allowServiceProviderOwnTokenIntrospection = value === true || value === 'true';
    try { saveTeamConfig(markRuntimeChange(config, 'own-token-introspection')); }
    catch (error) { return sendAdminError(req, res, 400, 'Own-token capability settings are invalid.', { error: error.message }); }
    return res.format({
        json: () => res.json({ status: 'saved', capability: require('../../../shared/conformance-policy').serviceProviderOwnTokenIntrospection(config), applied: 'runtime-reload' }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

router.post('/admin/config/simulation', (req, res) => {
    if (req.body.adminForm === 'simulation') return saveSecurityForm(req, res);
    const config = loadTeamConfig();
    if (Object.hasOwn(req.body, 'grantFullClinicalAccess') || Object.hasOwn(req.body, 'completeGrantControl')) return sendAdminError(req, res, 400, 'Full-access controls are retired; explicitly approve a scope.');
    const preset = req.body.preset;
    if (!PRESETS.includes(preset)) return sendAdminError(req, res, 400, 'Unknown security simulation preset.', { allowedValues: PRESETS });
    const requestedMode = preset === 'strict' ? 'strict' : 'connectathon';
    if (requestedMode !== config.conformance.mode) {
        return sendAdminError(req, res, 409, 'Changing strict/connectathon mode requires local deployment recreation.', {
            code: 'restart-required', currentMode: config.conformance.mode, requestedMode,
            nextAction: `node pcm-connectathon/scripts/reconfigure-local-team.js --team-id ${config.teamId} --preset ${preset}`,
            help: 'Use the existing team directory (--teams-root if needed). This preserves volumes, certificates and import records. Set an Admin password in its .env before selecting strict.'
        });
    }
    let perSource;
    try { perSource = typeof req.body.perSourceJson === 'string' ? JSON.parse(req.body.perSourceJson || '{}') : (req.body.perSource || presetSourceDefaults(preset)); }
    catch (error) { return sendAdminError(req, res, 400, 'Per-source simulation overrides must be valid JSON.', { error: error.message }); }
    const defaults = presetSimulationDefaults(preset);
    const submitted = req.body.controls ? { ...defaults, ...req.body.controls } : Object.fromEntries(SIMULATION_CONTROLS.map(name => [name, req.body[`control.${name}`] === 'true']));
    const hasExplicitControls = req.body.completeControls === 'true' || Boolean(req.body.controls)
        || SIMULATION_CONTROLS.some(name => Object.hasOwn(req.body, `control.${name}`));
    const controls = !hasExplicitControls || (preset === 'strict' && !req.body.controls && !SIMULATION_CONTROLS.some(name => Object.hasOwn(req.body, `control.${name}`))) ? defaults : submitted;
    const unknownControls = Object.keys(req.body).filter(key => key.startsWith('control.') && !SIMULATION_CONTROLS.includes(key.slice(8)));
    if (unknownControls.length) return sendAdminError(req, res, 400, 'Unknown security simulation control.', { fields: unknownControls });
    config.conformance = { ...config.conformance, mode: preset === 'strict' ? 'strict' : 'connectathon', preset, policyVersion: POLICY_VERSION, compatibilityAdapters: preset === 'strict' ? [] : config.conformance.compatibilityAdapters };
    config.securitySimulation = { global: controls, perSource, awsCredentialIsolation: true };
    if (config.legacyDataSource) config.legacyDataSource.enabled = preset !== 'strict';
    const full = preset === 'strict' || preset === 'connectathon-mtls';
    config.security.pcmApi.clientAuth = full ? 'mtls' : 'tls';
    if (preset === 'strict') delete config.security.pcmApi.allowServiceProviderOwnTokenIntrospection;
    // Contract environment and its configured lifetime do not change with a security preset.
    config.security.pcmApi.allowAnyTokenResource = false;
    config.security.dataSourceGateway.clientAuth = full ? 'mtls' : 'tls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = controls.serverCertificateVerification;
    // Keep the private listener on TLS so presets reload without replacing HAPI.
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = controls.serverCertificateVerification;
    config.security.dsFhirServer.enforceMappedPatients = true;
    for (const ho of config.healthOrganizations || []) ho.clinicalData.privateFhirBaseUrl = `${config.security.dsGatewayToFhirServer.protocol}://${ho.id}-hapi:8080/fhir`;
    try { saveTeamConfig(markRuntimeChange(config, 'security-simulation')); }
    catch (error) { return sendAdminError(req, res, 400, 'Security simulation settings are invalid.', { error: error.message }); }
    return res.format({
        json: () => res.json({ status: 'saved', effectivePolicy: effectivePolicyReport(getEffectiveConformancePolicy(config)), applied: 'runtime-reload' }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

router.post('/admin/certs/upload-thumbprint', (req, res) => {
    const thumbprint = req.body.thumbprint || req.body.certThumbprint;
    if (!thumbprint || !/^[A-Za-z0-9_-]{20,}$/.test(thumbprint)) return sendAdminError(req, res, 400, 'Team Data Source certificate thumbprint is not valid.', {
        field: 'thumbprint',
        received: thumbprint || '(empty)',
        help: 'Provide the x5t#S256 base64url SHA-256 certificate thumbprint without spaces.'
    });
    const config = loadTeamConfig();
    config.organizations.teamDataSource.certThumbprint = thumbprint;
    saveTeamConfig(markRuntimeChange(config, 'team-data-source-thumbprint'));
    applyTeamConfigToStore(config);
    res.json({ status: 'saved', thumbprint });
});

router.post('/admin/certs/regenerate', (req, res) => {
    try {
        const inventory = require('../../../shared/certificate-renewal').certificateInventory(loadTeamConfig(), CERTS_DIR);
        const review = {
            code: 'certificate-recreation-required', scope: 'registered-team-owned-leaves', rootChanged: false,
            roles: inventory.pairs.map(pair => ({ certificates: pair.cert, roles: pair.roles })), preserved: inventory.preserved,
            help: 'Use rotate-team-certificates.js with the selected local team. Preview first; --apply backs up credentials, stops only that team, publishes a complete validated replacement and recreates listeners without deleting data.'
        };
        // Keep the established API refusal. HTML explains this expected operator boundary,
        // rather than presenting a successful hot reload or an unexplained action failure.
        return res.format({ json: () => sendAdminError(req, res, 409, 'Certificate renewal requires controlled listener recreation. No credentials were changed.', review),
            html: () => res.status(409).send(renderAdminHtml(req, { renewalReview: review })) });
    } catch (error) { return sendAdminError(req, res, 400, error.message); }
});

// The protected Admin middleware above also owns this public-material-only read.
router.get('/admin/certs/certificate', (req, res) => {
    try {
        const pem = require('../admin-certificates').publicCertificate(CERTS_DIR, getCredentialInventory(), req.query);
        res.set('Cache-Control', 'no-store').set('Content-Type', 'application/x-pem-file')
            .set('Content-Disposition', 'attachment; filename="certificate.pem"').send(pem);
    } catch (error) { sendAdminError(req, res, error.statusCode || 404, error.message); }
});

router.get('/admin/certs/download-bundle', (req, res) => {
    res.set('Cache-Control', 'no-store').set('Content-Disposition', `attachment; filename="${loadTeamConfig().teamId}-credentials.json"`).json({
        teamId: process.env.TEAM_ID || 'local',
        exportedAt: new Date().toISOString(),
        warning: 'PCM Connectathon/demo only. Private keys are included for local demo portability.',
        scope: 'Certificate-directory credential files, including private keys and any present CA keys; not a complete team backup.',
        roles: getCredentialInventory(),
        certificates: readCertificateFiles(),
        thumbprints: getCertificateThumbprints()
    });
});

router.get('/admin/certs/download-zip', (req, res) => {
    const zip = buildZip(readCertificateFiles());
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${process.env.TEAM_ID || 'local'}-certificates.zip"`);
    res.send(zip);
});

router.get('/admin/consents', (req, res) => {
    const consents = listEnrichedConsents();
    if (!process.env.TEAM_ADMIN_PASSWORD) return res.set('Cache-Control', 'no-store').json({ consents,
        diagnostics: { schema: 'pcm-consumer-review/1', visibility: 'diagnostic', status: 'unavailable', reason: 'Configure Admin login to inspect private approval records.' } });
    const approvals = Object.fromEntries(consents.map(consent => [consent.id, store.privateRecords.approvals.getDecision(consent.id)]));
    logger.info('PRIVATE_CONSENT_INVENTORY', { visibility: 'diagnostic', component: 'pcm-admin', operation: 'read-private-consent-review', outcome: 'recorded', count: consents.length });
    res.set('Cache-Control', 'no-store').json({ consents, diagnostics: { schema: 'pcm-consumer-review/1', visibility: 'diagnostic', approvals } });
});

router.post('/admin/consents/:id/approve', (req, res) => {
    const consent = store.get('Consent', req.params.id);
    if (!consent) return sendAdminError(req, res, 404, 'Consent was not found, so it could not be approved.', {
        id: req.params.id,
        help: 'Refresh the admin page and approve a consent that still appears in the pending list.'
    });
    try {
        if (!req.body || Object.keys(req.body).some(key => !['sourceIds', 'scopeChoice', 'customScope', 'expectedVersion'].includes(key))
            || req.body.expectedVersion !== consent.meta?.versionId) return res.status(409).json({ error: 'Refresh the pending Consent version; approval accepts only sources and an explicit scope choice.' });
        const options = { expectedVersion: req.body.expectedVersion, scopeChoice: req.body.scopeChoice, customScope: req.body.customScope };
        if (Object.prototype.hasOwnProperty.call(req.body, 'sourceIds')) options.sourceIds = req.body.sourceIds;
        const approved = approveConsent(consent, options);
        res.format({ json: () => res.json({ consent: approved }), html: () => res.redirect(uiUrl('/admin')) });
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

router.post('/admin/consents/:id/decline', (req, res) => {
    const consent = store.get('Consent', req.params.id);
    if (!consent) return sendAdminError(req, res, 404, 'Consent was not found, so it could not be declined.', {
        id: req.params.id,
        help: 'Refresh the admin page and decline a consent that still appears in the pending list.'
    });
    const declined = declineConsent(consent);
    res.format({
        json: () => res.json({ consent: declined }),
        html: () => res.redirect(uiUrl('/admin'))
    });
});

router.get('/admin/logs/view', (req, res) => {
    try {
        const bridge = require('../admin-log-context').bridge(req.query, loadTeamConfig());
        if (bridge.exact) return res.redirect(303, uiUrl('/logs-view') + bridge.query);
        res.type('html').send(renderAdminLogView(req.query, req));
    }
    catch (error) { sendAdminError(req, res, 400, sanitizeLogMessage(error.message)); }
});

router.get('/admin/logs', streamAllLogs);

router.post('/admin/logs/clear', (req, res) => {
    const result = clearAllLogs();
    res.status(result.status === 'cleared' ? 200 : 207).format({
        json: () => res.json(result),
        html: () => result.status === 'cleared' ? res.redirect(uiUrl('/admin'))
            : res.send(renderAdminHtml(req, { adminError: { message: 'Some logs could not be cleared.', statusCode: 207, details: result } }))
    });
});

router.get('/admin/logs/download', streamAllLogs);

router.post('/admin/sanity-check', async (req, res) => {
    const output = await runSanityCheck();
    lastSanityResult = output;
    if (req.get('accept')?.includes('text/html')) return res.redirect(303, uiUrl('/admin?section=logs'));
    res.status(output.ok ? 200 : 500).json(output);
});

/** Explicit retained-policy preview/apply reuses private backup, revision and lifecycle validation. */
/** Existing Doctor browser-address option, not general client registration or scope management. */
router.post('/admin/config/doctor-browser/:action', (req, res) => {
    const allowed = req.params.action === 'preview' ? ['doctorBase'] : ['doctorBase', 'reviewDigest'];
    if (!['preview', 'apply'].includes(req.params.action) || !req.body || Object.keys(req.body).some(key => !allowed.includes(key))) return sendAdminError(req, res, 400, 'Use only the reviewed Doctor browser address fields.');
    try {
        const configuration = require('../doctor-browser-configuration');
        const configPath = require('../team-config').getConfigPath();
        const config = loadTeamConfig();
        const result = req.params.action === 'preview' ? configuration.doctorBrowserPlan(config, store, req.body.doctorBase, fs.readFileSync(configPath))
            : configuration.applyDoctorBrowser({ store, configPath, stateDirectory: process.env.STATE_DIR || config.runtime.stateDir, doctorBase: req.body.doctorBase, reviewDigest: req.body.reviewDigest });
        res.format({ json: () => res.json(result), html: () => res.send(renderAdminHtml(req, { section: 'apps', doctorPreview: req.params.action === 'preview' ? result : null, doctorResult: req.params.action === 'apply' ? result : null })) });
    } catch (error) { sendAdminError(req, res, 409, error.message); }
});

router.get('/admin/workflow-sources/preview', (req, res) => {
    try {
        const config = loadTeamConfig(), plan = require('../workflow-source-configuration').workflowSourceReview(store, config);
        res.format({ json: () => res.json(plan), html: () => res.send(renderAdminHtml(req, { workflowPreview: plan })) });
    } catch (error) { sendAdminError(req, res, 409, error.message); }
});
router.post('/admin/workflow-sources/apply', (req, res) => {
    try {
        const result = require('../../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || loadTeamConfig().runtime.stateDir, lock => {
            const config = loadTeamConfig(), owner = require('../team-config'), workflow = require('../workflow-source-configuration');
            const current = workflow.workflowSourceReview(store, config);
            if (Object.keys(req.body || {}).some(key => !['expectedRevision', 'versions', 'sources', 'sourceVersions', 'reviewDigest'].includes(key))) throw new Error('Apply only the unchanged workflow source review.');
            if (String(req.body?.expectedRevision) !== String(current.revision) || req.body?.reviewDigest !== current.reviewDigest) throw new Error('Workflow policy, source versions or configuration changed. Refresh the preview.');
            // HTML transports exact reviewed objects as JSON; API clients retain structured fields.
            for (const field of ['versions', 'sources', 'sourceVersions']) {
                const value = typeof req.body[field] === 'string' ? JSON.parse(req.body[field]) : req.body[field];
                if (JSON.stringify(value) !== JSON.stringify(current[field])) throw new Error('Workflow policy or sources changed. Refresh the preview.');
            }
            if (current.missingScenarios.length || current.blockers.length || current.policies.some(policy => !policy.validNow)) throw new Error('A workflow Contract is missing, expired or unavailable. Review an explicit valid replacement; this action cannot renew authority.');
            owner.markRuntimeChange(config, 'workflow-source-reconciliation');
            workflow.publishWorkflowConfiguration(store, config, lock);
            return { status: 'applied', revision: config.runtime.revision, policies: current.policies };
        });
        res.format({ json: () => res.json(result), html: () => res.send(renderAdminHtml(req, { workflowResult: result })) });
    } catch (error) { sendAdminError(req, res, error.statusCode || 409, error.message); }
});

/** Preview and apply selected catalog metadata through the existing protected operator boundary. */
router.get('/admin/catalog/preview', (req, res) => {
    try {
        const config = loadTeamConfig();
        if (!config.serviceCatalog) throw new Error('This retained team has not selected an external service catalog');
        const proposed = require('../catalog-bootstrap').proposedCatalog(config);
        res.json(require('../catalog-bootstrap').previewCatalog(store, proposed));
    } catch (error) { res.status(400).json({ error: error.message }); }
});
router.post('/admin/catalog/reconcile', (req, res) => {
    try {
        const config = loadTeamConfig();
        if (!config.serviceCatalog) throw new Error('Select a validated catalog first');
        const proposed = require('../catalog-bootstrap').proposedCatalog(config);
        const backupPath = path.join(process.env.STATE_DIR || '/runtime/state', `catalog-backup-${Date.now()}.json`);
        const applied = store.transaction(() => {
        const resources = require('../catalog-bootstrap').reconcileCatalog(store, proposed, req.body.versions, backup => {
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { flag: 'wx', mode: 0o600 });
        });
        saveTeamConfig(markRuntimeChange(config, 'catalog-reconciliation'));
        return resources;
        });
        res.json({ applied: applied.map(item => `${item.resourceType}/${item.id}`), backupPath });
    } catch (error) { res.status(error.message.includes('conflict') ? 409 : 400).json({ error: error.message }); }
});

router.post('/admin/migration/checkpoint', (req, res) => {
    try {
        const config = loadTeamConfig();
        res.json(require('../migration-checkpoint').prepare({ store, configPath: TEAM_CONFIG_PATH,
            stateDirectory: process.env.STATE_DIR || config.runtime.stateDir, runtimeId: process.env.PCM_MIGRATION_RUNTIME_ID }));
    } catch (error) { res.status(409).json({ error: error.message }); }
});

router.get('/admin/backup', (req, res) => {
    const teamConfig = JSON.parse(fs.readFileSync(TEAM_CONFIG_PATH, 'utf8'));
    res.set('Cache-Control', 'no-store');
    res.attachment('configuration-backup.json').json({
        teamId: teamConfig.teamId, exportedAt: new Date().toISOString(), security: teamConfig.security,
        teamConfig, certificates: readCertificateFiles(), thumbprints: getCertificateThumbprints()
    });
});

router.post('/admin/restore', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const maintenance = require('../admin-maintenance'), owner = require('../team-config');
        const current = loadTeamConfig();
        maintenance.assertOrdinaryRuntime(current);
        const result = require('../../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || current.runtime.stateDir, lock => {
            const latest = loadTeamConfig();
            const candidate = maintenance.validateRestore(req.body, latest, readCertificateFiles());
            // Keep revision monotonic even when an older compatible backup is selected.
            candidate.runtime = { ...latest.runtime };
            markRuntimeChange(candidate, 'restore');
            const recovery = require('../source-publication-recovery'), stateDirectory = process.env.STATE_DIR || latest.runtime.stateDir;
            const staged = recovery.begin({ lock, configPath: TEAM_CONFIG_PATH, directory: CERTS_DIR,
                stateDirectory, material: {}, nextConfig: candidate, sourceId: 'configuration-restore' });
            try {
                store.transaction(() => {
                    require('../workflow-source-configuration').withWorkflowSourceConfiguration(store, candidate, () => owner.publishTeamConfig(candidate));
                    store.clear(); bootstrap.synchronous(); tokens.clear();
                });
            } catch (error) {
                // Retain uncertainty for the established stopped-worker exact-digest recovery.
                if (fs.existsSync(path.join(stateDirectory, 'pcm-ig-041', 'checkpoint-mutation.json'))) throw Object.assign(new Error('Restore publication is uncertain. Stop workers and review configuration-mutation/source-publication.json with recover-mutation.'), { statusCode: 503 });
                try {
                    recovery.recover({ stateDirectory, configPath: TEAM_CONFIG_PATH, certsDirectory: CERTS_DIR,
                        workersStopped: true, expectedDigest: require('../../../shared/migration-hash').hash(staged.journal), retainLock: true });
                } catch (_) { throw Object.assign(new Error('Restore rollback is uncertain. Keep workers stopped; preserve configuration-mutation/source-publication.json and use reviewed exact-digest recover-mutation.'), { statusCode: 503 }); }
                throw error;
            }
            try { fs.rmSync(staged.file); } catch (_) { throw Object.assign(new Error('Restore completed but journal cleanup is uncertain. Keep workers stopped and review the retained configuration journal before recovery.'), { statusCode: 503 }); }
            return { status: 'restored', applied: 'pcm-runtime-reset', revision: candidate.runtime.revision, listenerAdoption: 'not-checked' };
        });
        res.format({ json: () => res.json(result), html: () => res.send(renderAdminHtml(req, { maintenanceResult: 'Configuration restored. PCM resources were reset, issued tokens cleared and the configured catalog bootstrapped. Previous runtime Consents were not restored. Other components’ adoption is not checked.' })) });
    } catch (error) {
        const reason = error.statusCode ? error.message : 'Restoration could not finish. Review the current configuration and local recovery journal before retrying. No backup contents are echoed.';
        sendAdminError(req, res, error.statusCode || 400, `Restore backup failed. ${reason}`);
    }
});

router.post('/admin/reset', (req, res) => {
    try {
        const config = loadTeamConfig(); require('../admin-maintenance').assertOrdinaryRuntime(config);
        require('../../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || config.runtime.stateDir, () => {
            store.transaction(() => { store.clear(); bootstrap.synchronous(); tokens.clear(); });
        });
        res.format({ json: () => res.json({ status: 'reset' }), html: () => res.send(renderAdminHtml(req, { maintenanceResult: 'PCM runtime reset. Issued tokens were cleared and the configured catalog/resources bootstrapped. Runtime Consents and runtime catalog choices were removed. Clinical source data, log history and saved configuration were preserved.' })) });
    } catch (error) { sendAdminError(req, res, error.statusCode || 409, 'PCM reset could not finish. Review migration maintenance, active data operations and the current catalog before retrying.'); }
});

router.get('/ui', renderDashboard);
router.get('/ui/approve/:id', renderApproval);
router.post('/ui/approve/:id', handleApproval);

module.exports = router;
module.exports._test = {
    approveConsent,
    buildDataSourceClientBundle,
    buildDeploymentEndpoints,
    buildZip,
    clearAllLogs,
    CONNECTATHON_REPO_URL,
    getSanityTargets,
    getPublicBaseUrls,
    isAwsRuntime,
    parseMultipartForm,
    readAllLogs,
    renderAdminLogView,
    logImportDiagnostic,
    renderAdminHtml,
    reusePcmClientCertificateForServerTrust,
    sendAdminError
};
