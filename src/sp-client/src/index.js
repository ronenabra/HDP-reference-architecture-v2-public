/**
 * Service Provider (Doctor App) server entrypoint.
 */
const express = require('express');
const path = require('path');
const {
    loadSandboxPatientSample,
    beginSmartAuthorization,
    checkConsentStatus,
    createConsentRequest,
    exchangeSmartAuthorization,
    fetchData,
    getConformanceInfo,
    requestCatalogUpdate,
    searchServices,
    readOwnedService,
    resetCache
} = require('./client');
const { isTestAutoApproved, relaxedConsentSources } = require('../../shared/consent-presentation');
const { getIdentities, getIdentityIds, getDefaultIdentity } = require('./identities');
const { choosePatientId, loadEffectivePolicy, loadPublicBaseUrls, loadTeamId } = require('./team-config');
const { applyModeWarningHeaders, logPolicyBanner } = require('../../shared/conformance-policy');

const { loadTeamConfig } = require('./team-config');
const { sampleSources } = require('../../shared/sandbox-patients');
const { patientChoice, identifierTypes, patientErrorField } = require('./patient-choice');
const library = new (require('./patient-library').PatientLibrary)();
const app = express();
const browserPage = require('../../shared/browser-page');
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'shared', 'ui')));
browserPage.prepareBrowserErrors(app, req => doctorPageContext(req));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Logging Middleware ---
const logger = require('./logger');
const fs = require('fs');
const crypto = require('node:crypto');
const { smartBrowserBinding, smartBrowserHash } = require('./smart-authorization');
const effectivePolicy = loadEffectivePolicy();
app.use((req, res, next) => {
    applyModeWarningHeaders(res, effectivePolicy);
    next();
});
app.use(logger.requestLogger);
/** Configured mount only; request hosts never become callback registrations. */
const localUrl = route => require('../../shared/browser-navigation').applicationPath(loadTeamConfig().publicBaseUrls.spClient, route);
/** Keep a known requesting application in safe utility-page returns without echoing arbitrary URLs.
 * @param {object} req Native Doctor request.
 * @returns {object} Shared page context with the existing exact application selection.
 */
function doctorPageContext(req) {
    const context = browserPage.pageContext(loadTeamConfig(), req, 'spClient');
    const identity = req.body?.identity ?? req.query.identity;
    if (typeof identity === 'string' && getIdentityIds().includes(identity)) {
        context.returnTo = localUrl(`/?identity=${encodeURIComponent(identity)}`);
        context.urls.spClient = context.returnTo;
    }
    return context;
}
app.use((req, res, next) => { res.locals.browserBase = localUrl('/').replace(/\/$/, ''); next(); });

// Reject malformed/unknown identities before any client call, lookup or local mutation.
app.use((req, res, next) => {
    const identity = req.body?.identity ?? req.query.identity;
    if (identity !== undefined && (typeof identity !== 'string' || !getIdentityIds().includes(identity))) {
        return res.status(400).json({ error: 'Unknown Doctor identity', allowed: getIdentityIds() });
    }
    next();
});

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', service: 'sp-client', conformanceMode: effectivePolicy.mode });
});

// --- Logging Routes ---
/**
 * Render the logs viewer UI.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.get('/logs-view', (req, res) => {
    res.render('logs', { serviceName: 'Doctor App', teamId: loadTeamId(), publicUrls: loadPublicBaseUrls(req) });
});

/**
 * Return recent log entries for the UI.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.get('/api/logs', (req, res) => {
    try {
        const content = fs.readFileSync(logger.getLogPath(), 'utf8');
        const logs = content.trim().split('\n').filter(Boolean).map(line => {
            try { return JSON.parse(line); } catch (_) { return null; }
        }).filter(Boolean).reverse();
        res.set('X-Log-State', logs.length ? 'available' : 'empty');
        res.json(logs);
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.set('X-Log-State', 'missing');
            return res.json([]);
        }
        res.status(503).json({ error: 'Doctor log file is unavailable', code: error.code || 'read-error' });
    }
});

// Store consent ID in memory for session simulation
const consents = new Map(); // Store consents: id -> { consent, data, validationError }
const lastPatientIdByIdentity = new Map();
const smartTransactions = new Map();
const { createSmartFeedback, smartFailure } = require('./smart-feedback');
const smartFeedback = createSmartFeedback();
/** Keep result feedback on the same private browser capability as the protocol state. */
function smartBrowser(req, res) {
    const binding = smartBrowserBinding(req) || crypto.randomBytes(32).toString('base64url');
    res.cookie('pcmDoctorSmartBrowser', binding, { httpOnly: true, sameSite: 'lax', secure: new URL(loadTeamConfig().publicBaseUrls.spClient).protocol === 'https:', path: localUrl('/'), maxAge: 300000 });
    return binding;
}

