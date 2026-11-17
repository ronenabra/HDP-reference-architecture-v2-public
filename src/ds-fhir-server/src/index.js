/**
 * DS FHIR server entrypoint (internal resource server).
 */
const express = require('express');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { verifyLocalJwt } = require('./local-jwt');
const { applyModeWarningHeaders, buildEffectivePolicy, logPolicyBanner } = require('../../shared/conformance-policy');
const { createRuntimeListener } = require('./runtime-listener');

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
const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';
const TEAM_CONFIG_PATH = process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json';

const { readTeamConfig: readValidatedTeamConfig } = require('../../shared/team-config-validator');

/** Read the selected complete runtime file without fallback. */
const readTeamConfig = () => readValidatedTeamConfig(TEAM_CONFIG_PATH, { env: process.env });
/** Validate the selected file and return its coordinated revision/listener policy. */
function readRuntimeSnapshot() {
    const config = readTeamConfig();
    return {
        revision: `${config.runtime?.revision || 0}:${config.runtime?.certificateRevision || 0}:${config.security.dsGatewayToFhirServer.protocol}`,
        policy: buildEffectivePolicy(config, process.env)
    };
}
const startupSnapshot = readRuntimeSnapshot();
let activePolicy = startupSnapshot.policy;

// --- Logging Middleware ---
const logger = require('./logger');
logger.initialize();
logger.installProcessHandlers('ds-fhir-server');
logger.logBoot('ds-fhir-server');
logPolicyBanner(logger, 'ds-fhir-server', activePolicy);
app.use((req, res, next) => {
    applyModeWarningHeaders(res, activePolicy);
    next();
});
app.use(logger.requestLogger);

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', service: 'ds-fhir-server', conformanceMode: activePolicy.mode });
});

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
const validateToken = async (req, res, next) => {
    // In this network architecture, NGINX overwrites the processing Authorization header
    // with the X-Local-Token returned by the adapter.
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send('Missing Local Token');
    }
    const token = authHeader.split(' ')[1];

    try {
        const decoded = await verifyLocalJwt(token);
        const uri = req.originalUrl.startsWith('/fhir') ? req.originalUrl : `/fhir${req.originalUrl}`;
        if (decoded.request_binding.method !== req.method || decoded.request_binding.uri !== uri) throw new Error('Local JWT request binding mismatch');
        req.user = decoded;
        logger.info('Token Validated: local JWT', {
            type: 'TOKEN_VALIDATION',
            category: 'security',
            visibility: 'default',
            payload: decoded
        });
        next();
    } catch (err) {
        logger.warn('Token Validation Failed: local JWT', {
            type: 'TOKEN_VALIDATION_FAILED',
            error: err.message
        });
        return res.status(403).send('Invalid Local Token');
    }
};

app.use(validateToken);

/** The compatibility distribution has no qualified clinical matcher. */
app.all(/^\/(?:fhir(?:\/.*)?|Observation(?:\/.*)?|Patient(?:\/.*)?)$/, (_req, res) => {
    res.status(403).type('application/fhir+json').json({ resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-supported', diagnostics:
            'Legacy Node clinical access is unavailable: this source cannot enforce approved SMART predicates. Select a qualified native HAPI source.' }] });
});
app.use(logger.errorLogger);

/** Prepare and return a Node server using the supplied validated snapshot's transport. */
function createServer(snapshot) {
    if (snapshot.policy.transport.dataSourceGatewayToFhir.protocol !== 'https') {
        return http.createServer({ maxHeaderSize: 65536 }, app);
    }
    return https.createServer({
        maxHeaderSize: 65536,
        key: fs.readFileSync(process.env.FHIR_SERVER_KEY || `${CERTS_DIR}/ds-fhir-server.key`),
        cert: fs.readFileSync(process.env.FHIR_SERVER_CERT || `${CERTS_DIR}/ds-fhir-server.crt`)
    }, app);
}

const runtime = createRuntimeListener({
    readSnapshot: readRuntimeSnapshot, createServer, port: PORT, logger, configPath: TEAM_CONFIG_PATH,
    onActive: snapshot => { activePolicy = snapshot.policy; }
});
let runtimeWatcher;
runtime.start(startupSnapshot).then(() => {
    runtimeWatcher = setInterval(() => { void runtime.check(); }, 1000);
}).catch(error => {
    logger.error(`DS FHIR startup failed: ${error.message}`, { type: 'PROCESS_LISTENER_ERROR', error: error.message });
    process.exitCode = 1;
});

process.on('SIGTERM', () => {
    logger.warn('SIGTERM signal received: closing HTTP server', {
        type: 'PROCESS_SIGNAL',
        category: 'lifecycle',
        visibility: 'diagnostic',
        causesSystemFlow: false,
        signal: 'SIGTERM'
    });
    clearInterval(runtimeWatcher);
    runtime.stop().then(() => {
        logger.info('HTTP server closed', {
            type: 'PROCESS_SHUTDOWN_COMPLETE',
            category: 'lifecycle',
            visibility: 'diagnostic',
            causesSystemFlow: false
        });
        process.exit(0);
    });
});
