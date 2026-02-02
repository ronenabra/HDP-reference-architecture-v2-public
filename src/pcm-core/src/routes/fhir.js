/**
 * PCM FHIR REST endpoints with mTLS and OAuth2 protection.
 */
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const store = require('../fhir/store');
const { tokens } = require('../store');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');

const EXT_PCM_SERVICE = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service';
const EXT_BASED_ON_CANONICAL = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice';
const META_TAG_SYSTEM = 'http://pcm.fhir.health.gov.il/cs/pcm-meta-tag';
const META_TAG_CATALOG = 'catalog';
const META_TAG_INSTANCE = 'instance';
const PCM_ORG_TYPE_SYSTEM = 'http://fhir.health.gov.il/cs/pcm-org-type';
const PCM_ORG_TYPE_CODE = 'pcm';

/**
 * Normalize a value into an array.
 * @param {any} value
 * @returns {any[]}
 */
const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

/**
 * Extract the logical id from a FHIR reference string.
 * @param {string|null|undefined} ref
 * @returns {string|null}
 */
const getRefId = ref => (ref ? ref.split('/').pop() : null);

/**
 * Determine whether the caller is a PCM admin organization.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const isPcmAdmin = req => {
    const orgId = req.user?.organization_id;
    if (!orgId) return false;
    const org = store.get('Organization', orgId);
    return (org?.type || []).some(t =>
        (t.coding || []).some(c => c.system === PCM_ORG_TYPE_SYSTEM && c.code === PCM_ORG_TYPE_CODE)
    );
};

/**
 * Enforce mTLS client authentication on FHIR endpoints.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireMtls = (req, res, next) => {
    if (!req.socket.authorized) {
        logger.warn('[FHIR] Rejected connection without valid client certificate', { error: req.socket.authorizationError });
        return res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Valid client certificate required' }] });
    }
    next();
};

/**
 * Validate bearer token and populate req.user.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireBearer = (req, res, next) => {
    res.type('application/fhir+json');

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Missing Authorization Header' }] });
    }

    const token = authHeader.split(' ')[1];
    const tokenData = tokens.get(token);

    if (!tokenData || tokenData.exp < Math.floor(Date.now() / 1000)) {
        return res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Invalid or Expired Token' }] });
    }

    req.user = tokenData;
    next();
};

router.use(requireMtls);

/**
 * SMART on FHIR Discovery Endpoint
 * GET /.well-known/smart-configuration
 */
router.get('/.well-known/smart-configuration', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.json({
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        token_endpoint_auth_methods_supported: [
            'private_key_jwt'
        ],
        grant_types_supported: [
            'authorization_code',
            'client_credentials'
        ],
        introspection_endpoint: `${baseUrl}/introspect`,
        code_challenge_methods_supported: ['S256'],
        capabilities: [
            'permission-patient',
            'permission-v2',
            'client-confidential-assymmetric',
            'sso-openid-connect'
        ],
        jwks_uri: `${baseUrl}/.well-known/jwks.json`,
        associated_endpoints: []
    });
});

/**
 * CapabilityStatement Endpoint
 * GET /metadata
 */
let cachedCapabilityStatement = null;

/**
 * Load the CapabilityStatement example from docs (cached).
 * @returns {object|null}
 */
const loadCapabilityStatement = () => {
    if (cachedCapabilityStatement) return cachedCapabilityStatement;
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const filePath = path.join(repoRoot, 'docs', 'FHIR-examples', 'CapabilityStatement-pcm-capabilitystatement.json');
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        cachedCapabilityStatement = JSON.parse(raw);
    } catch (err) {
        logger.warn('Failed to load CapabilityStatement example, falling back to minimal statement', { error: err.message });
        cachedCapabilityStatement = null;
    }
    return cachedCapabilityStatement;
};

