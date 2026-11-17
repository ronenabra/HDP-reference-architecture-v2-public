'use strict';

/** Always-on protection for AWS metadata and container credential endpoints. */

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const BLOCKED_HOSTS = new Set([
    '169.254.169.254',
    '169.254.170.2',
    'fd00:ec2::254'
]);

function normalizeIpv4Integer(hostname) {
    if (!/^\d+$/.test(hostname)) return null;
    const value = Number(hostname);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) return null;
    return [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255].join('.');
}

function normalizedHostname(hostname) {
    let value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (net.isIP(value) === 6) {
        value = new URL(`http://[${value}]/`).hostname.slice(1, -1);
        const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(value);
        if (mapped) {
            const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
            return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
        }
    }
    return normalizeIpv4Integer(value) || value;
}

function isAwsCredentialAddress(hostname, env = process.env) {
    const host = normalizedHostname(hostname);
    if (BLOCKED_HOSTS.has(host)) return true;
    if (host.startsWith('::ffff:') && BLOCKED_HOSTS.has(host.slice('::ffff:'.length))) return true;
    for (const name of ['AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI']) {
        const raw = env[name];
        if (!raw) continue;
        try {
            const candidate = new URL(raw, 'http://169.254.170.2');
            if (normalizedHostname(candidate.hostname) === host) return true;
        } catch (_) { /* Invalid credential environment is never allowlisted. */ }
    }
    return false;
}

function parseOutboundUrl(value) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new TypeError('outbound destination must be an absolute URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('outbound destination must use HTTP or HTTPS');
    if (parsed.username || parsed.password) throw new TypeError('outbound destination userinfo is prohibited');
    if (isAwsCredentialAddress(parsed.hostname)) throw new TypeError('AWS metadata and credential destinations are prohibited');
    return parsed;
}

async function assertSafeOutboundUrl(value, options = {}) {
    const parsed = parseOutboundUrl(value);
    const lookup = options.lookup || dns.lookup;
    if (net.isIP(normalizedHostname(parsed.hostname))) return parsed;
    const resolved = await lookup(parsed.hostname, { all: true, verbatim: true });
    for (const address of resolved || []) {
        if (isAwsCredentialAddress(address.address)) throw new TypeError('outbound destination resolves to an AWS credential address');
    }
    return parsed;
}

/** Resolve once at socket creation; reject the entire answer set if any address is forbidden. */
function safeLookup(lookup = dns.lookup) {
    return (hostname, options, callback) => {
        Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })).then(answers => {
            if (!answers?.length) throw new Error('outbound DNS returned no addresses');
            if (isAwsCredentialAddress(hostname) || answers.some(item => isAwsCredentialAddress(item.address))) {
                throw new TypeError('outbound destination resolves to an AWS credential address');
            }
            const selected = options.family ? answers.filter(item => item.family === options.family) : answers;
            if (!selected.length) throw new Error('outbound DNS returned no matching address family');
            if (options.all) callback(null, selected);
            else callback(null, selected[0].address, selected[0].family);
        }).catch(callback);
    };
}

/** Reject malformed responses and callback failures through the request error channel. */
const guardedAxiosTransport = {
    /**
     * Open a native request and keep response normalization inside its error boundary.
     * @param {object} options Native HTTP/TLS request options selected by Axios.
     * @param {Function} onResponse Axios response normalization callback.
     * @returns {http.ClientRequest} Request emitting errors for rejected responses.
     */
    request(options, onResponse) {
        const client = options.protocol === 'https:' ? https : http;
        const request = client.request(options, response => {
            try {
                // Node 18 accepts empty header names which Axios cannot normalize.
                // A response parser failure must not escape as an uncaught exception.
                for (const name of Object.keys(response.headers)) http.validateHeaderName(name);
                onResponse(response);
            } catch (error) {
                request.destroy(error);
                response.destroy();
            }
        });
        return request;
    }
};

/** Direct agents preserve TLS settings and disable environmental proxy/redirect bypasses. */
function guardedAxiosConfig(config = {}) {
    if (config.url) parseOutboundUrl(new URL(config.url, config.baseURL).toString());
    return {
        ...config, proxy: false, maxRedirects: 0, transport: guardedAxiosTransport,
        httpAgent: new http.Agent({ ...config.httpAgent?.options, lookup: safeLookup() }),
        httpsAgent: new https.Agent({ ...config.httpsAgent?.options, lookup: safeLookup() })
    };
}

/** Buffered JSON/FHIR transport using Node's actual guarded socket resolver. */
function directFetch(value, init, options) {
    const url = parseOutboundUrl(value);
    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.request(url, {
            method: init.method || 'GET', headers: init.headers, signal: init.signal,
            ...options.tls, agent: false, lookup: safeLookup(options.lookup)
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
                if (waitTimer) clearTimeout(waitTimer);
                const body = ['HEAD'].includes(init.method) || [204, 205, 304].includes(response.statusCode)
                    ? null : Buffer.concat(chunks);
                resolve(new Response(body, { status: response.statusCode, headers: response.headers }));
            });
        });
        let waitTimer;
        let uploadTimer;
        if (options.stageTimeouts?.connectUploadMs) {
            uploadTimer = setTimeout(() => request.destroy(Object.assign(new Error('private HAPI connect/upload exceeded deadline'), {
                clinicalFailureStage: 'connect-upload', clinicalDeadlineMs: options.stageTimeouts.connectUploadMs
            })), options.stageTimeouts.connectUploadMs);
            request.on('finish', () => {
                clearTimeout(uploadTimer);
                waitTimer = setTimeout(() => request.destroy(Object.assign(new Error('HAPI transaction response exceeded deadline'), {
                    clinicalFailureStage: 'hapi-transaction-wait', clinicalDeadlineMs: options.stageTimeouts.transactionWaitMs
                })), options.stageTimeouts.transactionWaitMs);
            });
        }
        request.on('close', () => { if (uploadTimer) clearTimeout(uploadTimer); if (waitTimer) clearTimeout(waitTimer); });
        request.on('error', reject);
        request.end(init.body);
    });
}

/** Reject redirects by default; explicit read-only redirects remain same-origin and guarded. */
async function guardedFetch(value, init = {}, options = {}) {
    const maxRedirects = options.maxRedirects ?? 0;
    let current = String(value);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        parseOutboundUrl(current);
        // Injected clients are for tests; production always uses the guarded socket path.
        if (options.fetchImpl) await assertSafeOutboundUrl(current, options);
        const response = options.fetchImpl
            ? await options.fetchImpl(current, { ...init, redirect: 'manual' })
            : await directFetch(current, init, options);
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (!location) throw new TypeError('redirect response omitted Location');
        const next = parseOutboundUrl(new URL(location, current).toString());
        if (hop === maxRedirects || !['GET', 'HEAD'].includes(init.method || 'GET')
            || next.origin !== new URL(current).origin) throw new TypeError('outbound redirect prohibited');
        current = next.toString();
    }
    throw new TypeError('outbound destination exceeded the redirect limit');
}

module.exports = {
    BLOCKED_HOSTS, assertSafeOutboundUrl, guardedFetch, guardedAxiosConfig,
    safeLookup, isAwsCredentialAddress, normalizedHostname, parseOutboundUrl
};
