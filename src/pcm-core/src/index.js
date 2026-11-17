/**
 * PCM Core server entrypoint (API + UI).
 */
const express = require('express');
const path = require('path');
const fhirRoutes = require('./routes/fhir');
const authRoutes = require('./routes/auth');
const { createAuthorizeRouter } = require('./routes/authorize');
const uiRoutes = require('./routes/ui');
const { getEffectiveConformancePolicy, getPcmApiClientAuth, loadTeamConfig } = require('./team-config');
const { applyModeWarningHeaders, logPolicyBanner } = require('../../shared/conformance-policy');
const { createApiServerManager, readMetadataHttpsOptions, sameHttpsOptions } = require('./api-server-manager');
const { watchRuntimeConfig } = require('./runtime-watch');
const { configuredLogComponents } = require('./log-ordering');
const { getAuthorizationServerMetadata } = require('./oauth-metadata');
const { readUnifiedPage, readUnifiedDetail } = require('./unified-log-page');
const { clearConfiguredLogs } = require('./log-clear');
const { readComponentLogRecords } = require('./log-reader');
const { createPublicMtlsMiddleware, createBrowserAwareMtlsMiddleware } = require('./public-mtls');

const logger = require('./logger');
const modeHeaders = (req, res, next) => {
    applyModeWarningHeaders(res, getEffectiveConformancePolicy());
    next();
};

const PORT = process.env.PORT || 3000;
const UI_PORT = process.env.UI_PORT || 3001;
const METADATA_PORT = process.env.METADATA_PORT || 3005;
const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';
const SHARED_LOGS_DIR = process.env.SHARED_LOGS_DIR || path.join(process.cwd(), 'shared-logs');
const TEAM_CONFIG_PATH = process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json';

const { normalizeLogEntry, expandLogEntry } = require('./log-normalization');

/** Apply unified timeline normalization to the common component records. */
const readComponentLogs = (dirName, componentLabel, metadata = {}) => {
    try {
        return readComponentLogRecords(SHARED_LOGS_DIR, dirName, componentLabel).flatMap(record => {
            if (!record.parsed) return [];
            try {
                return expandLogEntry(normalizeLogEntry({
                    ...record.parsed,
                    id: record.parsed.id || `${componentLabel}-${record.logFile}-${record.componentLine}`,
                    component: componentLabel, componentLine: record.componentLine, logFile: record.logFile
                })).map(entry => ({ ...entry, details: { ...entry.details, ...metadata } }));
            } catch (_) { return []; }
        });
    } catch (_) { return []; }
};

/**
 * Build the HTTPS API app (OAuth2 + FHIR).
 * @returns {import('express').Express}
 */
const { PCM_PATH } = require('../../shared/pcm-environment');