const selections = new (require('./selection-state').SelectionState)((identity, serviceId) => {
    resetCache(identity);
    for (const record of consents.values()) if (record.owner === identity && (!serviceId || consentServiceId(record.consent) === serviceId)) { record.sourceRevision = (record.sourceRevision || 0) + 1; record.data = null; record.tokenGrant = null; record.tokenStatus = null; record.authorityBlocked = false; record.validationError = null; record.selectedEndpoint = null; delete record.consent.discoveredEndpoint; delete record.consent.discoveredEndpoints; }
});
/** Preserve the exact stored Consent association independently of picker paging/selection. */
function consentServiceId(consent) {
    const { EXTENSIONS } = require('../../shared/pcm-contract');
    const reference = consent?.extension?.find(item => item.url === EXTENSIONS.pcmService)?.valueReference?.reference;
    return /^HealthcareService\/([A-Za-z0-9.-]{1,64})$/.exec(reference || '')?.[1] || '';
}
const serviceLists = new (require('./service-list-state').ServiceListState)(searchServices,
    (identity, id) => selections.invalidate(identity, id), identity => selections.revision(identity),
    () => crypto.createHash('sha256').update(JSON.stringify(loadTeamConfig())).digest('hex'));
/** Resolve an off-page association with ordinary exact reads; failures never invent permission/defaults. */
async function resolveService(identity, id, record) {
    if (!id) throw new Error('Consent service is unresolved. Check its status before retrieving data.');
    const revision = selections.revision(identity);
    const service = await readOwnedService(id, identity);
    if (selections.revision(identity) !== revision) throw new Error('Selection changed while reading the service; refresh and retry');
    serviceLists.observe(identity, service, record?.serviceProjection);
    if (!service.available) selections.invalidate(identity, id);
    if (record) record.serviceProjection = service;
    return service;
}
/** Use the UI destination listener and shared remote-host/path-prefix navigation policy. */
function manageServicesUrl(identity, req) {
    const role = require('./service-directory').providerRole(identity);
    if (!role) return '';
    const base = loadPublicBaseUrls(req).pcmUi;
    return `${base.replace(/\/$/, '')}/admin/services?providerRole=${role}`;
}
/** Cancel abandoned browser loads without aborting another provider's work. */
function requestSignal(res) {
    const controller = new AbortController();
    res.once?.('close', () => { if (!res.writableEnded) controller.abort(); });
    return controller.signal;
}
let flash = null; // { type: 'success'|'error', message: '' }

function logHarnessAction(eventType, operation, details = {}, level = 'info') {
    logger[level](`Harness ${operation}: ${eventType.toLowerCase().replace(/_/g, ' ')}`, {
        type: eventType,
        category: 'harness',
        visibility: 'diagnostic',
        operation,
        causesSystemFlow: ['create-consent', 'discover-source', 'fetch-data'].includes(operation),
        ...details
    });
}

/**
 * Render the main dashboard with current consents.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.get('/', async (req, res) => {
    const identities = getIdentities();
    const identityIds = getIdentityIds();
    const requestedIdentity = req.query.identity || getDefaultIdentity();
    const currentIdentity = identityIds.includes(requestedIdentity) ? requestedIdentity : getDefaultIdentity();

    // Search on Load (Refresh from Server)
    try {
        const remoteConsents = await require('./client').searchConsents(currentIdentity);
        for (const c of remoteConsents) {
            if (!consents.has(c.id)) {
                consents.set(c.id, {
                    id: c.id,
                    consent: c,
                    data: null,
                    owner: currentIdentity, // Assume ownership if returned by search
                    validationError: null
                });
            } else {
                // Update existing status
                const validRecord = consents.get(c.id);
                // Only update if ownership matches (security safety)
                if (validRecord.owner === currentIdentity) {
                    await require('./consent-refresh').refreshConsent(validRecord, c, { discover: checkConsentStatus, resetCache });
                }
            }
        }
    } catch (err) {
        console.error('Failed to search consents on load:', err.message);
        // Don't crash UI, just show what we have or nothing
    }

    if (!serviceLists.get(currentIdentity)) {
        try { await serviceLists.update(currentIdentity, { signal: requestSignal(res) }); } catch (_) { /* Explicit unavailable/error state below. */ }
    }
    const selected = selections.get(currentIdentity);
    const visibleConsents = [];
    const resolved = new Map();
    // Bound exact reads for historical/off-page references. Remaining cards explain not-yet-loaded.
    const ids = [...new Set([selected?.serviceId, ...[...consents.values()].filter(record => record.owner === currentIdentity).map(record => consentServiceId(record.consent))].filter(Boolean))].slice(0, 5);
    for (const id of ids) {
        const record = [...consents.values()].find(record => record.owner === currentIdentity && consentServiceId(record.consent) === id);
        try { resolved.set(id, await resolveService(currentIdentity, id, record)); }
        catch (_) {
            selections.invalidate(currentIdentity, id);
            const unavailable = { ...(serviceLists.get(currentIdentity)?.services.find(service => service.id === id) || {}), id, available: false, readiness: 'Service could not be revalidated; refresh to retry' };
            serviceLists.observe(currentIdentity, unavailable);
            resolved.set(id, unavailable);
        }
    }
    for (const record of consents.values()) {
        if (record.owner !== currentIdentity) continue;
        const service = resolved.get(consentServiceId(record.consent)) || { available: false, readiness: 'Service not yet loaded. Refresh status and sources to resolve this exact association.' };
        // One bounded exact read serves every historical card for this association.
        // Leaving a sibling's old projection behind would invalidate a later fetch
        // again even after this page had already reviewed the changed definition.
        if (resolved.has(consentServiceId(record.consent))) record.serviceProjection = service;
        if (record.tokenGrant?.expiresAt <= Date.now()) {
            record.data = null; record.tokenGrant = null; record.tokenStatus = { state: 'expired', message: 'Token expired locally; no current clinical authority.' };
        }
        const approval = require('./approval-presentation').approvalPresentation(record.consent, service, record);
        visibleConsents.push({ ...record, service, sourceMembership: require('./consent-refresh').sourceSignature(record.consent), approval: { ...approval, queryScope: service.available ? approval.queryScope : '' },
            testAutoApproved: isTestAutoApproved(record.consent), testIdentity: record.consent?.patient?.identifier?.system === require('./constants').IDENTIFIER_SYSTEMS.syntheticTest });
    }
    const serviceList = serviceLists.get(currentIdentity) || { services: [], error: 'Service load cancelled; refresh to retry', complete: false, warnings: [] };
    const services = serviceList.services, serviceError = serviceList.error;
    const patientInventory = library.get(currentIdentity, loadTeamConfig());
    const patients = library.choices(currentIdentity, loadTeamConfig());
    res.render('index', {
        consents: visibleConsents,
        tokenInspection: require('./client').ownTokenInspectionCapability(),
        services: services.map(service => ({ ...service, summary: require('./service-directory').serviceSummary(service) })), serviceError, serviceList, manageServicesUrl: manageServicesUrl(currentIdentity, req),
        selectedServiceId: selected?.serviceId || '',
        identities,
        currentIdentity,
        flash: smartFeedback.take(smartBrowserHash(smartBrowserBinding(req))) || flash,
        patients,
        identifierTypes: identifierTypes(),
        patientInventory,
        selectedPatientId: selected ? selected.patientId : choosePatientId(lastPatientIdByIdentity.get(currentIdentity), patients),
        publicBaseUrls: loadPublicBaseUrls(req),
        relaxedSources: relaxedConsentSources(loadEffectivePolicy()),
        conformance: getConformanceInfo(),
        sandboxNotice: require('./doctor-notice').doctorNotice(loadTeamConfig(), loadEffectivePolicy()),
        teamId: loadTeamId()
    });
    flash = null; // Consume flash
});

