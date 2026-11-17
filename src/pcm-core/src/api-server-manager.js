/**
 * Reloadable HTTPS listener for PCM API TLS/mTLS settings.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

function readHttpsOptions(certsDir, clientAuthMode) {
    return {
        key: fs.readFileSync(path.join(certsDir, 'pcm-core.key')),
        cert: fs.readFileSync(path.join(certsDir, 'pcm-core.crt')),
        ca: fs.readFileSync(path.join(certsDir, 'rootCA.crt')),
        requestCert: true,
        // TLS must complete for certificate-free browser authorization. The API app
        // enforces authorized socket certificates before every backend dispatch.
        rejectUnauthorized: false
    };
}

function readMetadataHttpsOptions(certsDir, clientAuthMode = 'tls') {
    return { ...readHttpsOptions(certsDir, clientAuthMode), rejectUnauthorized: clientAuthMode === 'mtls' };
}

/** Compare TLS material and client-auth policy before disrupting an active listener. */
function sameHttpsOptions(current, next) {
    return Boolean(current && next) && ['key', 'cert', 'ca', 'requestCert', 'rejectUnauthorized'].every(name =>
        Buffer.isBuffer(current[name]) && Buffer.isBuffer(next[name])
            ? current[name].equals(next[name])
            : current[name] === next[name]);
}

function createApiServerManager({ app, port, certsDir, getClientAuthMode, logger = console }) {
    let server = null;
    let currentMode = null;
    let currentOptions = null;
    let reloadChain = Promise.resolve();

    const start = () => new Promise((resolve, reject) => {
        currentMode = getClientAuthMode();
        currentOptions = readHttpsOptions(certsDir, currentMode);
        server = https.createServer(currentOptions, app);
        server.once('error', reject);
        server.on('error', err => {
            logger.error?.(`PCM API listener error: ${err.message}`, {
                type: 'PROCESS_LISTENER_ERROR',
                category: 'lifecycle',
                visibility: 'default',
                causesSystemFlow: false,
                service: 'pcm-core-api',
                error: err
            });
        });
        server.listen(port, () => {
            server.off('error', reject);
            console.log(`PCM Core running on HTTPS port ${port} with PCM_API_CLIENT_AUTH_MODE=${currentMode}`);
            resolve();
        });
    });

    const close = () => new Promise(resolve => {
        if (!server) return resolve();
        server.close(() => {
            server = null;
            resolve();
        });
    });

    const reload = reason => {
        reloadChain = reloadChain.then(async () => {
            // Inventory/bootstrap and other non-TLS changes must not reset live OAuth connections.
            if (currentMode === getClientAuthMode() && sameHttpsOptions(currentOptions, readHttpsOptions(certsDir, getClientAuthMode()))) return;
            logger.info?.(`Reloading PCM API listener (${reason || 'runtime change'})`, {
                type: 'PROCESS_RELOAD',
                category: 'lifecycle',
                visibility: 'diagnostic',
                causesSystemFlow: false,
                service: 'pcm-core-api',
                reason: reason || 'runtime change'
            });
            await close();
            await start();
        }).catch(err => {
            logger.error?.(`PCM API listener reload failed: ${err.message}`, {
                type: 'PROCESS_RELOAD_FAILED',
                category: 'lifecycle',
                visibility: 'default',
                causesSystemFlow: false,
                service: 'pcm-core-api',
                reason: reason || 'runtime change',
                error: err
            });
        });
        return reloadChain;
    };

    return {
        start,
        close,
        reload,
        getCurrentMode: () => currentMode,
        getCurrentOptions: () => currentOptions,
        getServer: () => server
    };
}

module.exports = {
    createApiServerManager,
    sameHttpsOptions,
    readHttpsOptions,
    readMetadataHttpsOptions
};
