'use strict';
/** Owned real HTTPS OAuth/FHIR and Admin UI listeners for service tests; no retained team access. */
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');

/** Start real certificate-authenticated PCM routes and return their owned state/evidence. */
async function startServicesFixture(preset = 'connectathon-mtls', { templateLoader, browserBase = '', apiMiddleware } = {}) {
    const config = require('./team-config').installTestRuntime({ conformance: { preset } });
    const certificateDirectory = require('./certificates').certificates();
    fs.cpSync(certificateDirectory, process.env.CERTS_DIR, { recursive: true });
    const previousPassword = process.env.TEAM_ADMIN_PASSWORD;
    const password = require('node:crypto').randomBytes(24).toString('hex');
    process.env.TEAM_ADMIN_PASSWORD = password;
    const store = require('../src/pcm-core/src/fhir/store');
    store.clear();
    const { tokens } = require('../src/pcm-core/src/store'); tokens.clear();
    const requests = [], events = [];
    const express = require('express'), api = express();
    api.use((req, res, next) => {
        res.on('finish', () => requests.push({ method: req.method, path: req.path, status: res.statusCode,
            body: /\/(?:HealthcareService|Consent)(?:\/|$)/.test(req.path) && req.body ? structuredClone(req.body) : null, organization: req.user?.organization_id || null, certificate: req.socket.getPeerCertificate()?.fingerprint256 || null }));
        next();
    });
    if (apiMiddleware) api.use(apiMiddleware);
    api.use(require('../src/pcm-core/src/index').createApiApp());
    const apiServer = https.createServer({ key: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.key')), cert: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.crt')),
        ca: fs.readFileSync(path.join(process.env.CERTS_DIR, 'rootCA.crt')), requestCert: true, rejectUnauthorized: false }, api);
    await new Promise(resolve => apiServer.listen(0, '0.0.0.0', resolve));
    config.internalBaseUrls.pcmAuth = `https://localhost:${apiServer.address().port}/api/fhir-service/r4`;
    config.internalBaseUrls.pcmFhir = config.internalBaseUrls.pcmAuth;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    await require('../src/pcm-core/src/bootstrap')();
    const app = express();
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../src/pcm-core/src/views'));
    app.use(express.json()); app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => { res.locals.browserBase = browserBase; next(); });
    app.use(browserBase + '/assets', express.static(path.resolve(__dirname, '../src/shared/ui')));
    app.use(browserBase + '/admin/services', (req, res, next) => req.get('x-admin-password') === password || (req.headers.cookie || '').includes('ownedServicesLogin=yes') ? next() : res.status(401).json({ error: 'Admin login required' }));
    app.use(browserBase + '/admin/services', require('../src/pcm-core/src/routes/services').servicesRouter({ store, getConfig: () => config, tokenStore: tokens, templateLoader: () => templateLoader ? templateLoader() : require('../src/pcm-core/src/service-templates').loadTemplates(), audit: event => events.push(event) }));
    const uiServer = await new Promise(resolve => { const server = app.listen(0, '0.0.0.0', () => resolve(server)); });
    return { config, store, tokens, requests, events, password,
        /** Override only this disposable UI fixture’s config reader; never edit maintained config. */
        setTemplateLoader(loader) { templateLoader = loader; }, base: `http://127.0.0.1:${uiServer.address().port}${browserBase}`,
        async close() {
            for (const server of [apiServer, uiServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
            tokens.clear(); store.clear();
            if (previousPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previousPassword;
        } };
}
module.exports = { startServicesFixture };