/** Explicit service discovery actions retain selected provider credentials and bounded paging state. */
for (const action of ['refresh', 'next']) app.post(`/services/${action}`, async (req, res) => {
    const identity = req.body.identity || getDefaultIdentity();
    try {
        if (action === 'next' && !req.body.continuation) throw new Error('No current service continuation. Refresh to retry.');
        if (action === 'refresh') selections.invalidate(identity);
        await serviceLists.update(identity, { ...(action === 'next' ? { continuation: req.body.continuation } : {}), signal: requestSignal(res) });
    } catch (error) { flash = { type: 'error', message: error.message }; }
    if (!res.destroyed) res.redirect(303, localUrl(`/?identity=${encodeURIComponent(identity)}`));
});

app.get('/smart/start', async (req, res) => {
    const identity = req.query.identity || getDefaultIdentity();
    const binding = smartBrowser(req, res);
    try {
        const transaction = await beginSmartAuthorization({ identity, scope: req.query.scope || 'patient/*.rs', browserRequest: req });
        for (const [state, record] of smartTransactions) if (record.transaction.expiresAt <= Date.now()) smartTransactions.delete(state);
        if (smartTransactions.size >= 500) throw new Error('Too many pending SMART tests. Wait for older tests to expire and start again.');
        smartTransactions.set(transaction.state, { transaction, identity, browserHash: smartBrowserHash(binding) });
        res.redirect(transaction.authorizationUrl);
    } catch (error) {
        let canonicalStartUrl;
        if (error.canonicalBase) { const url = new URL(`${error.canonicalBase}/smart/start`); url.searchParams.set('identity', identity); url.searchParams.set('scope', req.query.scope || 'patient/*.rs'); canonicalStartUrl = url.toString(); }
        smartFeedback.put(smartBrowserHash(binding), { ...smartFailure(error, 'start'), canonicalStartUrl });
        res.redirect(localUrl(`/?identity=${identity}`));
    }
});

app.get('/callback', async (req, res) => {
    const record = smartTransactions.get(req.query.state);
    if (record?.transaction.expiresAt <= Date.now()) smartTransactions.delete(req.query.state);
    if (!record || record.transaction.expiresAt <= Date.now() || record.browserHash !== smartBrowserHash(smartBrowserBinding(req))) {
        smartFeedback.put(smartBrowserHash(smartBrowser(req, res)), smartFailure({}, 'state'));
        return res.redirect(localUrl('/'));
    }
    smartTransactions.delete(req.query.state);
    try {
        const token = await exchangeSmartAuthorization(record.transaction, req.query, record.identity);
        smartFeedback.put(record.browserHash, { type: 'success', smart: true, message: 'SMART code exchange completed', explanation: 'This test created no clinical Consent and performed no clinical data retrieval. The exchanged application token is not used by Doctor clinical requests.', scope: token.scope });
    } catch (error) {
        smartFeedback.put(record.browserHash, smartFailure(error, 'exchange'));
    }
    return res.redirect(localUrl(`/?identity=${record.identity}`));
});