const createApiApp = () => {
    const app = express();
    app.locals.browserSurface = 'pcmApi';
    app.use(require('./migration-checkpoint').middleware);
    app.use((req, res, next) => { res.locals.browserBase = require('../../shared/browser-navigation').applicationPath(loadTeamConfig().publicBaseUrls.pcmApi, '/', { fhirBase: true }).replace(/\/$/, ''); next(); });

    app.enable('case sensitive routing');
    app.enable('strict routing');
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.use(modeHeaders);
    app.use(createBrowserAwareMtlsMiddleware());
    app.use('/assets', express.static(path.join(__dirname, '..', '..', 'shared', 'ui')));
    // OAuth form duplicates and byte limits must survive generic body parsing.
    app.post([`${PCM_PATH}/token`, `${PCM_PATH}/introspect`, `${PCM_PATH}/authorize`], require('./oauth-form').createOAuthFormParser(loadTeamConfig));
    app.use(express.json({ type: ['application/json', 'application/fhir+json'], limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    app.use(logger.requestLogger);

    app.get(`/.well-known/oauth-authorization-server${PCM_PATH}`, (req, res) => res.json(getAuthorizationServerMetadata(req)));
    app.use('/', require('./routes/system-workflows').createSystemWorkflowRouter());
    app.use(PCM_PATH, createAuthorizeRouter()); // /authorize and its decision interaction
    app.use(PCM_PATH, authRoutes);      // /token, /introspect
    app.use(PCM_PATH, fhirRoutes);
    app.use(logger.errorLogger);

    return app;
};

/**
 * Build the public HTTPS metadata app.
 * @returns {import('express').Express}
 */
const createMetadataApp = () => {
    const app = express();

    app.use(modeHeaders);
    app.use(createPublicMtlsMiddleware({ kind: 'oauth' }));
    app.use(logger.requestLogger);

    app.get([`${PCM_PATH}/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server${PCM_PATH}`], (req, res) => {
        res.json(getAuthorizationServerMetadata(req, { preferConfigured: true }));
    });

    app.use(logger.errorLogger);

    return app;
};

/**
 * Build the HTTP UI app (dashboard, logs, docs).
 * @returns {import('express').Express}
 */
const createUiApp = () => {
    const app = express();
    const browserPage = require('../../shared/browser-page');
    browserPage.prepareBrowserErrors(app, req => browserPage.pageContext(loadTeamConfig(), req, 'pcmUi'));
    app.locals.browserSurface = 'pcmUi';
    const searches = require('./log-search').createLogSearch();
    app.locals.closeLogSearch = searches.close;
    app.use(require('./migration-checkpoint').middleware);
    app.use((req, res, next) => { res.locals.browserBase = require('../../shared/browser-navigation').applicationPath(loadTeamConfig().publicBaseUrls.pcmUi).replace(/\/$/, ''); next(); });

    app.use(modeHeaders);
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    app.use('/assets', express.static(path.join(__dirname, '..', '..', 'shared', 'ui')));

    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(logger.requestLogger);

    app.get('/healthz', (req, res) => {
        res.json({ status: 'ok', service: 'pcm-core-ui' });
    });

    app.get('/logs-view', (req, res) => {
        res.render('logs', { serviceName: 'PCM Core', teamId: loadTeamConfig().teamId, publicBaseUrls: require('../../shared/browser-navigation').browserNavigation(loadTeamConfig().publicBaseUrls, req, 'pcmUi') });
    });

    app.get('/api/unified-logs', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (req.query.source !== undefined && typeof req.query.source !== 'string') throw new TypeError('Invalid configured log source ID');
            const filters = Object.fromEntries(['order', 'tail', 'visibility', 'diagnostics', 'role', 'healthOrganizationId',
                'level', 'method', 'correlationId', 'flowId', 'traceId', 'operationId', 'sourceId', 'path', 'status', 'source'].map(key => [key, String(req.query[key] || '')]));
            const page = readUnifiedPage(SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()), filters,
                req.query.cursor || '', entry => expandLogEntry(normalizeLogEntry(entry)));
            // The opt-in envelope carries paging; older integrations retain their array shape.
            res.json(req.query.page === 'true' ? page : page.entries);
        } catch (error) { res.status(409).json({ error: error.message }); }
    });

    app.get('/api/unified-logs/detail', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(readUnifiedDetail(SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()), req.query.reference, entry => expandLogEntry(normalizeLogEntry(entry)))); }
        catch (error) { res.status(409).json({ error: error.message }); }
    });

    // These operator routes share the existing Logs listener/trust boundary.
    // Filters select only configured inventory, never arbitrary filesystem paths.
    const parseSearchJson = express.json({ limit: '16kb' });
    app.post('/api/unified-logs/search', (req, res, next) => {
        parseSearchJson(req, res, error => {
            if (error) return res.status(error.status === 413 ? 413 : 400).set('Cache-Control', 'no-store').json({ error: 'Invalid or oversized search JSON body' });
            next();
        });
    }, (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.status(202).json(searches.start(SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()), req.body)); }
        catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    });
    app.get('/api/unified-logs/search/:id', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(searches.read(req.params.id, SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()), req.query)); }
        catch (error) { res.status(error.status || 409).json({ error: error.message }); }
    });
    app.delete('/api/unified-logs/search/:id', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(searches.cancel(req.params.id, SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()))); }
        catch (error) { res.status(error.status || 409).json({ error: error.message }); }
    });

    app.post('/api/unified-logs/clear', (req, res) => {
        searches.invalidate(SHARED_LOGS_DIR);
        const result = clearConfiguredLogs(SHARED_LOGS_DIR, configuredLogComponents(loadTeamConfig()));
        res.status(result.status === 'cleared' ? 200 : 207).json(result);
    });

    app.get('/api/logs', (req, res) => {
        const logs = readComponentLogs('pcm-core', 'PCM Core');
        res.json(logs.reverse());
    });

    // Frame repository navigation around the unchanged generated vendor document.
    const docsDirectory = require('node:fs').existsSync('/workspace/docs') ? '/workspace/docs' : path.resolve(__dirname, '../../../docs');
    for (const [reference, filename, title] of [['api', 'api-docs.html', 'PCM API'], ['admin-api', 'admin-api-docs.html', 'Admin API']]) {
        app.get(`/docs/${reference}`, (req, res) => res.render(browserPage.template, {
            ...browserPage.pageContext(loadTeamConfig(), req, 'pcmUi'), reference, title
        }));
        app.get(`/docs/${reference}/content`, (req, res) => res.sendFile(path.join(docsDirectory, filename)));
    }

    app.get('/docs/openapi-admin.yaml', (req, res) => {
        res.type('text/yaml').sendFile('/workspace/docs/openapi-admin.yaml');
    });

    // Strict login navigation shares the HTTPS browser listener with authorization.
    app.use('/sandbox/authentication', (req, res, next) => {
        if (!getEffectiveConformancePolicy().transport.pcmPublic.browserHttpsRequired || req.secure) return next();
        if (req.method !== 'GET') return res.status(401).json({ error: 'access_denied', error_description: 'Browser authentication requires HTTPS' });
        return res.redirect(308, require('../../shared/browser-navigation').pcmWorkflowUrl(loadTeamConfig(), req));
    });
    app.use('/', require('./routes/system-workflows').createSystemWorkflowRouter());
    app.use('/', uiRoutes);

    app.get('/', (req, res) => {
        res.redirect(require('../../shared/browser-navigation').applicationPath(loadTeamConfig().publicBaseUrls.pcmUi, '/ui'));
    });
    app.use(logger.errorLogger);
    browserPage.installBrowserErrors(app, req => browserPage.pageContext(loadTeamConfig(), req, 'pcmUi'));

    return app;
};