router.get('/metadata', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.type('application/fhir+json');
    const statement = loadCapabilityStatement();

    if (statement) {
        const response = {
            ...statement,
            date: new Date().toISOString(),
            implementation: {
                ...statement.implementation,
                url: `${baseUrl}/r4`
            }
        };
        return res.json(response);
    }

    return res.json({
        resourceType: 'CapabilityStatement',
        status: 'active',
        date: new Date().toISOString(),
        kind: 'instance',
        fhirVersion: '4.0.1',
        format: ['application/fhir+json'],
        software: {
            name: 'PCM Core Stub'
        },
        implementation: {
            description: 'PCM FHIR API (POC)',
            url: `${baseUrl}/r4`
        },
        rest: [
            {
                mode: 'server',
                security: {
                    description: 'mTLS + OAuth2 bearer token (opaque)'
                },
                resource: [
                    { type: 'Organization' },
                    { type: 'Endpoint' },
                    { type: 'HealthcareService' },
                    { type: 'Consent' },
                    { type: 'VerificationResult' }
                ]
            }
        ]
    });
});

router.use(requireBearer);

// --- Organization ---
router.get('/Organization', (req, res) => {
    const entries = store.searchExpanded('Organization', req.query);

    res.json({
        resourceType: 'Bundle',
        type: 'searchset',
        total: entries.length,
        entry: entries
    });
});

router.get('/Organization/:id', (req, res) => {
    const org = store.get('Organization', req.params.id);
    if (!org) return res.status(404).json({ error: 'Not Found' });
    res.json(org);
});

router.put('/Organization/:id', (req, res) => {
    if (!isPcmAdmin(req) && (!req.user || req.user.organization_id !== req.params.id)) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Access denied' }] });
    }

    const existing = store.get('Organization', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not Found' });

    const updated = req.body;
    if (updated.id && updated.id !== req.params.id) {
        return res.status(400).json({ error: 'ID Mismatch' });
    }
    updated.resourceType = 'Organization';
    updated.id = existing.id;

    if (!isPcmAdmin(req)) {
        updated.partOf = existing.partOf;
        updated.type = existing.type;

        if (existing.active === false && updated.active === true) {
            updated.active = false;
        }
    }

    store.update(updated);
    res.json(updated);
});

// --- Endpoint ---
router.get('/Endpoint', (req, res) => {
    const endpoints = store.search('Endpoint', req.query);
    res.json({
        resourceType: 'Bundle',
        type: 'searchset',
        total: endpoints.length,
        entry: endpoints.map(e => ({ resource: e }))
    });
});

router.post('/Endpoint', (req, res) => {
    const endpoint = req.body;
    if (!endpoint || endpoint.resourceType !== 'Endpoint') {
        return res.status(400).json({ error: 'Invalid Endpoint resource' });
    }

    if (!isPcmAdmin(req)) {
        const managingOrgId = getRefId(endpoint.managingOrganization?.reference);
        if (!managingOrgId || managingOrgId !== req.user.organization_id) {
            return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Endpoint managingOrganization must match caller organization' }] });
        }
    }

    endpoint.resourceType = 'Endpoint';
    const created = store.add(endpoint);
    res.status(201).json(created);
});

router.get('/Endpoint/:id', (req, res) => {
    const ep = store.get('Endpoint', req.params.id);
    if (!ep) return res.status(404).json({ error: 'Not Found' });
    res.json(ep);
});

