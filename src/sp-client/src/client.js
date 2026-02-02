/**
 * Service Provider client helpers for interacting with PCM and data sources.
 */
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const logger = require('./logger');

const { EXT_PCM_SERVICE } = require('./constants');

// --- Multi-Identity Agents ---
const agents = {};

/**
 * Load an HTTPS agent for a specific identity based on local certs.
 * @param {string} identity
 * @param {string} certName
 * @returns {void}
 */
function loadAgent(identity, certName) {
    try {
        const certPath = path.join(process.cwd(), 'certs', `${certName}.crt`);
        const keyPath = path.join(process.cwd(), 'certs', `${certName}.key`);
        const caPath = path.join(process.cwd(), 'certs', `rootCA.crt`);

        if (identity === 'untrusted') {
            agents[identity] = new https.Agent({
                cert: fs.readFileSync(path.join(process.cwd(), 'certs', 'untrusted-client.crt')),
                key: fs.readFileSync(path.join(process.cwd(), 'certs', 'untrusted-client.key')),
                ca: fs.readFileSync(path.join(process.cwd(), 'certs', 'rootCA.crt')),
                rejectUnauthorized: false
            });
        } else {
            agents[identity] = new https.Agent({
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath),
                ca: fs.readFileSync(caPath),
                rejectUnauthorized: false
            });
        }
        console.log(`Loaded agent for identity: ${identity}`);
    } catch (e) {
        console.error(`Failed to load agent for ${identity}:`, e.message);
    }
}

// Load Agents
loadAgent('hospital-a', 'sp-client');
loadAgent('hospital-b', 'hospital-b-sp');
loadAgent('untrusted', 'untrusted');

/**
 * Resolve the HTTPS agent for a given identity.
 * @param {string} identity
 * @returns {import('https').Agent}
 */
function agentFor(identity) {
    return agents[identity] || agents['hospital-a'];
}

// IDs
const CLIENT_IDS = {
    'hospital-a': 'http://pcm.fhir.health.gov.il/Organization/org-sp',
    'hospital-b': 'hospital-b-sp', // Leave as is for now or update if needed
    'untrusted': 'untrusted-client'
};

/**
 * Resolve the OAuth2 client id for a given identity.
 * @param {string} identity
 * @returns {string}
 */
function getClientId(identity) {
    return CLIENT_IDS[identity] || 'http://pcm.fhir.health.gov.il/Organization/org-sp';
}

/**
 * Load the private key used to sign client_assertion JWTs.
 * @param {string} identity
 * @returns {Buffer}
 */
function getPrivateKey(identity) {
    if (identity === 'untrusted') return fs.readFileSync('/app/certs/untrusted-client.key');
    if (identity === 'hospital-b') return fs.readFileSync('/app/certs/hospital-b-sp.key');
    return fs.readFileSync('/app/certs/sp-client.key');
}


// --- Logic ---

// Update URLs to HTTPS
const PCM_AUTH_URL = process.env.PCM_AUTH_URL?.replace('http:', 'https:');
const PCM_FHIR_URL = process.env.PCM_FHIR_URL?.replace('http:', 'https:');
const DS_GATEWAY_URL = process.env.DS_GATEWAY_URL?.replace('http:', 'https:');
const PCM_RESOURCE = PCM_FHIR_URL || 'https://pcm-core:3000/r4';

// Add request logging
axios.interceptors.request.use(request => {
    logger.info(`OUTGOING REQUEST: ${request.method.toUpperCase()} ${request.url}`, {
        type: 'OUTGOING_REQUEST',
        method: request.method,
        url: request.url,
        headers: request.headers,
        data: request.data
    });
    return request;
});

axios.interceptors.response.use(response => {
    logger.info(`OUTGOING RESPONSE: ${response.status} ${response.config.url}`, {
        type: 'OUTGOING_RESPONSE',
        status: response.status,
        url: response.config.url,
        data: response.data
    });
    return response;
}, error => {
    if (error.response) {
        logger.error(`OUTGOING ERROR: Request failed with status code ${error.response.status}`, {
            type: 'OUTGOING_ERROR',
            status: error.response.status,
            url: error.config.url,
            data: error.response.data
        });

        // Token Refresh Logic
        // If 401 and not already retried
        if (error.response.status === 401 && !error.config._retry) {
            // CRITICAL: Do NOT retry if the error is a definitive Access Denied (not expired)
            const errData = error.response.data || {};
            const isAccessDenied = errData.error === 'access_denied' || (errData.error_description && errData.error_description.includes('not a party'));

            // Note: Our PCM sends { resourceType: 'OperationOutcome' ... } for some errors now.
            const failureIssue = errData.issue ? errData.issue[0]?.diagnostics : '';

            if (isAccessDenied || (failureIssue && failureIssue.includes('Client authentication does not map') || failureIssue.includes('not a party'))) {
                // Do not retry.
                console.warn('[Client] 401 Access Denied (Not Expired):', failureIssue || errData.error_description);
            } else {
                console.log('[Client] 401 status detected. Assuming Token Expired. Retrying...');
                resetCache();

                // Throw specific error for wrapper to catch
                const err = new Error('Token Expired');
                err.isTokenExpired = true;
                throw err;
            }
        }
    } else {
        logger.error(`OUTGOING ERROR: ${error.message}`, {
            type: 'OUTGOING_ERROR',
            message: error.message
        });
    }
    return Promise.reject(error);
});