/**
 * Create a new consent request.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
/** Dedicated library screen is offline until the explicit bounded-load action. */
app.get('/patients', (req, res) => {
    const identity = req.query.identity || getDefaultIdentity(), config = loadTeamConfig();
    res.render('patients', {
        teamId: config.teamId, identity, applicationLabel: getIdentities().find(client => client.id === identity)?.label || identity,
        publicBaseUrls: loadPublicBaseUrls(req), conformance: getConformanceInfo(),
        sandboxNotice: require('./doctor-notice').doctorNotice(config, loadEffectivePolicy()),
        fixed: library.offline(), sources: sampleSources(config), state: library.get(identity, config)
    });
});
app.post('/patients/source', (req, res) => {
    const identity = req.body.identity || getDefaultIdentity(), config = loadTeamConfig();
    if (!sampleSources(config).some(source => source.id === req.body.sourceId)) return res.status(400).json({ error: 'Unsupported source' });
    const state = library.invalidate(identity, config, req.body.sourceId, req.body.cancelled === true);
    res.json({ state: state.state, generation: state.generation });
});
app.post('/patients/load', async (req, res) => {
    const identity = req.body.identity || getDefaultIdentity(), config = loadTeamConfig(), controller = new AbortController();
    let pending;
    res.once('close', () => {
        if (!res.writableEnded) { controller.abort(); library.fail(identity, loadTeamConfig(), pending, new Error('Refresh cancelled')); }
    });
    try {
        if (Object.keys(req.body).some(key => !['identity', 'sourceId'].includes(key))) throw new Error('Closed load request required');
        pending = library.begin(identity, config, req.body.sourceId);
        const result = await loadSandboxPatientSample(req.body.sourceId, identity, controller.signal);
        if (controller.signal.aborted) throw new Error('Refresh cancelled');
        const current = library.complete(identity, loadTeamConfig(), pending, result);
        return res.json({ ...result, patients: current.candidates, generation: current.generation });
    } catch (error) {
        library.fail(identity, loadTeamConfig(), pending, error);
        if (!res.destroyed) return res.status(400).json({ error: error.response?.data?.error || error.message });
    }
});
app.post('/patients/select', (req, res) => {
    const identity = req.body.identity || getDefaultIdentity();
    try {
        const patient = patientChoice(req.body.patientId, req.body.patientSystem, loadTeamConfig());
        if (req.body.sampleGeneration !== undefined) {
            const current = library.get(identity, loadTeamConfig());
            if (String(current.generation) !== String(req.body.sampleGeneration) || !current.candidates.some(candidate => `${candidate.idSystem}|${candidate.idValue}` === patient.key)) throw new Error('This sample changed. Load the current sample and choose again.');
        }
        lastPatientIdByIdentity.set(identity, patient.key); selections.select(identity, patient.key, selections.get(identity)?.serviceId || '');
        const location = localUrl(`/?identity=${encodeURIComponent(identity)}`);
        return req.get('accept') === 'application/json' ? res.json({ location }) : res.redirect(303, location);
    } catch (error) {
        if (String(req.get('accept') || '').includes('text/html')) return browserPage.sendBrowserError(req, res, { ...doctorPageContext(req), status: 400, message: error.message, returnTo: localUrl(`/patients?identity=${encodeURIComponent(identity)}`) });
        return res.status(400).send(error.message);
    }
});

app.post('/selection', (req, res) => {
    const identity = req.body.identity || getDefaultIdentity();
    if (req.body.identityExit) { selections.invalidate(identity); return res.json({ status: 'cleared' }); }
    if (req.body.sourceConsentId) {
        const record = consents.get(req.body.sourceConsentId);
        let queryPlan, queryError;
        if (record?.owner === identity) {
            if (typeof req.body.requestedScope === 'string') {
                record.querySelection = req.body.requestedScope;
                record.queryContext = require('./consent-refresh').permissionSignature(record.consent);
                try { queryPlan = require('./permission-plan').planQueries(require('./permission-plan').validateSelection(record.querySelection), record.querySelection); }
                catch (error) { queryError = error.message; }
            }
            resetCache(identity);
            if (typeof req.body.endpointUrl === 'string') record.selectedEndpoint = req.body.endpointUrl;
            if (typeof req.body.fhirGetRequest === 'string') record.fhirGetRequest = req.body.fhirGetRequest;
            record.sourceRevision = (record.sourceRevision || 0) + 1; record.data = null; record.tokenGrant = null; record.tokenStatus = null; record.authorityBlocked = false; record.validationError = null; }
        return res.json({ status: 'cleared', queryPlan, queryError });
    }
    let patientId = String(req.body.patientId || '').trim(), patientError = '', patientField = 'value', patient;
    if (patientId) {
        try { patient = patientChoice(patientId, req.body.patientSystem, loadTeamConfig()); patientId = patient.key; }
        catch (error) {
            patientField = patientErrorField(error);
            patientError = patientField === 'system'
                ? 'System URI is unsupported or empty. Choose a listed identifier type or enter its exact supported URI.'
                : `${error.message}. Check the identifier value, or choose a supported patient.`;
        }
    } else patientError = 'Enter an exact identifier value or choose a patient.';
    selections.select(identity, patientId, String(req.body.serviceId || ''));
    res.json({ status: 'cleared', patientError, patientField, patient: patient ? { system: patient.system, value: patient.value, automaticTestApproval: patient.synthetic } : null });
});