router.put('/Endpoint/:id', (req, res) => {
    const existing = store.get('Endpoint', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not Found' });

    if (!isPcmAdmin(req)) {
        const managingOrgId = getRefId(existing.managingOrganization?.reference);
        if (managingOrgId !== req.user.organization_id) {
            return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Access denied to this endpoint' }] });
        }
    }

    const updated = req.body;
    if (updated.id && updated.id !== req.params.id) {
        return res.status(400).json({ error: 'ID Mismatch' });
    }

    updated.resourceType = 'Endpoint';
    updated.id = req.params.id;
    store.update(updated);
    res.json(updated);
});

// --- HealthcareService ---
router.get('/HealthcareService', (req, res) => {
    const services = store.search('HealthcareService', req.query);
    res.json({
        resourceType: 'Bundle',
        type: 'searchset',
        total: services.length,
        entry: services.map(s => ({ resource: s }))
    });
});

router.post('/HealthcareService', (req, res) => {
    const incoming = req.body;
    if (!incoming || incoming.resourceType !== 'HealthcareService') {
        return res.status(400).json({ error: 'Invalid HealthcareService resource' });
    }

    if (isPcmAdmin(req)) {
        const created = store.add({ ...incoming, resourceType: 'HealthcareService' });
        return res.status(201).json(created);
    }

    const metaTags = ensureArray(incoming.meta?.tag);
    const isCatalog = metaTags.some(t => t.system === META_TAG_SYSTEM && t.code === META_TAG_CATALOG);

    if (isCatalog) {
        const created = store.add({ ...incoming, resourceType: 'HealthcareService' });
        return res.status(201).json(created);
    }

    const callerOrgId = req.user.organization_id;
    if (!callerOrgId) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Caller has no mapped Organization' }] });
    }

    const instance = { ...incoming };
    instance.resourceType = 'HealthcareService';
    instance.providedBy = { reference: `Organization/${callerOrgId}` };

    const extensions = ensureArray(instance.extension);
    let basedOnExt = extensions.find(e => e.url === EXT_BASED_ON_CANONICAL);

    if (!basedOnExt) {
        const canonical = { ...instance };
        canonical.id = undefined;
        canonical.providedBy = undefined;
        canonical.active = true;
        canonical.meta = canonical.meta || {};
        canonical.meta.tag = ensureArray(canonical.meta.tag).filter(t => t.code !== META_TAG_INSTANCE);
        canonical.meta.tag.push({ system: META_TAG_SYSTEM, code: META_TAG_CATALOG, display: 'Catalog' });

        const catalogIdentifier = canonical.identifier?.[0];
        if (!catalogIdentifier) {
            canonical.identifier = [{
                system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-catalog-id',
                value: `PCM-CAT-${uuidv4()}`
            }];
        }

        const canonicalCreated = store.add(canonical);
        basedOnExt = {
            url: EXT_BASED_ON_CANONICAL,
            valueReference: { reference: `HealthcareService/${canonicalCreated.id}` }
        };
        extensions.push(basedOnExt);
    }

    instance.extension = extensions;
    instance.active = instance.active ?? false;
    instance.meta = instance.meta || {};
    instance.meta.tag = ensureArray(instance.meta.tag).filter(t => t.code !== META_TAG_CATALOG);
    instance.meta.tag.push({ system: META_TAG_SYSTEM, code: META_TAG_INSTANCE, display: 'Instance' });

    const created = store.add(instance);
    res.status(201).json(created);
});

router.get('/HealthcareService/:id', (req, res) => {
    const svc = store.get('HealthcareService', req.params.id);
    if (!svc) return res.status(404).json({ error: 'Not Found' });
    res.json(svc);
});

router.put('/HealthcareService/:id', (req, res) => {
    const existing = store.get('HealthcareService', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not Found' });

    if (isPcmAdmin(req)) {
        const updated = req.body;
        if (updated.id && updated.id !== req.params.id) {
            return res.status(400).json({ error: 'ID Mismatch' });
        }

        updated.resourceType = 'HealthcareService';
        updated.id = req.params.id;
        store.update(updated);
        return res.json(updated);
    }

    const metaTags = ensureArray(existing.meta?.tag);
    const isCatalog = metaTags.some(t => t.system === META_TAG_SYSTEM && t.code === META_TAG_CATALOG);

    if (isCatalog) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Catalog services are managed by PCM' }] });
    }

    const providedById = getRefId(existing.providedBy?.reference);
    if (providedById !== req.user.organization_id) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Access denied to this service instance' }] });
    }

    const updated = req.body;
    if (updated.id && updated.id !== req.params.id) {
        return res.status(400).json({ error: 'ID Mismatch' });
    }

    updated.resourceType = 'HealthcareService';
    updated.id = req.params.id;
    updated.providedBy = existing.providedBy;
    store.update(updated);
    res.json(updated);
});