/**
 * Create a private_key_jwt client_assertion for PCM /token.
 * @param {string} identity
 * @param {string|undefined|null} consentId
 * @param {string} audience
 * @returns {string}
 */
function generateClientAssertion(identity, consentId, audience) {
    const clientId = getClientId(identity);
    const key = getPrivateKey(identity);

    const payload = {
        sub: clientId,
        iss: clientId,
        aud: audience,
        jti: uuidv4()
    };

    // UDAP B2B Extension
    if (consentId) {
        const orgId = identity === 'hospital-b' ? 'org-hospital-b-sp' : 'org-sp';

        payload.extensions = {
            "hl7-b2b": {
                "version": "1",
                "organization_id": `http://pcm-url-base/Organization/${orgId}`,
                "purpose_of_use": ["TREAT"],
                "consent_reference": [
                    `http://pcm-url-base/Consent/${consentId}`
                ]
            }
        };
    }

    return jwt.sign(payload, key, { algorithm: 'RS256', expiresIn: '5m' });
}

// Token Cache
const tokens = new Map();
let smartConfig = null;

/**
 * Discover SMART configuration from PCM FHIR base (cached).
 * @param {string} fhirBaseUrl
 * @returns {Promise<object>}
 */
async function getSmartConfiguration(fhirBaseUrl) {
    if (smartConfig) return smartConfig;
    try {
        console.log(`[Client] Discovering SMART Config at ${fhirBaseUrl}/.well-known/smart-configuration`);
        // We use the same agent/identity context? Generally ID-agnostic public endpoint.
        const agent = agentFor('hospital-a'); // Just need mTLS connectivity
        const res = await axios.get(`${fhirBaseUrl}/.well-known/smart-configuration`, {
            httpsAgent: agent
        });
        smartConfig = res.data;
        console.log('[Client] Discovery Successful:', smartConfig);
        return smartConfig;
    } catch (err) {
        console.warn('[Client] Discovery Failed:', err.message);
        // Fallback to Env/Hardcoded if discovery fails
        return {
            token_endpoint: process.env.PCM_AUTH_URL ? `${process.env.PCM_AUTH_URL}/token` : 'https://pcm-core:3000/token'
        };
    }
}

/**
 * Get an access token for a target resource server, cached by identity/audience.
 * @param {string} audience
 * @param {string} identity
 * @param {string|undefined|null} consentId
 * @param {string|undefined|null} requestedScope
 * @returns {Promise<string>}
 */
async function getToken(audience, identity, consentId, requestedScope) {
    const aud = audience || 'https://pcm-core:3000'; // Assume Default pcm-core
    const currentIdentity = identity || 'hospital-a';

    const cacheKey = `${currentIdentity}|${aud}|${consentId || ''}`;

    const cached = tokens.get(cacheKey);
    if (cached) return cached;

    try {
        // 1. Discovery
        // Determine FHIR Base based on Audience? 
        // If audience is pcm-core (Resource Server), we discover from there.
        // For external Data Sources, we might need their specific discovery if they are distinct.
        // For POC, we assume pcm-core is the main Auth Authority.
        const config = await getSmartConfiguration(PCM_FHIR_URL || 'https://pcm-core:3000/r4');
        const tokenEndpoint = config.token_endpoint;

        const assertion = generateClientAssertion(currentIdentity, consentId, tokenEndpoint);
        const agent = agentFor(currentIdentity);

        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: assertion,
            scope: requestedScope || 'system/*.cruds',
            resource: aud // RFC 8707 Resource Indicator
        }).toString();

        const res = await axios.post(tokenEndpoint, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: agent
        });

        const token = res.data.access_token;
        tokens.set(cacheKey, token);
        return token;
    } catch (err) {
        console.error(`Failed to get token for ${aud} as ${currentIdentity}`, err.response?.data || err.message);
        throw err;
    }
}

/**
 * Wrap calls to automatically retry on token-expired errors.
 * @param {Function} fn
 * @returns {Promise<any>}
 */
async function withRetry(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err.isTokenExpired) {
            console.log('Token expired error caught. Retrying...');
            // Cache is already reset by interceptor
            return await fn();
        }
        throw err;
    }
}

/**
 * Create a new Consent request for a patient and service.
 * @param {string} patientId
 * @param {string} serviceId
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function createConsentRequest(patientId, serviceId, identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const token = await getToken(PCM_RESOURCE, currentIdentity);

        const res = await axios.post(`${PCM_FHIR_URL}/Consent`, {
            resourceType: 'Consent',
            status: 'proposed',
            patient: { identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: patientId } },
            extension: [
                { url: EXT_PCM_SERVICE, valueReference: { reference: `HealthcareService/${serviceId}` } }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/fhir+json',
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });
        const consent = res.data;
        logger.info(`CREATED CONSENT ID: ${consent.id}`, { identity: currentIdentity });
        return consent;
    });
}

/**
 * Fetch a consent by id and expand related actors/endpoints.
 * @param {string} consentId
 * @param {string} identity
 * @returns {Promise<object|null>}
 */
