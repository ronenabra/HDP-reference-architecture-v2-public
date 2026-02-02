/**
 * DS FHIR server entrypoint (internal resource server).
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { buildObservationBundle } = require('./observation');

/**
 * DS FHIR Server (Internal Resource Server)
 * 
 * Security:
 * - Not exposed directly to internet.
 * - Only accessible via ds-gateway (NGINX).
 * - Trusts the "Local Token" (JWT) minted by ds-auth-adapter.
 * - Does NOT contact PCM Core (Adapter does that).
 */

const app = express();
const PORT = process.env.PORT || 3000;
const LOCAL_PRIVATE_KEY = 'local-secret-key-for-internal-usage'; // Must match ds-auth-adapter

// --- Logging Middleware ---
const logger = require('./logger');
app.use(logger.requestLogger);

/**
 * Middleware: Validate Local Token
 * 
 * Validates the JWT injected by NGINX (ds-gateway) after successful
 * introspection by ds-auth-adapter.
 */
/**
 * Validate the local JWT injected by the gateway.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const validateToken = (req, res, next) => {
    // In this network architecture, NGINX overwrites the processing Authorization header
    // with the X-Local-Token returned by the adapter.
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Missing Local Token');
    }
    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, LOCAL_PRIVATE_KEY);
        req.user = decoded;
        logger.info('Token Validated', { type: 'TOKEN_VALIDATION', payload: decoded });
        next();
    } catch (err) {
        return res.status(403).send('Invalid Local Token');
    }
};

app.use(validateToken);

/**
 * Return Observations for the mapped patient context.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
app.get('/Observation', (req, res) => {
    // POC behavior: ignore scopes and return data solely by patient context.
    const bundle = buildObservationBundle(req.user?.patient);
    res.type('application/fhir+json');
    res.json(bundle);
});

const server = app.listen(PORT, () => {
    console.log(`DS FHIR Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});
