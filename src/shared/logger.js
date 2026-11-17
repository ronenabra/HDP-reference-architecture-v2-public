/**
 * Shared Node service logging with explicit startup rotation and request middleware.
 */
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID: uuidv4 } = require('crypto');

const { classifyRoute, knownLogClassification, sanitizeLogDetails, sanitizeLogMessage } = require('./log-policy');
const { createEventMetadata } = require('./log-event');
const { createTraceContext, formatTraceparent, propagationHeaders } = require('./trace-context');

/** Create one service logger; startup rotation and process hooks are explicit. */
function createLogger({ service, onFinished }) {
    const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
    const CURRENT_LOG_FILE = path.join(LOG_DIR, 'current.log');
    const HISTORY_DIR = path.join(LOG_DIR, 'history');
    const SESSION_ID = process.env.LOG_SESSION_ID || uuidv4();
    let sequence = 0;
    let processHandlersInstalled = false;
    const context = new AsyncLocalStorage();

    let initialized = false;

    /** Rotate the previous process log once, when the service actually starts. */
    function initialize() {
        if (initialized) return;
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        if (fs.existsSync(CURRENT_LOG_FILE)) {
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            const destDir = path.join(HISTORY_DIR, timestamp);
            fs.mkdirSync(destDir, { recursive: true });
            fs.renameSync(CURRENT_LOG_FILE, path.join(destDir, 'app.log'));
        }
        initialized = true;
    }

    /** Serialize diagnostics including errors, bigint values and circular references. */
    function safeJson(value) {
        const seen = new WeakSet();
        return JSON.stringify(value, (key, item) => {
            if (typeof item === 'bigint') return item.toString();
            if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
            if (item && typeof item === 'object') {
                if (seen.has(item)) return '[Circular]';
                seen.add(item);
            }
            return item;
        });
    }

    function currentContext() {
        return context.getStore() || {};
    }

    function withContext(values, fn) {
        return context.run({ ...currentContext(), ...values }, fn);
    }

    /** Return only emitted span fields, never guessed from legacy correlation IDs. */
    function traceDetails(values = currentContext()) {
        if (!formatTraceparent(values)) return {};
        return {
            traceId: values.traceId,
            spanId: values.spanId,
            ...(values.parentSpanId ? { parentSpanId: values.parentSpanId } : {}),
            traceFlags: values.traceFlags
        };
    }

    /** Append one full-fidelity, AWS-safe structured entry with active request context. */
    function log(level, message, details = {}) {
        const activeContext = currentContext();
        const safeDetails = sanitizeLogDetails(details);
        const entry = {
            timestamp: new Date().toISOString(),
            tick: process.hrtime.bigint().toString(),
            sequence: ++sequence,
            id: uuidv4(),
            level,
            message: sanitizeLogMessage(message),
            details: {
                // Scrub inherited metadata too, without traversing a potentially
                // large FHIR body a second time after safeDetails was prepared.
                ...sanitizeLogDetails({
                    sessionId: SESSION_ID,
                    ...traceDetails(activeContext),
                    ...(activeContext.correlationId && !safeDetails.correlationId ? { correlationId: activeContext.correlationId } : {}),
                    ...(activeContext.flowId && !safeDetails.flowId ? { flowId: activeContext.flowId } : {}),
                    ...(activeContext.logCategory && !safeDetails.category ? { category: activeContext.logCategory } : {}),
                    ...(activeContext.logVisibility && !safeDetails.visibility ? { visibility: activeContext.logVisibility } : {}),
                    ...(activeContext.operation && !safeDetails.operation ? { operation: activeContext.operation } : {}),
                    ...(activeContext.causesSystemFlow !== undefined && safeDetails.causesSystemFlow === undefined ? { causesSystemFlow: activeContext.causesSystemFlow } : {})
                }),
                ...safeDetails
            }
        };
        entry.event = createEventMetadata(entry, {
            componentId: service,
            role: { 'pcm-core': 'pcm', 'sp-client': 'doctor', 'ds-auth-adapter': 'adapter', 'ds-fhir-server': 'fhir' }[service] || 'application',
            ...(process.env.HO_ID ? { healthOrganizationId: process.env.HO_ID } : {})
        });
        Object.assign(entry.details, knownLogClassification(entry, entry.event.source));

        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(CURRENT_LOG_FILE, safeJson(entry) + '\n');
        } catch (err) {
            console.error(`[LOGGER_ERROR] failed to write structured log: ${err.message}`);
        }

        // Also log to console for Docker logs
        console.log(`[${level}] ${sanitizeLogMessage(message)}`);
    }

    function logBoot(serviceName = 'service') {
        log('INFO', `Service booted: ${serviceName}`, {
            type: 'PROCESS_BOOT',
            category: 'lifecycle',
            visibility: 'diagnostic',
            causesSystemFlow: false,
            service: serviceName,
            pid: process.pid,
            nodeVersion: process.version
        });
    }

    function installProcessHandlers(serviceName = 'service') {
        if (processHandlersInstalled) return;
        processHandlersInstalled = true;
        process.on('unhandledRejection', reason => {
            log('ERROR', `Unhandled rejection in ${serviceName}`, {
                type: 'PROCESS_UNHANDLED_REJECTION',
                category: 'lifecycle',
                visibility: 'default',
                causesSystemFlow: false,
                service: serviceName,
                reason
            });
        });
        process.on('uncaughtException', err => {
            log('ERROR', `Uncaught exception in ${serviceName}`, {
                type: 'PROCESS_UNCAUGHT_EXCEPTION',
                category: 'lifecycle',
                visibility: 'default',
                causesSystemFlow: false,
                service: serviceName,
                error: err
            });
            process.exitCode = 1;
            setTimeout(() => process.exit(1), 50).unref();
        });
        process.on('warning', warning => {
            log('WARN', `Process warning in ${serviceName}: ${warning.message}`, {
                type: 'PROCESS_WARNING',
                category: 'lifecycle',
                visibility: 'diagnostic',
                causesSystemFlow: false,
                service: serviceName,
                warning
            });
        });
    }

    return {
        getLogPath: () => CURRENT_LOG_FILE,
        info: (msg, details) => log('INFO', msg, details),
        error: (msg, details) => log('ERROR', msg, details),
        warn: (msg, details) => log('WARN', msg, details),
        debug: (msg, details) => log('DEBUG', msg, details),
        getCorrelationId: () => currentContext().correlationId,
        getFlowId: () => currentContext().flowId,
        getTraceContext: () => traceDetails(),
        getPropagationHeaders: () => propagationHeaders(currentContext()),
        getSessionId: () => SESSION_ID,
        withContext,
        classifyRoute,
        initialize,
        installProcessHandlers,
        logBoot,

        /**
         * Express middleware for structured request/response logging.
         * @param {import('express').Request} req
         * @param {import('express').Response} res
         * @param {import('express').NextFunction} next
         * @returns {void}
         */
        requestLogger: (req, res, next) => {
            const startedAt = Date.now();
            const incomingCorrelationId = req.get('x-correlation-id') || req.get('x-request-id') || uuidv4();
            const policy = classifyRoute(req.path || req.originalUrl, service);
            const incomingFlowId = req.get('x-flow-id') || (service === 'sp-client' && policy.causesSystemFlow ? uuidv4() : undefined);
            const trace = createTraceContext(req.get('traceparent'));
            const requestContext = {
                correlationId: incomingCorrelationId,
                flowId: incomingFlowId,
                requestId: incomingCorrelationId,
                ...trace,
                // Explicitly clear a possible outer span parent for a new root.
                parentSpanId: trace.parentSpanId,
                logCategory: policy.category,
                logVisibility: policy.visibility,
                operation: policy.operation,
                causesSystemFlow: policy.causesSystemFlow
            };
            req.requestId = incomingCorrelationId;
            res.setHeader('x-correlation-id', incomingCorrelationId);
            if (incomingFlowId) res.setHeader('x-flow-id', incomingFlowId);
            res.setHeader('traceparent', formatTraceparent(trace));

            if (policy.emitMiddleware === false) return withContext(requestContext, next);

            // Strict Filtering: Allowlist approach
            // 1. Always allow actions (POST, PUT, DELETE, etc.)
            // 2. Allow specific API paths: /fhir, /token, /introspect, /auth-check
            // 3. Explicitly ignore everything else (incl. standard page loads /ui, /)

            const isAction = req.method !== 'GET';
            // Allow FHIR resource paths (Patient, Consent, Observation) as Nginx strips /fhir prefix
            const allowedPaths = [
                ...(['pcm-core', 'sp-client'].includes(service) ? ['/api/fhir-service/r4'] : []), '/fhir', '/token', '/introspect', '/auth-check',
                '/Patient', '/RelatedPerson', '/Consent', '/Contract', '/Observation'
            ];
            const isAllowedPath = allowedPaths.some(p => req.originalUrl.includes(p))
                || (service === 'pcm-core' && policy.operation === 'system-authentication-browser');

            if (!isAction && !isAllowedPath) return withContext(requestContext, next);

            return withContext(requestContext, () => {
                // Log Request
                log('INFO', `Request Received: ${req.method} ${req.originalUrl}`, {
                    type: 'REQUEST',
                    requestId: incomingCorrelationId,
                    correlationId: incomingCorrelationId,
                    ...(incomingFlowId ? { flowId: incomingFlowId } : {}),
                    category: policy.category,
                    visibility: policy.visibility,
                    operation: policy.operation,
                    causesSystemFlow: policy.causesSystemFlow,
                    method: req.method,
                    url: req.originalUrl,
                    headers: req.headers,
                    ...(service === 'ds-auth-adapter' ? { healthOrganizationId: process.env.HO_ID || 'reference', componentRole: 'adapter' } : {}),
                    body: service === 'ds-auth-adapter' ? (req.rawBody ?? req.body) : req.body
                });

                // Capture Response
                const originalSend = res.send;
                let responseBody;

                res.send = function (body) {
                    responseBody = body;
                    // Try to parse if string to ensure JSON in logs
                    if (typeof body === 'string') {
                        try {
                            const parsed = JSON.parse(body);
                            responseBody = parsed;
                        } catch (e) { /* ignore */ }
                    }
                    return originalSend.apply(res, arguments);
                };

                let finalized = false;
                const logCompletion = (eventName, finishError) => {
                    if (finalized) return;
                    finalized = true;
                    let level = 'INFO';
                    if (res.statusCode >= 500) level = 'ERROR';
                    else if (res.statusCode >= 400) level = 'WARN';

                    log(level, `${eventName === 'finish' ? 'Response Sent' : 'Response Closed'}: ${res.statusCode} ${req.method} ${req.originalUrl}`, {
                        type: 'RESPONSE',
                        requestId: incomingCorrelationId,
                        correlationId: incomingCorrelationId,
                        ...(incomingFlowId ? { flowId: incomingFlowId } : {}),
                        category: policy.category,
                        visibility: policy.visibility,
                        operation: policy.operation,
                        causesSystemFlow: policy.causesSystemFlow,
                        lifecycleEvent: eventName,
                        statusCode: res.statusCode,
                        method: req.method,
                        url: req.originalUrl,
                        ...(service === 'ds-auth-adapter' ? { healthOrganizationId: process.env.HO_ID || 'reference', componentRole: 'adapter', headers: res.getHeaders() } : {}),
                        durationMs: Date.now() - startedAt,
                        aborted: eventName === 'close' && !res.writableEnded,
                        finishError,
                        body: responseBody
                    });
                };

                // Completion may arrive on a socket created outside this ALS scope.
                onFinished(res, err => withContext(requestContext, () => logCompletion(res.writableEnded ? 'finish' : 'close', err)));
                res.on('close', () => withContext(requestContext, () => logCompletion('close')));

                return next();
            });
        },

        errorLogger: (err, req, res, next) => {
            const correlationId = req.requestId || req.get?.('x-correlation-id') || req.get?.('x-request-id') || uuidv4();
            const flowId = req.get?.('x-flow-id') || currentContext().flowId;
            const trace = formatTraceparent(currentContext()) ? traceDetails() : createTraceContext(req.get?.('traceparent'));
            if (!res.headersSent) {
                res.setHeader('x-correlation-id', correlationId);
                res.setHeader('traceparent', formatTraceparent(trace));
            }
            log('ERROR', `Unhandled route error: ${req.method} ${req.originalUrl}`, {
                type: 'ROUTE_ERROR',
                ...trace,
                requestId: correlationId,
                correlationId,
                ...(flowId ? { flowId } : {}),
                category: currentContext().logCategory || 'system',
                visibility: currentContext().logVisibility || 'default',
                operation: currentContext().operation,
                causesSystemFlow: currentContext().causesSystemFlow ?? true,
                method: req.method,
                url: req.originalUrl,
                error: err
            });
            if (res.headersSent) return next(err);
            // UI listeners may frame safe errors after this same structured event is recorded.
            if (typeof res.locals?.renderBrowserError === 'function') return res.locals.renderBrowserError(err);
            if (service !== 'pcm-core') return res.status(err.status || err.statusCode || 500).send('Internal Server Error');
            if (/^\/api\/fhir-service\/r4(?:\/|$)/.test(req.originalUrl || '') && !/\/(?:token|introspect|authorize)(?:[/?]|$)/.test(req.originalUrl || '')) {
                res.type('application/fhir+json');
                return res.status(err.status || err.statusCode || 500).json({
                    resourceType: 'OperationOutcome',
                    issue: [{
                        severity: 'error',
                        code: err.status === 400 || err.statusCode === 400 ? 'invalid' : 'exception',
                        diagnostics: err.status === 400 || err.statusCode === 400
                            ? 'Invalid FHIR request body'
                            : 'FHIR interaction failed'
                    }]
                });
            }
            res.status(err.status || err.statusCode || 500).json({ error: 'internal_error', error_description: err.message });
        }
    };

}

module.exports = { createLogger };