app.post('/create-consent', async (req, res) => {
    const identity = typeof req.body.identity === 'string' ? req.body.identity : '';
    let patientId = String(req.body.patientId || '').trim();
    logHarnessAction('HARNESS_ACTION_STARTED', 'create-consent', { identity, patientId });
    if (patientId) lastPatientIdByIdentity.set(identity, patientId);
    try {
        if (!require('./service-directory').providerRole(identity)) throw new Error('Choose a registered requesting application; no default provider is used for creation');
        patientId = patientChoice(patientId, req.body.patientSystem, loadTeamConfig()).key;
        const serviceId = String(req.body.serviceId || '');
        const revision = selections.revision(identity);
        const service = await resolveService(identity, serviceId);
        if (serviceLists.get(identity)?.stale) throw new Error('Service refresh failed; current readiness is unknown. Refresh services successfully and review the selection before creating a request');
        if (!service.available || revision !== selections.revision(identity) || req.body.serviceStamp !== service.signature) throw new Error('Choose a currently usable owned registration and refresh after service changes');
        selections.select(identity, require('../../shared/identity-mapping').toPatientContext(patientId), serviceId);
        const consent = await createConsentRequest(patientId, serviceId, identity);

        consents.set(consent.id, {
            id: consent.id,
            consent: consent,
            data: null,
            owner: identity,
            validationError: null
        });
        flash = { type: 'success', message: 'Consent request created. Check its recorded PCM status; creation does not fetch data or prove a patient decision.' };
        logHarnessAction('HARNESS_ACTION_COMPLETED', 'create-consent', { identity, consentId: consent.id });

    } catch (err) {
        flash = { type: 'error', message: 'Failed to create consent request: ' + err.message };
        logHarnessAction('HARNESS_ACTION_FAILED', 'create-consent', { identity, error: err }, 'error');
    }
    res.redirect(localUrl(`/?identity=${identity}`));
});