async function checkConsentStatus(consentId, identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const token = await getToken(PCM_RESOURCE, currentIdentity);

        const query = `_id=${consentId}&_include=Consent:actor&_include:iterate=Organization:endpoint&_include:iterate=Organization:partof`;
        const res = await axios.get(`${PCM_FHIR_URL}/Consent?${query}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });

        const bundle = res.data;
        if (!bundle || bundle.resourceType !== 'Bundle') {
            return null;
        }

        const consentEntry = bundle.entry?.find(e => e.resource.resourceType === 'Consent' && e.search?.mode === 'match');
        const consent = consentEntry?.resource;

        if (consent && consent.status === 'active') {
            const actors = consent.provision?.actor || [];
            const custodian = actors.find(a => a.role?.coding?.some(c => c.code === 'CST')); // Custodian = Data Source



            // Fallback to IRCP if CST not found (though CST is standard for Custodian)
            const actor = custodian || actors.find(a => a.role?.coding?.some(c => c.code === 'IRCP'));

            if (actor && actor.reference?.reference) {
                const orgRef = actor.reference.reference;
                const orgEntry = bundle.entry.find(e =>
                    e.resource.resourceType === 'Organization' &&
                    (e.resource.id === orgRef.split('/')[1] || `Organization/${e.resource.id}` === orgRef)
                );

                if (orgEntry && orgEntry.resource.endpoint) {
                    const epRef = orgEntry.resource.endpoint[0]?.reference;
                    if (epRef) {
                        const epEntry = bundle.entry.find(e =>
                            e.resource.resourceType === 'Endpoint' &&
                            (e.resource.id === epRef.split('/')[1] || `Endpoint/${e.resource.id}` === epRef)
                        );

                        if (epEntry && epEntry.resource.address) {
                            consent.discoveredEndpoint = epEntry.resource.address;
                        }
                    }
                }
            }
        }
        return consent;
    });
}

/**
 * Search for consents visible to the current identity.
 * @param {string} identity
 * @returns {Promise<object[]>}
 */
async function searchConsents(identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const token = await getToken(PCM_RESOURCE, currentIdentity);

        // Search for consents where this identity is an actor
        // We rely on the server-side enforcement we just added! 
        // Or we can be explicit: actor=<my-org-id>
        // Let's rely on the server enforcing visibility for the caller, so simple search is enough?
        // But we probably want to filter by status or something?
        // Let's just get all.
        const res = await axios.get(`${PCM_FHIR_URL}/Consent`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });

        const bundle = res.data;
        if (!bundle || bundle.resourceType !== 'Bundle') return [];
        return bundle.entry ? bundle.entry.map(e => e.resource).filter(r => r.resourceType === 'Consent') : [];
    });
}

/**
 * Fetch Observation data from a data source via DS gateway.
 * @param {string} consentId
 * @param {string} dataSourceUrl
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function fetchData(consentId, dataSourceUrl, identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const targetUrl = dataSourceUrl || DS_GATEWAY_URL;

        let audience = targetUrl;
        // Attempt to extract base URL for audience if possible, but full URL works if pcm logic accepts it.
        // For now use targetUrl.

        // For Data Source access, we request specific scope per requirement
        const token = await getToken(audience, currentIdentity, consentId, 'patient/Observation.rs');

        try {
            const res = await axios.get(`${targetUrl}/Observation`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/fhir+json'
                },
                httpsAgent: agentFor(currentIdentity)
            });
            return res.data;
        } catch (err) {
            console.error('Failed to fetch data', err.response?.data || err.message);
            throw err;
        }
    });
}


/**
 * Fetch the Organization and Endpoint details for the current identity.
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function fetchMyOrganization(identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const token = await getToken(PCM_RESOURCE, currentIdentity);

        // Fetch Organizations and their Endpoints generically
        // Relying on server-side hardening to only return the caller's organization.
        const res = await axios.get(`${PCM_FHIR_URL}/Organization?_include=Organization:endpoint`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });

        return res.data;
    });
}

/**
 * Update a FHIR resource by type/id.
 * @param {string} resourceType
 * @param {string} id
 * @param {object} data
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function updateResource(resourceType, id, data, identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const token = await getToken(PCM_RESOURCE, currentIdentity);

        const res = await axios.put(`${PCM_FHIR_URL}/${resourceType}/${id}`, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/fhir+json',
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });
        return res.data;
    });
}

/**
 * Clear cached access tokens.
 * @returns {void}
 */
function resetCache() {
    tokens.clear();
    console.log('Token cache cleared.');
}

module.exports = {
    createConsentRequest,
    checkConsentStatus,
    searchConsents,
    fetchData,
    fetchMyOrganization,
    updateResource,
    resetCache,
    withRetry
};