// --- Consent ---
router.post('/Consent', (req, res) => {
    const consentReq = req.body;

    if (!consentReq.patient || !consentReq.patient.identifier) {
        return res.status(400).json({ error: 'Missing patient identifier' });
    }

    if (!req.user || !req.user.organization_id) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Client authentication does not map to an Organization' }] });
    }

    const actorOrgId = req.user.organization_id;
    const actorOrg = store.get('Organization', actorOrgId);
    if (!actorOrg) {
        return res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: 'Mapped Organization not found in internal store' }] });
    }

    const newConsent = {
        resourceType: 'Consent',
        id: uuidv4(),
        identifier: [{
            system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id',
            value: uuidv4()
        }],
        status: 'proposed',
        scope: {
            coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }]
        },
        category: [
            {
                coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-consent-access-mode', code: 'continuous', display: 'Continuous' }]
            },
            {
                coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA', display: 'information access' }]
            }
        ],
        patient: consentReq.patient,
        dateTime: new Date().toISOString(),
        provision: {
            type: 'permit',
            purpose: [{
                system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
                code: 'TREAT',
                display: 'treatment'
            }],
            actor: [
                {
                    role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] },
                    reference: {
                        reference: `Organization/${actorOrg.id}`,
                        display: actorOrg.name
                    }
                }
            ]
        },
        extension: consentReq.extension,
        service: consentReq.extension ? consentReq.extension.find(e => e.url === EXT_PCM_SERVICE) : null
    };

    store.add(newConsent);
    res.status(201).json(newConsent);
});

router.get('/Consent/:id', (req, res) => {
    const consent = store.get('Consent', req.params.id);
    if (!consent) {
        return res.status(404).json({ error: 'Not Found' });
    }

    if (isPcmAdmin(req)) {
        return res.json(consent);
    }

    const caller = req.user;
    if (!caller || !caller.organization_id) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Unidentified Caller' }] });
    }
    const callerOrgId = caller.organization_id;

    const actors = consent.provision?.actor || [];
    const isParty = actors.some(a => a.reference && (a.reference.reference === `Organization/${callerOrgId}` || a.reference.reference === callerOrgId));

    if (!isParty) {
        console.warn(`[FHIR] Access Denied to Consent ${req.params.id} for Org ${callerOrgId}. Not a party.`);
        return res.status(404).json({ error: 'Not Found' });
    }

    res.json(consent);
});

