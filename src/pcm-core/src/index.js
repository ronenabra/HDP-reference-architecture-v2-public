/**
 * PCM Core server entrypoint (API + UI).
 */
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fhirRoutes = require('./routes/fhir');
const authRoutes = require('./routes/auth');
const uiRoutes = require('./routes/ui');

const logger = require('./logger');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const UI_PORT = 3001;

/**
 * Read and tag log entries for a component.
 * @param {string} dirName
 * @param {string} componentLabel
 * @returns {object[]}
 */
const readComponentLogs = (dirName, componentLabel) => {
    const logFile = path.join(process.cwd(), 'shared-logs', dirName, 'current.log');
    if (fs.existsSync(logFile)) {
        try {
            const content = fs.readFileSync(logFile, 'utf8');
            return content.trim().split('\n').map(line => {
                try {
                    const parsed = JSON.parse(line);
                    parsed.component = componentLabel; // Tag with component
                    return parsed;
                } catch (e) { return null; }
            }).filter(l => l);
        } catch (err) { return []; }
    }
    return [];
};

/**
 * Build the HTTPS API app (OAuth2 + FHIR).
 * @returns {import('express').Express}
 */
const createApiApp = () => {
    const app = express();

    app.use(bodyParser.json({ type: ['application/json', 'application/fhir+json'] }));
    app.use(bodyParser.urlencoded({ extended: true }));

    app.use(logger.requestLogger);

    app.use('/', authRoutes);      // /token, /introspect
    app.use('/r4', fhirRoutes);    // /r4/*

    return app;
};

/**
 * Build the HTTP UI app (dashboard, logs, docs).
 * @returns {import('express').Express}
 */
const createUiApp = () => {
    const app = express();

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(logger.requestLogger);

    app.get('/logs-view', (req, res) => {
        res.render('logs', { serviceName: 'PCM Core' });
    });

    app.get('/api/unified-logs', (req, res) => {
        const components = [
            { dir: 'pcm-core', label: 'PCM Core' },
            { dir: 'sp-client', label: 'Doctor App' },
            { dir: 'ds-auth-adapter', label: 'DS Auth Adapter' },
            { dir: 'ds-fhir-server', label: 'DS FHIR' }
        ];

        let allLogs = [];
        components.forEach(c => {
            allLogs = allLogs.concat(readComponentLogs(c.dir, c.label));
        });

        allLogs.sort((a, b) => {
            if (a.tick && b.tick) {
                if (b.tick.length !== a.tick.length) return b.tick.length - a.tick.length;
                return b.tick.localeCompare(a.tick);
            }
            return new Date(b.timestamp) - new Date(a.timestamp);
        });

        res.json(allLogs);
    });

    app.get('/api/logs', (req, res) => {
        const logs = readComponentLogs('pcm-core', 'PCM Core');
        res.json(logs.reverse());
    });

    app.get('/docs/api', (req, res) => {
        res.sendFile('/app/api-docs.html');
    });

    app.use('/', uiRoutes);

    app.get('/', (req, res) => {
        res.redirect('/ui');
    });

    return app;
};

const bootstrap = require('./bootstrap');

bootstrap().then(() => {
    const https = require('https');
    const http = require('http');

    const apiApp = createApiApp();
    const uiApp = createUiApp();

    const httpsOptions = {
        key: fs.readFileSync('/app/certs/pcm-core.key'),
        cert: fs.readFileSync('/app/certs/pcm-core.crt'),
        ca: fs.readFileSync('/app/certs/rootCA.crt'),
        requestCert: true,
        rejectUnauthorized: true
    };

    const apiServer = https.createServer(httpsOptions, apiApp).listen(PORT, () => {
        console.log(`PCM Core running on HTTPS port ${PORT} with mTLS enabled`);
    });

    const uiServer = http.createServer(uiApp).listen(UI_PORT, () => {
        console.log(`PCM Core UI running on HTTP port ${UI_PORT}`);
    });

    process.on('SIGTERM', () => {
        console.log('SIGTERM signal received: closing HTTP servers');
        const closePromises = [
            new Promise(resolve => apiServer.close(resolve)),
            new Promise(resolve => uiServer.close(resolve))
        ];
        Promise.all(closePromises).then(() => {
            console.log('HTTP servers closed');
            process.exit(0);
        });
    });
});