/**
 * Discover consent status and endpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.post('/discover', async (req, res) => {
    const identity = req.body.identity || 'hospital-a';
    const consentId = req.body.consentId;
    logHarnessAction('HARNESS_ACTION_STARTED', 'discover-source', { identity, consentId });

    try {
        if (!consentId) throw new Error('No consent ID provided');

        // History is authoritative independently of whether its service can still execute.
        let record = consents.get(consentId);
        if (record && record.owner !== identity) throw new Error('Consent belongs to another provider');
        const contextRevision = selections.revision(identity);
        const sourceRevision = record ? (record.sourceRevision = (record.sourceRevision || 0) + 1) : 0;
        if (record) { record.data = null; record.tokenGrant = null; record.tokenStatus = null; record.authorityBlocked = false; record.validationError = null; }
        const assertCurrent = () => {
            if (selections.revision(identity) !== contextRevision || (consents.get(consentId) || null) !== (record || null)
                || record && record.sourceRevision !== sourceRevision) throw new Error('Selection or Consent sources changed while refreshing status; refresh status and sources again');
        };
        const updated = await checkConsentStatus(consentId, identity);
        assertCurrent();
        if (updated) {
            if (updated.id !== consentId || Number(updated.meta?.versionId) < Number(record?.consent?.meta?.versionId)) throw new Error('Consent changed during discovery; refresh its current history');
            const history = { ...updated };
            delete history.discoveredEndpoint; delete history.discoveredEndpoints;
            if (!record) {
                record = { id: consentId, owner: identity, sourceRevision, data: null, validationError: null };
                consents.set(consentId, record);
            }
            record.consent = history;
            record.selectedEndpoint = null;
            resetCache(record.owner);

            // Readiness may fail or invalidate generations; neither can discard the saved history.
            const serviceId = consentServiceId(updated);
            let service;
            try {
                service = serviceId ? await readOwnedService(serviceId, identity)
                    : { available: false, readiness: 'Consent service is unresolved' };
            } catch (_) {
                service = { ...record.serviceProjection, id: serviceId, available: false, readiness: 'Service could not be revalidated; refresh to retry' };
            }
            assertCurrent();
            if (Number(record.consent.meta?.versionId) > Number(updated.meta?.versionId)) throw new Error('Newer Consent history arrived during service revalidation; refresh status and sources again');
            serviceLists.observe(identity, service, record.serviceProjection);
            if (!service.available) selections.invalidate(identity, serviceId || undefined);
            record.serviceProjection = service;
            const ready = service.available && updated.status === 'active';
            if (ready) record.consent = updated;
            const endpointCount = ready ? updated.discoveredEndpoints?.length || (updated.discoveredEndpoint ? 1 : 0) : 0;
            flash = { type: ready ? 'success' : 'warning', message: `Status and sources refreshed. Recorded PCM status: ${updated.status}. Data sources: ${endpointCount}.${ready ? '' : `. History refreshed; ${service.available ? 'Consent is not active' : service.readiness}. Source actions remain unavailable.`}` };
            logHarnessAction('HARNESS_ACTION_COMPLETED', 'discover-source', {
                identity, consentId, status: updated.status, endpointCount
            });
        } else {
            flash = { type: 'warning', message: 'Consent not found on PCM or no access.' };
            logHarnessAction('HARNESS_ACTION_COMPLETED', 'discover-source', {
                identity,
                consentId,
                status: 'not-found'
            }, 'warn');
        }

    } catch (err) {
        flash = { type: 'error', message: 'Could not refresh status and sources: ' + err.message };
        logHarnessAction('HARNESS_ACTION_FAILED', 'discover-source', { identity, consentId, error: err }, 'error');
    }
    res.redirect(localUrl(`/?identity=${identity}`));
});

/**
 * Fetch patient data from a data source.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.post('/fetch-data', async (req, res) => {
    const identity = req.body.identity || 'hospital-a';
    const consentId = req.body.consentId;
    const endpointUrl = req.body.endpointUrl; // From Editable Field
    const requestedScope = String(req.body.requestedScope || '').trim();
    const fhirGetRequest = req.body.fhirGetRequest ?? '';
    let jsonResult = { status: 'fail', error: 'Fetch did not complete' };
    let jsonStatusCode = 500;
    logHarnessAction('HARNESS_ACTION_STARTED', 'fetch-data', { identity, consentId, endpointUrl });

    try {
        if (!consentId) throw new Error('No consent ID provided');
        require('./clinical-fetch-query').validateGetRequestOverride(fhirGetRequest);

        const actionRevision = selections.revision(identity);
        let record = consents.get(consentId);
        if (record && record.owner !== identity) throw new Error('Consent belongs to another provider');
        if (!record) {
            const consent = await checkConsentStatus(consentId, identity);
            if (selections.revision(identity) !== actionRevision) throw new Error('Selection changed while reading Consent; refresh status and sources again');
            if (!consent) throw new Error('Consent is unavailable. Use Refresh status and sources to resolve its exact context first');
            record = { id: consentId, consent, data: null, owner: identity, validationError: null };
            consents.set(consentId, record);
        }
        if (record.authorityBlocked) throw new Error('Token authority was invalidated. Check / Discover the current Consent before requesting a new grant.');
        // Fence at action start, including time spent revalidating the exact service.
        const sourceRevision = record.sourceRevision = (record.sourceRevision || 0) + 1;
        record.data = null; record.tokenGrant = null; record.tokenStatus = null;
        const service = await resolveService(identity, consentServiceId(record.consent), record);
        if (record.sourceRevision !== sourceRevision) throw new Error('Selection or Consent sources changed during service revalidation; refresh and fetch again');
        if (!service.available) throw new Error(service.readiness + '; refresh services and obtain a fresh valid grant as needed');
        record.querySelection = requestedScope;
        record.fhirGetRequest = fhirGetRequest;
        record.queryContext = require('./consent-refresh').permissionSignature(record.consent);
        if (!requestedScope) throw new Error('FHIR query actions are unresolved. Check the exact Consent and choose supported actions; no fallback is used.');

        // Use User-Provided URL or Fallback (only if provided or discovered)
        const targetUrl = endpointUrl || record.consent?.discoveredEndpoint || process.env.DS_GATEWAY_URL || 'https://ds-gateway:8080/fhir';

        // Each new fetch supersedes older source/scope requests, including another tab.
        try {
            const data = await fetchData(consentId, targetUrl, identity, requestedScope, fhirGetRequest);
            if (consents.get(consentId) !== record || (record.sourceRevision || 0) !== sourceRevision) throw new Error('Selection or Consent sources changed during retrieval; refresh and fetch again');
            record.data = data;
            record.tokenGrant = data.preview?.effectiveGrant || null;
            record.tokenStatus = null;
            record.fetchedAt = new Date().toISOString();
            record.selectedEndpoint = targetUrl;
            record.fetchOutcome = null;
            record.validationError = null;
            // Successful retrieval never changes PCM's recorded approval decision.
            record.lastAccess = 'retrieved';

            flash = { type: data.preview?.outcome === 'partial' ? 'warning' : 'success', message: fhirGetRequest ? 'Custom FHIR GET finished. Review the response below.' : 'First-page retrieval finished. Review the patient, source and per-type limits below.' };
            jsonResult = { status: 'success', identity, consentId, targetUrl, data };
            jsonStatusCode = 200;
            logHarnessAction('HARNESS_ACTION_COMPLETED', 'fetch-data', {
                identity,
                consentId,
                targetUrl,
                resourceType: data?.resourceType
            });

        } catch (err) {
            const limited = ['read_only_limitation', 'query_not_granted'].includes(err.classification);
            if (!limited) console.error('Fetch Failed', err.message);
            if (consents.get(consentId) === record && (record.sourceRevision || 0) === sourceRevision) {
                record.tokenGrant = err.grant || null;
                if (err.classification === 'invalid_token_state') { record.authorityBlocked = true; record.tokenStatus = { state: 'invalid', message: err.message }; }
                record.validationError = err.message;
                record.fetchOutcome = err.classification === 'read_only_limitation' ? 'Read-only limitation: no search sent' : err.classification === 'query_not_granted' ? 'Selected operations not granted: no search sent' : record.consent?.status === 'proposed' ? 'Awaiting approval'
                    : require('./clinical-preview').failureEvidence('', err).outcome === 'denied' || err.classification === 'denied' ? 'Denied' : 'Unavailable or failed';
                record.data = null;
            }
            flash = { type: limited ? 'warning' : 'error', message: (limited ? 'Selection limitation: no source request sent. ' : 'Fetch Failed: ') + err.message };
            jsonResult = { status: limited ? 'limited' : 'fail', identity, consentId, targetUrl, error: err.message, classification: err.classification };
            // An invalid successful upstream response is a failed retrieval for this caller.
            const upstreamStatus = err.response?.status;
            jsonStatusCode = limited ? 422 : Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
            logHarnessAction(limited ? 'HARNESS_ACTION_LIMITED' : 'HARNESS_ACTION_FAILED', 'fetch-data', { identity, consentId, targetUrl, error: err }, limited ? 'info' : 'error');
        }

    } catch (err) {
        flash = { type: 'error', message: 'Fetch Action Failed: ' + err.message };
        jsonResult = { status: 'fail', identity, consentId, endpointUrl, error: err.message };
        jsonStatusCode = 400;
        logHarnessAction('HARNESS_ACTION_FAILED', 'fetch-data', { identity, consentId, endpointUrl, error: err }, 'error');
    }
    if (req.get('accept')?.includes('application/json')) {
        return res.status(jsonStatusCode).json(jsonResult);
    }
    res.redirect(localUrl(`/?identity=${identity}`));
});

/** Status is an explicit card-bound action and never issues a token or dispatches source data. */
app.post('/token-status', async (req, res) => {
    const identity = req.body.identity || getDefaultIdentity(), record = consents.get(req.body.statusConsentId);
    try {
        if (!record || record.owner !== identity || !record.tokenGrant || record.tokenGrant.generation !== req.body.generation) throw new Error('No applicable token for this application and Consent.');
        const revision = record.sourceRevision || 0, grant = record.tokenGrant;
        logHarnessAction('HARNESS_ACTION_STARTED', 'check-token-status', { identity, consentId: record.id, compatibility: 'sandbox-own-sp-token-introspection' });
        const status = await require('./client').checkTokenStatus(record.id, grant.audience, identity, grant.generation);
        const sameToken = record.tokenGrant?.generation === grant.generation && record.tokenGrant?.audience === grant.audience;
        const changed = (record.sourceRevision || 0) !== revision || record.tokenGrant !== grant;
        // A concurrent fetch can reuse the same credential. An authoritative denial
        // still clears that exact generation; a late denial cannot clear a new token.
        if (consents.get(record.id) !== record || changed && !(status.authoritative && sameToken)) throw new Error('Token status result superseded by a context change.');
        if (grant.expiresAt <= Date.now() || status.authoritative) {
            resetCache(identity); record.tokenGrant = null; record.data = null; record.authorityBlocked = true;
            record.sourceRevision = (record.sourceRevision || 0) + 1;
            record.tokenStatus = grant.expiresAt <= Date.now() ? { state: 'expired', message: 'Token expired locally' } : status;
        } else record.tokenStatus = { ...status, ...(status.checkedAt ? {} : { previousCheckedAt: record.tokenStatus?.checkedAt || record.tokenStatus?.previousCheckedAt }) };
        logHarnessAction('HARNESS_ACTION_COMPLETED', 'check-token-status', { identity, consentId: record.id, compatibility: 'sandbox-own-sp-token-introspection', outcome: record.tokenStatus.state });
    } catch (error) {
        logHarnessAction('HARNESS_ACTION_FAILED', 'check-token-status', { identity, consentId: req.body.statusConsentId, message: error.message }, 'error');
        flash = { type: 'error', message: error.message };
    }
    res.redirect(303, localUrl(`/?identity=${encodeURIComponent(identity)}`));
});

