'use strict';

/** Connection-guarded local sanity transport with explicit UI redirect handling. */
const http = require('http');
const https = require('https');
const { sharedModuleRoot } = require('./lib');
const { safeLookup, parseOutboundUrl } = require(require('path').join(sharedModuleRoot(), 'outbound-destination'));

/**
 * Run a guarded HTTP(S) request; isolate each TLS probe from pooled sessions.
 * @param {string} method
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<object>}
 */
function request(method, url, options = {}) {
    return new Promise(resolve => {
        let settled = false;
        let deadline;
        const finish = value => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
        let parsed;
        try { parsed = parseOutboundUrl(url); } catch (error) { finish({ error: error.message, durationMs: 0 }); return; }
        const client = parsed.protocol === 'https:' ? https : http;
        let body = null;
        const headers = { ...(options.headers || {}) };
        const startedAt = Date.now();

        if (options.json) {
            body = JSON.stringify(options.json);
            headers['Content-Type'] = 'application/json';
            headers.Accept = headers.Accept || 'application/json';
        } else if (options.form) {
            body = new URLSearchParams(options.form).toString();
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        if (body) headers['Content-Length'] = Buffer.byteLength(body);

        const req = client.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers,
            agent: false,
            lookup: safeLookup(),
            cert: options.tls?.cert,
            key: options.tls?.key,
            ca: options.tls?.ca,
            rejectUnauthorized: options.tls?.rejectUnauthorized ?? false,
            timeout: options.timeout || 10000
        }, res => {
            const chunks = [];
            let bytes = 0;
            res.on('error', () => finish({ error: 'response interrupted', durationMs: Date.now() - startedAt }));
            res.on('data', chunk => {
                bytes += chunk.length;
                if (options.maxResponseBytes && bytes > options.maxResponseBytes) {
                    finish({ error: 'response byte limit exceeded', durationMs: Date.now() - startedAt });
                    res.destroy(); req.destroy();
                } else chunks.push(chunk);
            });
            res.on('end', async () => {
                if (settled) return;
                const raw = Buffer.concat(chunks).toString('utf8');
                const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);
                if (isRedirect && options.prohibitRedirects) {
                    finish({ error: 'outbound redirect prohibited', durationMs: Date.now() - startedAt });
                    return;
                }
                if (isRedirect && res.headers.location && (options.redirects || 0) < 5) {
                    const redirectUrl = new URL(res.headers.location, parsed).toString();
                    if (new URL(redirectUrl).origin !== parsed.origin || (!['GET', 'HEAD'].includes(method) && !options.followUiRedirects)) {
                        finish({ error: 'outbound redirect prohibited', durationMs: Date.now() - startedAt });
                        return;
                    }
                    const redirectMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && [301, 302, 303].includes(res.statusCode) ? 'GET' : method;
                    return finish(await request(redirectMethod, redirectUrl, { ...options, form: null, json: null, redirects: (options.redirects || 0) + 1 }));
                }
                let json = null;
                try { json = JSON.parse(raw); } catch (err) { /* HTML/form responses are expected. */ }
                finish({ statusCode: res.statusCode, headers: res.headers, body: raw, json, durationMs: Date.now() - startedAt });
            });
        });

        req.on('error', error => finish({ error: error.message, durationMs: Date.now() - startedAt }));
        req.on('timeout', () => {
            req.destroy();
            finish({ error: 'timeout', durationMs: Date.now() - startedAt });
        });
        deadline = setTimeout(() => {
            finish({ error: 'timeout', durationMs: Date.now() - startedAt }); req.destroy();
        }, options.timeout || 10000);
        if (body) req.write(body);
        req.end();
    });
}

/** Select the active default source without overriding an explicitly supplied target. */
function referenceDataSourceUrl(config, override) {
    if (override) return override;
    if (config.legacyDataSource?.enabled === false) {
        const ho = config.healthOrganizations?.[0];
        return config.publicBaseUrls?.healthOrganizations?.[ho?.id] || ho?.endpoint;
    }
    return config.publicBaseUrls?.referenceDataSource;
}

/** A shared browser listener may deny backend mTLS at HTTP after the TLS handshake. */
function backendMtlsDenied(result) {
    return Boolean(result.error) || [401, 403].includes(result.statusCode);
}
module.exports = { request, referenceDataSourceUrl, backendMtlsDenied };
