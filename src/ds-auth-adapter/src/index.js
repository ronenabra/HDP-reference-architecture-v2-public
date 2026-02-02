const express = require('express');
const axios = require('axios');
const { mapIdentity } = require('./mapper');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const logger = require('./logger');
const { thumbprintFromEscapedPem } = require('./mtls');

/**
 * DS Auth Adapter (Policy Enforcement Point)
 * 
 * Architecture:
 * This service sits behind the NGINX Gateway (ds-gateway).
 * 
 * Flow:
 * 1. NGINX receives request with Opaque Token from SP.
 * 2. NGINX creates subrequest to /auth-check here.
 * 3. This service Introspects the Opaque Token with PCM Core.
 * 4. If Valid:
 *    - Maps the Global User ID (National ID) to a Local User ID (Identity Translation).
 *    - Mints a short-lived Local JWT.
 * 5. Returns 200 OK + X-Local-Token header.
 * 6. NGINX injects X-Local-Token and proxies to the FHIR Server.
 */

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json());
app.use(logger.requestLogger);

// --- Axios Logging Interceptors ---
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

axios.interceptors.response.use(
    response => {
        logger.info(`OUTGOING RESPONSE: ${response.status} ${response.config.url}`, {
            type: 'OUTGOING_RESPONSE',
            status: response.status,
            url: response.config.url,
            data: response.data
        });
        return response;
    },
    error => {
        logger.error(`OUTGOING ERROR: ${error.message}`, {
            type: 'OUTGOING_ERROR',
            url: error.config?.url,
            message: error.message,
            response: error.response?.data
        });
        return Promise.reject(error);
    }
);

// --- mTLS Configuration ---
// Client Certificate for mutual TLS with PCM Core
const httpsAgent = new https.Agent({
    cert: fs.readFileSync('/app/certs/ds-gateway.crt'),
    key: fs.readFileSync('/app/certs/ds-gateway.key'),
    ca: fs.readFileSync('/app/certs/rootCA.crt'),
    // Note: Self-signed certificates in POC environment usually require rejecting unauthorized to be false
    // unless the entire chain and CNs matches perfectly with Docker networking.
    // For strict production security, this should be true.
    rejectUnauthorized: false
});

const CLIENT_ID = 'http://pcm.fhir.health.gov.il/Organization/org-vaccine-repo';
const PRIVATE_KEY = fs.readFileSync('/app/certs/ds-gateway.key');
const PCM_AUTH_URL = (process.env.PCM_AUTH_URL || 'http://pcm-core:3000').replace('http:', 'https:');

// Attach Agent to Global Axios defaults
axios.defaults.httpsAgent = httpsAgent;

/**
 * Generate a private_key_jwt client assertion for PCM OAuth2.
 * @param {string} audience
 * @returns {string}
 */
function generateClientAssertion(audience) {
    return jwt.sign({
        sub: CLIENT_ID,
        iss: CLIENT_ID,
        aud: audience,
        jti: uuidv4()
    }, PRIVATE_KEY, { algorithm: 'RS256', expiresIn: '5m' });
}

// FHIR Base URL for discovery
const PCM_FHIR_BASE = (process.env.PCM_FHIR_URL || 'http://pcm-core:3000/r4').replace('http:', 'https:');

let smartConfig = null;

/**
 * Discover SMART configuration from PCM FHIR base (cached).
 * @returns {Promise<object>}
 */
async function getSmartConfiguration() {
    if (smartConfig) return smartConfig;
    try {
        console.log(`[Adapter] Discovering SMART Config at ${PCM_FHIR_BASE}/.well-known/smart-configuration`);
        const res = await axios.get(`${PCM_FHIR_BASE}/.well-known/smart-configuration`);
        smartConfig = res.data;
        console.log('[Adapter] Discovery Successful:', smartConfig);
        return smartConfig;
    } catch (err) {
        console.warn('[Adapter] Discovery Failed:', err.message);
        // Fallback configuration if discovery fails
        return {
            token_endpoint: `${PCM_AUTH_URL}/token`,
            introspection_endpoint: `${PCM_AUTH_URL}/introspect` || 'https://pcm-core:3000/introspect'
        };
    }
}

let introspectionToken = null;

/**
 * Get or refresh the PCM access token used for introspection.
 * @returns {Promise<string>}
 */
async function getIntrospectionToken() {
    if (introspectionToken) return introspectionToken;

    try {
        const config = await getSmartConfiguration();
        const assertion = generateClientAssertion(config.token_endpoint);

        const authBase = config.token_endpoint.replace(/\/token$/, '');
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: assertion,
            scope: 'introspection',
            resource: authBase // RFC 8707: Target Service
        }).toString();

        const res = await axios.post(config.token_endpoint, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        introspectionToken = res.data.access_token;
        return introspectionToken;
    } catch (err) {
        console.error('Failed to get introspection token', err.response?.data || err.message);
        throw err;
    }
}

module.exports.getSmartConfiguration = getSmartConfiguration;

/**
 * Validate opaque token with PCM, map identity, and mint local JWT.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
const handleAuthCheck = async (req, res) => {
    // 1. Extract Bearer token from original Authorization header
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Missing Token');
    }

    const token = authHeader.split(' ')[1];

    try {
        // 2. Authenticate to PCM (mTLS + Client Credentials)
        const accessToken = await getIntrospectionToken();
        const config = await getSmartConfiguration();

        // 3. Introspect the User Token with PCM
        const body = new URLSearchParams({ token }).toString();
        const response = await axios.post(config.introspection_endpoint, body, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        logger.info(`Introspection Response Processed`, {
            type: 'INTROSPECTION_PROCESSED',
            active: response.data.active,
            scope: response.data.scope
        });

        if (!response.data.active) {
            return res.status(401).send('Token Inactive');
        }

        // Compare mTLS client certificate from nginx with cnf in introspection (warn only)
        try {
            const escapedCert = req.headers['x-client-cert'];
            const presentedThumbprint = thumbprintFromEscapedPem(escapedCert);
            const cnfThumbprint = response.data.cnf && response.data.cnf['x5t#S256'];
            if (presentedThumbprint && cnfThumbprint && presentedThumbprint !== cnfThumbprint) {
                logger.warn('mTLS client cert thumbprint does not match cnf from introspection', {
                    type: 'MTLS_CNF_MISMATCH',
                    presented_x5t: presentedThumbprint,
                    cnf_x5t: cnfThumbprint
                });
            }
        } catch (e) {
            logger.warn('Failed to compare mTLS cert thumbprint with cnf', { error: e.message });
        }

        // 4. Map Identity & Mint Local Token
        const localToken = mapIdentity(response.data);
        const decoded = jwt.decode(localToken);

        logger.info('Token Minted', {
            type: 'TOKEN_MINTED',
            payload: decoded,
            x_local_token: localToken
        });

        // 5. Return Success + Local Header (for NGINX to upstream)
        res.set('X-Local-Token', localToken);
        res.status(200).send('OK');

    } catch (err) {
        console.error('Auth Check Failed', err.message);
        // Clear token on 401/403 from PCM in case it expired
        if (err.response && (err.response.status === 401 || err.response.status === 403)) {
            introspectionToken = null;
        }
        res.status(401).send('Unauthorized');
    }
};

/**
 * GET /auth-check
 * Called by NGINX via auth_request module.
 */
app.get('/auth-check', handleAuthCheck);

const server = app.listen(PORT, () => {
    console.log(`DS Adapter running on port ${PORT}`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});