const bootstrap = require('./bootstrap');

if (require.main === module) {
logger.initialize();
logger.installProcessHandlers('pcm-core');
logger.logBoot('pcm-core');
logPolicyBanner(logger, 'pcm-core', getEffectiveConformancePolicy());
bootstrap().then(() => {
    const http = require('http');
    const https = require('https');

    const apiApp = createApiApp();
    const metadataApp = createMetadataApp();
    const uiApp = createUiApp();

    const apiServerManager = createApiServerManager({
        app: apiApp,
        port: PORT,
        certsDir: CERTS_DIR,
        getClientAuthMode: getPcmApiClientAuth,
        logger
    });
    apiServerManager.start().catch(err => {
        logger.error(`PCM API server failed to start: ${err.message}`, {
            type: 'PROCESS_STARTUP_FAILED',
            category: 'lifecycle',
            visibility: 'default',
            causesSystemFlow: false,
            service: 'pcm-core-api',
            error: err
        });
        process.exit(1);
    });

    let metadataOptions = readMetadataHttpsOptions(CERTS_DIR, getPcmApiClientAuth());
    let metadataServer = https.createServer(metadataOptions, metadataApp).listen(METADATA_PORT, () => {
        console.log(`PCM Core metadata running on HTTPS port ${METADATA_PORT}`);
    });
    metadataServer.on('error', err => {
        logger.error(`PCM metadata server error: ${err.message}`, {
            type: 'PROCESS_LISTENER_ERROR',
            category: 'lifecycle',
            visibility: 'default',
            causesSystemFlow: false,
            service: 'pcm-core-metadata',
            error: err
        });
    });

    const reloadMetadataServer = reason => {
        const nextOptions = readMetadataHttpsOptions(CERTS_DIR, getPcmApiClientAuth());
        if (sameHttpsOptions(metadataOptions, nextOptions)) return;
        logger.info(`Reloading PCM metadata listener (${reason})`, {
            type: 'PROCESS_RELOAD',
            category: 'lifecycle',
            visibility: 'diagnostic',
            causesSystemFlow: false,
            service: 'pcm-core-metadata',
            reason
        });
        const nextServer = https.createServer(nextOptions, metadataApp);
        nextServer.on('error', err => {
            logger.error(`PCM metadata listener reload failed: ${err.message}`, {
                type: 'PROCESS_RELOAD_FAILED',
                category: 'lifecycle',
                visibility: 'default',
                causesSystemFlow: false,
                service: 'pcm-core-metadata',
                reason,
                error: err
            });
        });
        metadataServer.close(() => {
            metadataOptions = nextOptions;
            metadataServer = nextServer.listen(METADATA_PORT, () => {
                console.log(`PCM Core metadata running on HTTPS port ${METADATA_PORT}`);
            });
        });
    };

    const stopWatchingRuntime = watchRuntimeConfig(TEAM_CONFIG_PATH, revision => {
        apiServerManager.reload(`config revision ${revision}`);
        reloadMetadataServer(`config revision ${revision}`);
    });

    const uiServer = http.createServer(uiApp).listen(UI_PORT, () => {
        console.log(`PCM Core UI running on HTTP port ${UI_PORT}`);
    });
    uiServer.on('error', err => {
        logger.error(`PCM UI server error: ${err.message}`, {
            type: 'PROCESS_LISTENER_ERROR',
            category: 'lifecycle',
            visibility: 'default',
            causesSystemFlow: false,
            service: 'pcm-core-ui',
            error: err
        });
    });

    process.on('SIGTERM', () => {
        logger.warn('SIGTERM signal received: closing HTTP servers', {
            type: 'PROCESS_SIGNAL',
            category: 'lifecycle',
            visibility: 'diagnostic',
            causesSystemFlow: false,
            signal: 'SIGTERM'
        });
        stopWatchingRuntime();
        const closePromises = [
            apiServerManager.close(),
            new Promise(resolve => metadataServer.close(resolve)),
            new Promise(resolve => uiServer.close(resolve))
        ];
        Promise.all(closePromises).then(() => {
            logger.info('HTTP servers closed', {
                type: 'PROCESS_SHUTDOWN_COMPLETE',
                category: 'lifecycle',
                visibility: 'diagnostic',
                causesSystemFlow: false
            });
            process.exit(0);
        });
    });
}).catch(err => {
    logger.error(`PCM bootstrap failed: ${err.message}`, {
        type: 'PROCESS_STARTUP_FAILED',
        category: 'lifecycle',
        visibility: 'default',
        causesSystemFlow: false,
        service: 'pcm-core',
        error: err
    });
    process.exit(1);
});

}

module.exports = { createApiApp, createMetadataApp, createUiApp, normalizeLogEntry, expandLogEntry };
