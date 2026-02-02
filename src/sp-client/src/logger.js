/**
 * SP client logger with file rotation and request logging middleware.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const LOG_DIR = path.join(process.cwd(), 'logs');
const CURRENT_LOG_FILE = path.join(LOG_DIR, 'current.log');
const HISTORY_DIR = path.join(LOG_DIR, 'history');

// Ensure log directories exist
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// Rotate logs on startup
if (fs.existsSync(CURRENT_LOG_FILE)) {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const destDir = path.join(HISTORY_DIR, timestamp);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(CURRENT_LOG_FILE, path.join(destDir, 'app.log'));
}

/**
 * Write a log entry to disk and console.
 * @param {string} level
 * @param {string} message
 * @param {object} details
 * @returns {void}
 */
function log(level, message, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        tick: process.hrtime.bigint().toString(), // High-res for sorting
        id: uuidv4(),
        level,
        message,
        details
    };

    // Append to file
    fs.appendFileSync(CURRENT_LOG_FILE, JSON.stringify(entry) + '\n');

    // Also log to console for Docker logs
    console.log(`[${level}] ${message}`);
}

module.exports = {
    info: (msg, details) => log('INFO', msg, details),
    error: (msg, details) => log('ERROR', msg, details),
    warn: (msg, details) => log('WARN', msg, details),
    debug: (msg, details) => log('DEBUG', msg, details),

    /**
     * Express middleware for structured request/response logging.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     * @returns {void}
     */
    requestLogger: (req, res, next) => {
        // Filter out log polling
        if (req.originalUrl.startsWith('/api/logs')) {
            return next();
        }

        // Strict Filtering: Allowlist approach
        // 1. Always allow actions (POST, PUT, DELETE, etc.)
        // 2. Allow specific API paths: /fhir, /token, /introspect, /auth-check
        // 3. Explicitly ignore everything else (incl. standard page loads /ui, /)

        const isAction = req.method !== 'GET';
        // Allow FHIR resource paths (Patient, Consent, Observation) as Nginx strips /fhir prefix
        const allowedPaths = [
            '/r4', '/fhir', '/token', '/introspect', '/auth-check',
            '/Patient', '/Consent', '/Observation'
        ];
        // Explicitly exclude UI form submissions to reduce noise as requested
        const excludedPaths = ['/create-consent', '/fetch-data', '/reset', '/discover'];

        const isAllowedPath = allowedPaths.some(p => req.originalUrl.includes(p));
        const isExcludedPath = excludedPaths.some(p => req.originalUrl.includes(p)) || req.originalUrl === '/';

        if ((!isAction && !isAllowedPath) || isExcludedPath) {
            return next();
        }

        const requestId = uuidv4();
        req.requestId = requestId;

        // Log Request
        log('INFO', `Incoming ${req.method} ${req.originalUrl}`, {
            type: 'REQUEST',
            requestId,
            method: req.method,
            url: req.originalUrl,
            headers: req.headers,
            body: req.body
        });

        // Capture Response
        const originalSend = res.send;
        let responseBody;

        res.send = function (body) {
            responseBody = body;
            // Try to parse if string to ensure JSON in logs
            if (typeof body === 'string') {
                try {
                    responseBody = JSON.parse(body);
                } catch (e) { /* ignore */ }
            }
            originalSend.apply(res, arguments);
        };

        res.on('finish', () => {
            let level = 'INFO';
            if (res.statusCode >= 500) level = 'ERROR';
            else if (res.statusCode >= 400) level = 'WARN';

            log(level, `Response ${res.statusCode} ${req.method} ${req.originalUrl}`, {
                type: 'RESPONSE',
                requestId,
                statusCode: res.statusCode,
                body: responseBody
            });
        });

        next();
    }
};