router.get('/Consent', (req, res) => {
    const caller = req.user;

    if (!caller || !caller.organization_id) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Unidentified Caller' }] });
    }

    if (isPcmAdmin(req)) {
        const entries = store.searchExpanded('Consent', req.query);
        return res.json({
            resourceType: 'Bundle',
            type: 'searchset',
            total: entries.length,
            entry: entries
        });
    }

    const callerOrgId = caller.organization_id;
    console.log(`[FHIR] Consent Search by ${callerOrgId}. Enforcing visibility.`);

    const entries = store.searchExpanded('Consent', req.query);
    const visibleConsents = entries
        .filter(e => e.resource.resourceType === 'Consent')
        .map(e => e.resource)
        .filter(consent => {
            const actors = consent.provision?.actor || [];
            return actors.some(a => a.reference && (a.reference.reference === `Organization/${callerOrgId}` || a.reference.reference === callerOrgId));
        });

    const visibleConsentIds = new Set(visibleConsents.map(c => c.id));
    const allowedOrgIds = new Set();
    const allowedEndpointIds = new Set();

    visibleConsents.forEach(consent => {
        const actors = consent.provision?.actor || [];
        actors.forEach(actor => {
            const orgId = getRefId(actor.reference?.reference);
            if (orgId) allowedOrgIds.add(orgId);
        });
    });

    const includes = ensureArray(req.query._include);
    const iterateIncludes = ensureArray(req.query['_include:iterate']);

    if (includes.includes('Consent:actor') || iterateIncludes.length > 0) {
        allowedOrgIds.forEach(orgId => {
            const org = store.get('Organization', orgId);
            if (org && iterateIncludes.includes('Organization:endpoint')) {
                (org.endpoint || []).forEach(ep => {
                    const epId = getRefId(ep.reference);
                    if (epId) allowedEndpointIds.add(epId);
                });
            }
            if (org && iterateIncludes.includes('Organization:partof')) {
                const parentId = getRefId(org.partOf?.reference);
                if (parentId) allowedOrgIds.add(parentId);
            }
        });
    }

    const restrictedEntries = entries.filter(e => {
        if (e.resource.resourceType === 'Consent') {
            return visibleConsentIds.has(e.resource.id);
        }
        if (e.resource.resourceType === 'Organization') {
            return allowedOrgIds.has(e.resource.id);
        }
        if (e.resource.resourceType === 'Endpoint') {
            return allowedEndpointIds.has(e.resource.id);
        }
        return false;
    });

    res.json({
        resourceType: 'Bundle',
        type: 'searchset',
        total: restrictedEntries.length,
        entry: restrictedEntries
    });
});

router.put('/Consent/:id', (req, res) => {
    const existing = store.get('Consent', req.params.id);
    if (!existing) {
        return res.status(404).json({ error: 'Not Found' });
    }

    const updated = req.body;
    if (updated.id && updated.id !== req.params.id) {
        return res.status(400).json({ error: 'ID Mismatch' });
    }
    updated.resourceType = 'Consent';
    updated.id = req.params.id;

    if (isPcmAdmin(req)) {
        store.update(updated);
        return res.json(updated);
    }

    const callerOrgId = req.user.organization_id;
    const actors = existing.provision?.actor || [];
    const isParty = actors.some(a => a.reference && (a.reference.reference === `Organization/${callerOrgId}` || a.reference.reference === callerOrgId));

    if (!isParty) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Access denied to this consent' }] });
    }

    const isRequester = actors.some(a =>
        a.role?.coding?.some(c => c.code === 'IRCP') &&
        a.reference &&
        (a.reference.reference === `Organization/${callerOrgId}` || a.reference.reference === callerOrgId)
    );

    // SP may only deactivate a consent it created; no other fields may change via FHIR REST.
    if (!isRequester || updated.status !== 'inactive') {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Only requestor may set status=inactive' }] });
    }

    existing.status = 'inactive';
    store.update(existing);
    res.json(existing);
});

// --- VerificationResult ---
router.get('/VerificationResult', (req, res) => {
    const results = store.search('VerificationResult', req.query);
    res.json({
        resourceType: 'Bundle',
        type: 'searchset',
        total: results.length,
        entry: results.map(r => ({ resource: r }))
    });
});

router.post('/VerificationResult', (req, res) => {
    const verification = req.body;
    if (!verification || verification.resourceType !== 'VerificationResult') {
        return res.status(400).json({ error: 'Invalid VerificationResult resource' });
    }

    if (!verification.validator || verification.validator.length === 0) {
        const callerOrgId = req.user.organization_id;
        const callerOrg = store.get('Organization', callerOrgId);
        const parentId = getRefId(callerOrg?.partOf?.reference);
        verification.validator = [{ organization: { reference: `Organization/${parentId || callerOrgId}` } }];
    }

    verification.resourceType = 'VerificationResult';
    verification.status = verification.status || 'validated';

    const created = store.add(verification);
    res.status(201).json(created);
});

router.get('/VerificationResult/:id', (req, res) => {
    const verification = store.get('VerificationResult', req.params.id);
    if (!verification) return res.status(404).json({ error: 'Not Found' });
    res.json(verification);
});

module.exports = router;
