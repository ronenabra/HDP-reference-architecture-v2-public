/**
 * Service Provider (Doctor App) server entrypoint.
 */
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { createConsentRequest, checkConsentStatus, fetchData, resetCache } = require('./client');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

// --- Logging Middleware ---
const logger = require('./logger');
const fs = require('fs');
app.use(logger.requestLogger);

// --- Logging Routes ---
/**
 * Render the logs viewer UI.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.get('/logs-view', (req, res) => {
    res.render('logs', { serviceName: 'Doctor App' });
});

/**
 * Return recent log entries for the UI.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.get('/api/logs', (req, res) => {
    const logFile = path.join(process.cwd(), 'logs', 'current.log');
    if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        const logs = content.trim().split('\n').map(line => {
            try { return JSON.parse(line); } catch (e) { return null; }
        }).filter(l => l).reverse();
        res.json(logs);
    } else {
        res.json([]);
    }
});

// Store consent ID in memory for session simulation
const consents = new Map(); // Store consents: id -> { consent, data, validationError }
let flash = null; // { type: 'success'|'error', message: '' }

// Identities
const IDENTITIES = ['hospital-a', 'hospital-b', 'untrusted'];

/**
 * Render the main dashboard with current consents.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.get('/', async (req, res) => {
    // Current identity for context (default A)
    const currentIdentity = req.query.identity || 'hospital-a';

    // Search on Load (Refresh from Server)
    try {
        const remoteConsents = await require('./client').searchConsents(currentIdentity);
        remoteConsents.forEach(c => {
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
                    const oldEndpoint = validRecord.consent?.discoveredEndpoint;
                    validRecord.consent = c;
                    if (oldEndpoint) validRecord.consent.discoveredEndpoint = oldEndpoint;
                }
            }
        });
    } catch (err) {
        console.error('Failed to search consents on load:', err.message);
        // Don't crash UI, just show what we have or nothing
    }

    const visibleConsents = [];
    for (const [id, record] of consents.entries()) {
        if (record.owner === currentIdentity) {
            visibleConsents.push(record);
        }
    }

    res.render('index', {
        consents: visibleConsents,
        identities: IDENTITIES,
        currentIdentity,
        flash: flash
    });
    flash = null; // Consume flash
});

/**
 * Create a new consent request.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.post('/create-consent', async (req, res) => {
    const identity = req.body.identity || 'hospital-a';
    try {
        const { patientId } = req.body;
        const consent = await createConsentRequest(patientId, 'service-1', identity);

        consents.set(consent.id, {
            id: consent.id,
            consent: consent,
            data: null,
            owner: identity,
            validationError: null
        });
        flash = { type: 'success', message: 'Consent Request Created' };

    } catch (err) {
        flash = { type: 'error', message: 'Failed to create consent request: ' + err.message };
    }
    res.redirect(`/?identity=${identity}`);
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

    try {
        if (!consentId) throw new Error('No consent ID provided');

        // Attempt to find local record, but don't error if missing (Manual Mode)
        const record = consents.get(consentId);

        // Check Status (which also performs Discovery)
        const updated = await checkConsentStatus(consentId, identity);

        if (record && updated) {
            record.consent = updated;
        }

        if (updated) {
            const ep = updated.discoveredEndpoint || 'Not Found';
            flash = { type: 'success', message: `Discovery Complete. Status: ${updated.status}. Endpoint: ${ep}` };
            // If manual, we can't persist the discovered endpoint to the UI input easily without session state 
            // or re-rendering with params.
            // For now, the user sees the flash message. 
            // Ideally, we'd upsert this into 'consents' map so it appears in the list?
            // YES: If we discover a valid consent manually, let's track it!
            if (!record) {
                consents.set(consentId, {
                    id: consentId,
                    consent: updated,
                    data: null,
                    owner: identity,
                    validationError: null
                });
            }
        } else {
            flash = { type: 'warning', message: 'Consent not found on PCM or no access.' };
        }

    } catch (err) {
        flash = { type: 'error', message: 'Discovery Failed: ' + err.message };
    }
    res.redirect(`/?identity=${identity}`);
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

    try {
        if (!consentId) throw new Error('No consent ID provided');

        // Look up record or create dummy if missing
        let record = consents.get(consentId);
        if (!record) {
            // Create temporary record to handle data display logic if successful
            // But we need to save it to map to show result in the list view?
            // Or we just rely on flash? 
            // Let's add it to consents map so the result renders in the card list.
            record = {
                id: consentId,
                consent: { status: 'unknown', discoveredEndpoint: endpointUrl },
                data: null,
                owner: identity,
                validationError: null
            };
            consents.set(consentId, record);
        }

        if (record.owner !== identity) {
            logger.warn(`[Security Warning] Identity ${identity} trying to use consent owned by ${record.owner}`);
        }

        // Use User-Provided URL or Fallback (only if provided or discovered)
        const targetUrl = endpointUrl || record.consent?.discoveredEndpoint || process.env.DS_GATEWAY_URL || 'https://ds-gateway:8080/fhir';
        logger.info(`Fetching data from target`, { targetUrl, identity, consentId });

        try {
            const data = await fetchData(consentId, targetUrl, identity);
            record.data = data;
            record.validationError = null;
            if (record.consent) record.consent.status = 'active';

            flash = { type: 'success', message: 'Data Fetched Successfully' };

        } catch (err) {
            console.error("Fetch Failed", err.message);
            record.validationError = err.message;
            record.data = null;
            flash = { type: 'error', message: "Fetch Failed: " + err.message };
        }

    } catch (err) {
        flash = { type: 'error', message: 'Fetch Action Failed: ' + err.message };
    }
    res.redirect(`/?identity=${identity}`);
});

// --- Organization Management Routes ---

/**
 * Render organization management page.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
app.get('/manage', async (req, res) => {
    const identity = req.query.identity || 'hospital-a';
    let orgs = [];
    let endpoints = [];

    try {
        const bundle = await require('./client').fetchMyOrganization(identity);
        if (bundle && bundle.entry) {
            orgs = bundle.entry
                .filter(e => e.resource.resourceType === 'Organization')
                .map(e => e.resource);

            endpoints = bundle.entry
                .filter(e => e.resource.resourceType === 'Endpoint')
                .map(e => e.resource);
        }
    } catch (err) {
        flash = { type: 'error', message: 'Failed to load organization: ' + (err.response?.data?.issue?.[0]?.diagnostics || err.message) };
    }

    res.render('manage', {
        identity,
        orgs,
        endpoints,
        identities: IDENTITIES,
        flash,
        currentIdentity: identity
    });
    flash = null;
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
    res.redirect(`/manage?identity=${identity}`);
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
        flash = { type: 'success', message: 'Endpoint Updated Successfully' };
    } catch (err) {
        flash = { type: 'error', message: 'Update Failed: ' + (err.response?.data?.issue?.[0]?.diagnostics || err.message) };
    }
    res.redirect(`/manage?identity=${identity}`);
});

/**
 * Clear session state and token cache.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.post('/reset', (req, res) => {
    consents.clear();
    resetCache();
    flash = { type: 'info', message: 'Session and Token Cache Reset' };
    res.redirect('/');
});

const server = app.listen(PORT, () => {
    console.log(`SP Client running on port ${PORT}`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});
