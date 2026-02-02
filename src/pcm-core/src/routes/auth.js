/**
 * PCM OAuth2 endpoints (token issuance and introspection).
 */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { clients, tokens } = require('../store');
const fhirStore = require('../fhir/store');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { certToX5tS256 } = require('../crypto');
const { buildHealthcareServiceContext } = require('../fhir/context');
const logger = require('../logger');

const EXT_PCM_SERVICE = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service';
const EXT_BASED_ON_CANONICAL = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice';

/**
 * Enforce mTLS client authentication on incoming requests.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireMtls = (req, res, next) => {
    if (!req.socket.authorized) {
        console.warn('[Auth] Rejected connection without valid client certificate', req.socket.authorizationError);
        return res.status(401).json({ error: 'access_denied', error_description: 'Valid client certificate required' });
    }
    next();
};

/**
 * Validate that a JWT audience matches one of the allowed endpoints.
 * @param {string|string[]|undefined|null} aud
 * @param {string[]} allowedAudiences
 * @returns {boolean}
 */
const isAllowedAudience = (aud, allowedAudiences) => {
    if (!aud) return false;
    if (Array.isArray(aud)) return aud.some(a => allowedAudiences.includes(a));
    return allowedAudiences.includes(aud);
};

/**
 * Issue an OAuth2 access token using private_key_jwt + mTLS.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const issueToken = (req, res) => {
    const { grant_type, client_assertion, client_assertion_type, resource, scope } = req.body;

    // 1. Basic Validation
    if (grant_type !== 'client_credentials') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    if (client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !client_assertion) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Missing or invalid client_assertion' });
    }

    if (!resource) {
        // Strict RFC 8707: resource is required given our architecture
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing resource parameter (RFC 8707)' });
    }

    // 2. Decode Assertion (pre-validation)
    let decodedAssertion = null;
    try {
        decodedAssertion = jwt.decode(client_assertion);
    } catch (e) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid JWT' });
    }

    if (!decodedAssertion || !decodedAssertion.sub || !decodedAssertion.iss) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid JWT structure' });
    }

    // 3. Find Client
    const clientId = decodedAssertion.iss;
    const client = clients.find(c => c.clientId === clientId);
    if (!client) {
        // ...
        return res.status(401).json({ error: 'invalid_client', error_description: 'Client not registered' });
    }

    // 4. Verify Signature + Audience/Issuer checks
    try {
        const cert = fs.readFileSync(client.certPath);
        const tokenEndpointCandidates = [
            `https://${req.get('host')}/token`,
            `http://${req.get('host')}/token`,
            'https://pcm-core:3000/token',
            'http://pcm-core:3000/token'
        ];

        if (decodedAssertion.sub !== decodedAssertion.iss) {
            return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid JWT subject/issuer' });
        }

        if (!isAllowedAudience(decodedAssertion.aud, tokenEndpointCandidates)) {
            return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid JWT audience' });
        }

        jwt.verify(client_assertion, cert, { algorithms: ['RS256'], audience: tokenEndpointCandidates });
    } catch (err) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Signature verification failed' });
    }

    // 5. UDAP B2B Validation & Actor Binding
    // STRICT SCOPE ENFORCEMENT PER REQUIREMENT
    let consentedScopes = 'system/*.cruds'; // Default for PCM access

    let patientContext = null; // Store patient context

    const udapExt = decodedAssertion.extensions?.['hl7-b2b'];
    if (udapExt) {
        // Data Source access identified by UDAP B2B extension
        consentedScopes = "patient/Observation.rs?_security=http://fhir.health.gov.il/cs/hdp-information-buckets|laboratoryTests&date=ge2024-01-01";

        console.log('[Auth] Processing UDAP B2B Extension:', JSON.stringify(udapExt));

        // 5.1 Org Validation (existing)
        const claimedOrgId = udapExt.organization_id?.split('/').pop();
        if (claimedOrgId !== client.organizationId) {
            return res.status(401).json({ error: 'unauthorized_client', error_description: 'Organization ID mismatch' });
        }

        // 5.2 Consent Validation
        const consentRefUrl = udapExt.consent_reference?.[0];
        if (consentRefUrl) {
            const consentId = consentRefUrl.split('/').pop();
            const consent = fhirStore.get('Consent', consentId);

            if (!consent) {
                return res.status(400).json({ error: 'invalid_grant', error_description: 'Consent not found' });
            }

            if (consent.status !== 'active') {
                return res.status(400).json({ error: 'invalid_grant', error_description: 'Consent not active' });
            }

            // Extract Patient Business Identifier
            // Format: "system|value" e.g. "http://fhir.health.gov.il/identifier/il-national-id|000000018"
            if (consent.patient && consent.patient.identifier) {
                const idObj = consent.patient.identifier;
                // If array, find the one matching our known system? Or just take the first/object?
                // The client sends a single object usually in our POC.
                // Assuming it's an object or array.
                const pid = Array.isArray(idObj) ? idObj[0] : idObj;
                if (pid && pid.system && pid.value) {
                    patientContext = `${pid.system}|${pid.value}`;
                }
            }

            // 5.3 Verify Resource Indicator Alignment
            // The requested 'resource' (Endpoint) MUST be present in the Consent's Provision via Actor (Custodian) -> Org -> Endpoint.
            const actors = consent.provision?.actor || [];

            // Find Custodians (Data Sources)
            const custodianActors = actors.filter(a => a.role?.coding?.some(c => c.code === 'CST'));

            let resourceMatchFound = false;

            // Iterate custodians to see if any owns the requested resource
            for (const actor of custodianActors) {
                const orgId = actor.reference?.reference?.split('/').pop();
                const org = fhirStore.get('Organization', orgId);

                if (org && org.endpoint) {
                    for (const epRefObj of org.endpoint) {
                        const epId = epRefObj.reference?.split('/').pop();
                        const endpoint = fhirStore.get('Endpoint', epId);

                        // Compare requested resource URL with Endpoint Address
                        // Simple string match or prefix match? RFC implies exact or prefix. 
                        // Our system uses exact URL matching for simplicity.
                        if (endpoint && endpoint.address === resource) {
                            resourceMatchFound = true;
                            break;
                        }
                    }
                }
                if (resourceMatchFound) break;
            }

            if (!resourceMatchFound) {
                console.warn(`[Auth] Resource Binding Failed. Requested: ${resource}. Consent ${consentId} does not allow access to this resource.`);
                return res.status(400).json({ error: 'invalid_target', error_description: 'Requested resource is not authorized by the referenced consent' });
            }


            // 5.4 Validate Actor Binding (Client is IRCP)
            const isActor = actors.some(a => {
                const refId = a.reference?.reference?.split('/').pop();
                return refId === client.organizationId;
            });
            if (!isActor) {
                return res.status(401).json({ error: 'access_denied', error_description: 'Client is not a party to this consent' });
            }
        }
    }

    // 5. Provide cnf (Certificate Confirmation) - RFC 8705
    // Use the registered client certificate (from client_assertion verification)
    let cnf = null;
    let assertionThumbprint = null;
    let peerThumbprint = null;
    try {
        const assertionCert = fs.readFileSync(client.certPath, 'utf8');
        assertionThumbprint = certToX5tS256(assertionCert);
        cnf = { "x5t#S256": assertionThumbprint };
    } catch (e) {
        console.error('Failed to calculate cnf from client assertion cert', e);
    }

    // Compare with presented mTLS certificate and warn if mismatch (do not block)
    try {
        const peer = req.socket.getPeerCertificate(true);
        if (peer && peer.raw) {
            peerThumbprint = certToX5tS256(peer.raw);
        }
        if (assertionThumbprint && peerThumbprint && assertionThumbprint !== peerThumbprint) {
            logger.warn('Client assertion cert thumbprint does not match mTLS peer cert', {
                assertion_x5t: assertionThumbprint,
                peer_x5t: peerThumbprint,
                client_id: client.clientId
            });
        }
    } catch (e) {
        console.error('Failed to compare mTLS peer cert with client assertion cert', e);
    }

    // 6. Build FHIR Context
    const fhirContext = [];

    // Add Consent Context
    if (udapExt && udapExt.consent_reference?.[0]) {
        const consentId = udapExt.consent_reference[0].split('/').pop();
        const consent = fhirStore.get('Consent', consentId);
        if (consent) {
            // Use Business Identifier if available, otherwise fallback to Logical ID
            const bizId = consent.identifier?.[0] || {
                system: "http://pcm.fhir.health.gov.il/identifier/pcm-consent-id",
                value: consent.id
            };

            fhirContext.push({
                type: "Consent",
                identifier: {
                    system: bizId.system,
                    value: bizId.value
                }
            });

            // Add HealthcareService Context
            // The Consent points to a pcmService (HealthcareService) via extension.
            // We emit the catalog identifier (not a reference) in fhirContext.
            const pcmServiceExt = consent.extension?.find(e => e.url === EXT_PCM_SERVICE);
            if (pcmServiceExt && pcmServiceExt.valueReference) {
                const serviceId = pcmServiceExt.valueReference.reference.split('/').pop();
                const service = fhirStore.get('HealthcareService', serviceId);
                if (service) {
                    let canonicalService = null;
                    const basedOnExt = service.extension?.find(e => e.url === EXT_BASED_ON_CANONICAL);
                    if (basedOnExt?.valueReference?.reference) {
                        const canonicalId = basedOnExt.valueReference.reference.split('/').pop();
                        canonicalService = fhirStore.get('HealthcareService', canonicalId);
                    }

                    const serviceContext = buildHealthcareServiceContext(service, canonicalService);
                    if (serviceContext) {
                        fhirContext.push(serviceContext);
                    }
                }
            }
        }
    }

    // 7. Issue Token
    const token = uuidv4();
    const expiresIn = 30; // Short lived
    const now = Math.floor(Date.now() / 1000);

    const tokenAud = resource; // Use the verified resource as audience in the token

    const tokenData = {
        active: true,
        sub: client.clientId,
        scope: consentedScopes || client.scopes.join(' '),
        iss: 'http://pcm.fhir.health.gov.il/', // Updated to match example/requirement
        aud: tokenAud,
        client_id: client.clientId,
        organization_id: client.organizationId,
        patient: patientContext, // "system|value"
        fhirContext: fhirContext,
        cnf: cnf,
        exp: now + expiresIn,
        iat: now
    };

    // Store in memory
    tokens.set(token, tokenData);

    logger.info('Token Issued (Opaque)', {
        type: 'TOKEN_ISSUED',
        client_id: client.clientId,
        token_guid: token,
        claims: tokenData,
        store_size: tokens.size
    });

    res.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope: consentedScopes
    });
};

router.post('/token', requireMtls, issueToken);

/**
 * Validate bearer token for introspection requests.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized', active: false });
    }
    const token = authHeader.split(' ')[1];

    const tokenData = tokens.get(token);

    if (!tokenData) {
        return res.status(401).json({ error: 'Invalid Token', active: false });
    }

    const now = Math.floor(Date.now() / 1000);
    if (tokenData.exp < now) {
        tokens.delete(token);
        return res.status(401).json({ error: 'Token Expired', active: false });
    }

    req.user = tokenData;
    next();
};

/**
 * Introspect an opaque access token and return associated claims.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const introspectToken = (req, res) => {
    // 1. Authenticate the Introspector (Done by middleware req.user)
    const introspectorClientId = req.user.sub;
    const introspectorOrgId = req.user.organization_id;

    // 2. Identify Introspector's Address
    if (!introspectorOrgId) {
        logger.error(`Introspector ${introspectorClientId} has no mapped organization`);
        return res.status(403).json({ error: 'forbidden', error_description: 'Introspector identity unknown' });
    }

    const introspectorOrg = fhirStore.get('Organization', introspectorOrgId);
    if (!introspectorOrg || !introspectorOrg.endpoint || !introspectorOrg.endpoint.length) {
        logger.error(`Introspector Org ${introspectorOrgId} missing endpoint`);
        return res.status(403).json({ error: 'forbidden', error_description: 'Introspector has no endpoint' });
    }

    const endpointRef = introspectorOrg.endpoint[0].reference;
    const parts = endpointRef.split('/');
    const endpointRes = fhirStore.get(parts[0], parts[1]);

    if (!endpointRes || !endpointRes.address) {
        logger.error(`Endpoint resource not found or missing address for ref ${endpointRef}`);
        return res.status(403).json({ error: 'forbidden' });
    }

    const introspectorAddress = endpointRes.address;
    logger.info(`Introspection Request from ${introspectorClientId} (${introspectorAddress})`);

    // 3. Inspect the Target Token
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'missing_token' });

    const targetTokenData = tokens.get(token);

    if (!targetTokenData) return res.json({ active: false });

    if (targetTokenData.exp < Math.floor(Date.now() / 1000)) return res.json({ active: false });

    // 4. Audience Check
    // If the token audience doesn't match the Introspector's Address, say it's inactive.
    // (This enforces that tokens are bound to specific resource servers)
    if (targetTokenData.aud !== introspectorAddress) {
        logger.warn(`Token Audience Mismatch. Token Aud: ${targetTokenData.aud}, Introspector Valid Aud: ${introspectorAddress}`);
        return res.json({ active: false });
    }

    res.json(targetTokenData);
};

router.post('/introspect', requireMtls, requireAuth, introspectToken);

module.exports = router;
