/**
 * Identity mapping from PCM introspection to local DS tokens.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('./logger');

// In real life, load keys from file
const LOCAL_PRIVATE_KEY = 'local-secret-key-for-internal-usage'; // or load from certs/ds-adapter.key

/**
 * Maps the Global Identity (PCM) to a Local Identity (Data Source).
 * 
 * Logic:
 * 1. Validates the token is active.
 * 2. Extracts the `patient` context (National ID).
 * 3. Hashes the National ID to create a secure, consistent Logical ID (`Patient/[Hash]`).
 * 4. Mints a short-lived local JWT with the new subject.
 * 
 * @param {Object} pcmIntrospectionResult - Response from PCM Introspection Endpoint
 * @returns {string} Signed Local JWT
 */
function mapIdentity(pcmIntrospectionResult) {
    if (!pcmIntrospectionResult.active) {
        throw new Error('Token is not active');
    }

    // Logic: Map National ID (from PCM token) to Local ID

    // 1. Check if 'patient' context is present in the Introspection Result
    // (Added by pcm-core/auth.js logic)
    // Format expected: "system|value" e.g. "http://fhir.health.gov.il/identifier/il-national-id|000000018"
    const patientContext = pcmIntrospectionResult.patient;

    if (!patientContext) {
        // Logging context issues should be handled by the caller or a logger instance if passed
        throw new Error('Missing mandatory patient context');
    }

    if (patientContext && patientContext.includes('|')) {
        // Extract the value (after the pipe)
        const parts = patientContext.split('|');
        const value = parts[1];

        // 2. Hash the numerical part (value) to create a Logical ID
        // The Data Source stores data under "Patient/[HashedID]"

        // Hashing Algo: SHA256 of the value
        const hash = crypto.createHash('sha256').update(value).digest('hex');

        // Construct the Local Subject (Logical ID)
        // sub: "Patient/[hash]"
        const localSubject = `Patient/${hash}`;

        logger.info(`Mapped Business ID ${value} -> Logical ID ${localSubject}`, {
            type: 'IDENTITY_MAPPED',
            business_id: value,
            logical_id: localSubject
        });

        const localPayload = {
            // Keep sub as client_id for POC, and carry mapped patient separately.
            sub: pcmIntrospectionResult.client_id,
            scope: pcmIntrospectionResult.scope, // Pass-through scopes
            iss: pcmIntrospectionResult.iss,
            aud: pcmIntrospectionResult.aud,
            jti: pcmIntrospectionResult.jti,
            iat: pcmIntrospectionResult.iat,
            client_id: pcmIntrospectionResult.client_id,
            fhirContext: pcmIntrospectionResult.fhirContext,
            cnf: pcmIntrospectionResult.cnf,

            // Include mapped patient identity
            patient: localSubject
        };

        return jwt.sign(localPayload, LOCAL_PRIVATE_KEY, { algorithm: 'HS256', expiresIn: '30s' });
    }

    throw new Error('Invalid patient identifier format');
}

module.exports = { mapIdentity };