// --- Organization Management Routes ---

/** Render current records and an optional rejected draft only in this response.
 * Drafts never enter a URL, shared flash, browser storage or a new persistence store.
 * @param {object} req Native management request.
 * @param {object} res Express response.
 * @param {object} options Current identity, feedback and rejected form values.
 * @returns {Promise<void>} Rendered management response.
 */
async function renderManagement(req, res, { identity, feedback = null, draft = null, status = 200 }) {
    let orgs = [], endpoints = [];
    try {
        const bundle = await require('./client').fetchMyOrganization(identity);
        orgs = (bundle?.entry || []).filter(e => e.resource?.resourceType === 'Organization').map(e => e.resource);
        endpoints = (bundle?.entry || []).filter(e => e.resource?.resourceType === 'Endpoint').map(e => e.resource);
    } catch (error) {
        feedback = { type: 'error', message: `${feedback ? feedback.message + ' ' : ''}Organization records could not be loaded: ${error.response?.data?.issue?.[0]?.diagnostics || error.message}` };
    }
    res.status(status).render('manage', { identity, orgs, endpoints, identities: getIdentities(), flash: feedback,
        draft, currentIdentity: identity, publicBaseUrls: loadPublicBaseUrls(req), teamId: loadTeamId() });
}
app.get('/manage', async (req, res) => {
    const feedback = flash; flash = null;
    await renderManagement(req, res, { identity: req.query.identity || 'hospital-a', feedback });
});

/**
 * Update an Organization resource.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.post('/manage/org', async (req, res) => {
    const identity = req.body.identity || 'hospital-a';
    const { id, jsonContent } = req.body;

    try {
        if (!jsonContent) throw new Error("No JSON content provided");
        let updateData = JSON.parse(jsonContent);

        if (updateData.id !== id) throw new Error("ID mismatch in update");

        await require('./client').updateResource('Organization', id, updateData, identity);
        flash = { type: 'success', message: 'Organization Updated Successfully' };
    } catch (err) {
        flash = { type: 'error', message: 'Update Failed: ' + (err.response?.data?.issue?.[0]?.diagnostics || err.message) };
    }
    res.redirect(localUrl(`/manage?identity=${identity}`));
});

/**
 * Update an Endpoint resource.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.post('/manage/endpoint', async (req, res) => {
    const identity = req.body.identity || 'hospital-a';
    const { id, jsonContent } = req.body;

    try {
        if (!jsonContent) throw new Error("No JSON content provided");
        let updateData = JSON.parse(jsonContent);
        if (updateData.id !== id) throw new Error("ID mismatch in update");

        await require('./client').updateResource('Endpoint', id, updateData, identity);
        flash = { type: 'success', message: 'Endpoint updated.' };
    } catch (err) {
        return renderManagement(req, res, { identity, status: 400, feedback: { type: 'error', message: 'Endpoint update failed: ' + (err.response?.data?.issue?.[0]?.diagnostics || err.message) }, draft: { kind: 'endpoint', id, jsonContent } });
    }
    res.redirect(localUrl(`/manage?identity=${encodeURIComponent(identity)}`));
});

app.post('/manage/catalog-update', async (req, res) => {
    const identity = req.body.identity || 'hospital-a';
    try {
        if (!req.body.jsonContent) throw new Error('No proposed catalog JSON was provided');
        const proposedCatalog = JSON.parse(req.body.jsonContent);
        const receipt = await requestCatalogUpdate(proposedCatalog, req.body.reason || undefined, identity);
        const requestId = receipt.parameter?.find(parameter => parameter.name === 'requestId')?.valueString;
        flash = { type: 'success', message: `Catalog update request accepted${requestId ? ` as ${requestId}` : ''}; the live catalog was not mutated.` };
    } catch (error) {
        return renderManagement(req, res, { identity, status: 400, feedback: { type: 'error', message: `Catalog update request failed: ${error.response?.data?.issue?.[0]?.diagnostics || error.message}` }, draft: { kind: 'catalog', jsonContent: req.body.jsonContent, reason: req.body.reason } });
    }
    res.redirect(localUrl(`/manage?identity=${encodeURIComponent(identity)}`));
});

/**
 * Clear session state and token cache.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.post('/reset', (req, res) => {
    logHarnessAction('HARNESS_ACTION_STARTED', 'reset-session');
    consents.clear();
    selections.clear(); library.clear(); serviceLists.clear();
    lastPatientIdByIdentity.clear();
    smartTransactions.clear();
    resetCache();
    flash = { type: 'info', message: 'Doctor application state and shared token caches reset. PCM Consent resources and clinical data remain.' };
    logHarnessAction('HARNESS_ACTION_COMPLETED', 'reset-session');
    res.redirect(localUrl('/'));
});

app.use(logger.errorLogger);
browserPage.installBrowserErrors(app, req => doctorPageContext(req));

let server = null;

function startServer(port = PORT) {
    logger.initialize();
    logger.installProcessHandlers('sp-client');
    logger.logBoot('sp-client');
    logPolicyBanner(logger, 'sp-client', effectivePolicy);
    server = app.listen(port, () => {
        console.log(`SP Client running on port ${port}`);
    });
    server.on('error', err => {
        logger.error(`SP Client server error: ${err.message}`, {
            type: 'PROCESS_LISTENER_ERROR',
            category: 'lifecycle',
            visibility: 'default',
            causesSystemFlow: false,
            service: 'sp-client',
            error: err
        });
    });
    return server;
}

if (require.main === module) {
    startServer();
}

process.on('SIGTERM', () => {
    logger.warn('SIGTERM signal received: closing HTTP server', {
        type: 'PROCESS_SIGNAL',
        category: 'lifecycle',
        visibility: 'diagnostic',
        causesSystemFlow: false,
        signal: 'SIGTERM'
    });
    if (!server) process.exit(0);
    server.close(() => {
        logger.info('HTTP server closed', {
            type: 'PROCESS_SHUTDOWN_COMPLETE',
            category: 'lifecycle',
            visibility: 'diagnostic',
            causesSystemFlow: false
        });
        process.exit(0);
    });
});

module.exports = {
    app,
    startServer,
    _test: {
        logHarnessAction, manageServicesUrl
    }
};
