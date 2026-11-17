'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const { readHttpsOptions, readMetadataHttpsOptions } = require('../../src/pcm-core/src/api-server-manager');

const repoRoot = path.resolve(__dirname, '..', '..');
const certsDir = require('../../test-support/certificates').certificates();
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const PUBLIC_MATRIX = Object.freeze([
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/r4/.well-known/smart-configuration'],
    ['GET', '/r4/metadata'],
    ['GET', '/authorize'],
    ['POST', '/authorize/decision'],
    ['POST', '/token'],
    ['POST', '/introspect'],
    ['GET', '/r4/Organization'],
    ['POST', '/r4/Organization'],
    ['POST', '/r4/Organization/_search'],
    ['GET', '/r4/Organization/example'],
    ['HEAD', '/r4/Organization/example'],
    ['PUT', '/r4/Organization/example'],
    ['GET', '/r4/Endpoint'],
    ['POST', '/r4/Endpoint'],
    ['POST', '/r4/Endpoint/_search'],
    ['GET', '/r4/Endpoint/example'],
    ['HEAD', '/r4/Endpoint/example'],
    ['PUT', '/r4/Endpoint/example'],
    ['GET', '/r4/HealthcareService'],
    ['POST', '/r4/HealthcareService'],
    ['POST', '/r4/HealthcareService/_search'],
    ['GET', '/r4/HealthcareService/example'],
    ['HEAD', '/r4/HealthcareService/example'],
    ['PUT', '/r4/HealthcareService/example'],
    ['POST', '/r4/HealthcareService/example/$request-catalog-update'],
    ['GET', '/r4/Consent'],
    ['POST', '/r4/Consent'],
    ['POST', '/r4/Consent/_search'],
    ['GET', '/r4/Consent/example'],
    ['HEAD', '/r4/Consent/example'],
    ['PUT', '/r4/Consent/example']
]);

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

function request(port, method, requestPath, identity = null, protocol = 'https') {
    return new Promise((resolve, reject) => {
        const client = protocol === 'https' ? https : http;
        const req = client.request({
            host: '127.0.0.1',
            port,
            path: requestPath,
            method,
            ...(protocol === 'https' ? {
                ca: fs.readFileSync(path.join(certsDir, 'rootCA.crt')),
                ...(identity ? {
                    cert: fs.readFileSync(identity.cert),
                    key: fs.readFileSync(identity.key)
                } : {})
            } : {})
        }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        req.once('error', reject);
        req.end();
    });
}

function assertTransportFailure(promise) {
    return assert.rejects(promise, error => {
        assert.match(error.code || error.message, /ECONNRESET|EPIPE|ERR_SSL|CERT|TLS|socket/i);
        return true;
    });
}

function generateExpiredClient(tmp) {
    const key = path.join(tmp, 'expired.key');
    const csr = path.join(tmp, 'expired.csr');
    const cert = path.join(tmp, 'expired.crt');
    // OpenSSL 3.5 rejects negative certificate durations. Explicit, ordered
    // past validity dates create a genuinely expired leaf on old and new toolchains.
    const caConfig = path.join(tmp, 'expired-ca.cnf');
    fs.writeFileSync(path.join(tmp, 'index.txt'), '');
    fs.writeFileSync(path.join(tmp, 'serial'), '232B\n');
    fs.writeFileSync(caConfig, `[ca]
    default_ca = expired_fixture
    [expired_fixture]
    database = "${path.join(tmp, 'index.txt')}"
    new_certs_dir = "${tmp}"
    serial = "${path.join(tmp, 'serial')}"
    default_md = sha256
    policy = expired_policy
    [expired_policy]
    commonName = supplied
    `);
    const commands = [
        ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=expired-client'],
        ['ca', '-batch', '-notext', '-config', caConfig, '-in', csr,
            '-cert', path.join(certsDir, 'rootCA.crt'), '-keyfile', path.join(certsDir, 'rootCA.key'),
            '-startdate', '20200101000000Z', '-enddate', '20200102000000Z', '-out', cert]
    ];
    for (const args of commands) {
        const result = spawnSync('openssl', args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    return { cert, key };
}

test('strict TLS boundary rejects missing, untrusted, and expired client certificates as transport failures', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-expired-mtls-'));
    const server = https.createServer(readMetadataHttpsOptions(certsDir, 'mtls'), (_req, res) => res.writeHead(204).end());
    const port = await listen(server);
    try {
        const untrusted = {
            cert: path.join(certsDir, 'untrusted-client.crt'),
            key: path.join(certsDir, 'untrusted-client.key')
        };
        await assertTransportFailure(request(port, 'GET', '/r4/metadata'));
        await assertTransportFailure(request(port, 'GET', '/r4/metadata', untrusted));
        await assertTransportFailure(request(port, 'GET', '/r4/metadata', generateExpiredClient(tmp)));
    } finally {
        await close(server);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('valid trusted certificate is required across the complete PCM public route matrix', async () => {
    const reached = [];
    const server = https.createServer(readMetadataHttpsOptions(certsDir, 'mtls'), (req, res) => {
        reached.push([req.method, req.url]);
        res.writeHead(204).end();
    });
    const port = await listen(server);
    const trusted = {
        cert: path.join(certsDir, 'sp-client.crt'),
        key: path.join(certsDir, 'sp-client.key')
    };
    try {
        for (const [method, requestPath] of PUBLIC_MATRIX) {
            await assertTransportFailure(request(port, method, requestPath));
            assert.equal(await request(port, method, requestPath, trusted), 204);
        }
        assert.deepEqual(reached, PUBLIC_MATRIX);
    } finally {
        await close(server);
    }
});

test('connectathon transport matrix supports bounded HTTP, TLS, and local mTLS selections', async () => {
    const handler = (_req, res) => res.writeHead(204).end();
    const plain = http.createServer(handler);
    const tls = https.createServer(readHttpsOptions(certsDir, 'tls'), handler);
    const mtls = https.createServer(readMetadataHttpsOptions(certsDir, 'mtls'), handler);
    const servers = [plain, tls, mtls];
    const ports = await Promise.all(servers.map(listen));
    const trusted = { cert: path.join(certsDir, 'sp-client.crt'), key: path.join(certsDir, 'sp-client.key') };
    try {
        assert.equal(await request(ports[0], 'GET', '/healthz', null, 'http'), 204);
        assert.equal(await request(ports[1], 'GET', '/metadata'), 204);
        await assertTransportFailure(request(ports[2], 'GET', '/metadata'));
        assert.equal(await request(ports[2], 'GET', '/metadata', trusted), 204);
    } finally {
        await Promise.all(servers.map(close));
    }
});

test('application mTLS defense ignores spoofed certificate headers and exposes verified socket identity only', () => {
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousLogDir = process.env.LOG_DIR;
    const logDir = fs.mkdtempSync(path.join(tmpRoot, 'pcm-public-mtls-logs-'));
    const generated = spawnSync(process.execPath, ['pcm-connectathon/scripts/create-team.js',
        '--team-id', 'team-test', '--teams-root', logDir, '--mode', 'strict'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const configPath = path.join(logDir, 'team-test', 'team-config.json');
    process.env.TEAM_CONFIG_PATH = configPath;
    process.env.LOG_DIR = logDir;
    delete require.cache[require.resolve('../../src/pcm-core/src/team-config')];
    delete require.cache[require.resolve('../../src/pcm-core/src/public-mtls')];
    const { createPublicMtlsMiddleware } = require('../../src/pcm-core/src/public-mtls');
    const middleware = createPublicMtlsMiddleware({ kind: 'oauth' });
    let nextCalls = 0;
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    const spoofedRequest = {
        headers: {
            'x-forwarded-client-cert': 'trusted=true;thumbprint=fake',
            'x-ssl-client-verify': 'SUCCESS'
        },
        socket: { encrypted: true, authorized: false, authorizationError: 'CERT_UNTRUSTED', getPeerCertificate: () => ({}) }
    };
    middleware(spoofedRequest, response, () => { nextCalls += 1; });
    assert.equal(response.statusCode, 401);
    assert.equal(nextCalls, 0);
    assert.equal(spoofedRequest.mtls, undefined);

    const trustedRequest = {
        headers: {},
        socket: {
            encrypted: true,
            authorized: true,
            getPeerCertificate: () => ({ raw: Buffer.from('trusted-cert'), subject: { CN: 'trusted' } })
        }
    };
    middleware(trustedRequest, response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal(trustedRequest.mtls.source, 'direct-tls');
    assert.match(trustedRequest.mtls.thumbprint, /^[A-Za-z0-9_-]{43}$/);

    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    delete require.cache[require.resolve('../../src/pcm-core/src/team-config')];
    delete require.cache[require.resolve('../../src/pcm-core/src/public-mtls')];
    fs.rmSync(logDir, { recursive: true, force: true });
});

test('trusted transport with the wrong endpoint role is denied before protected operation execution', () => {
    const { createRequiredScopeMiddleware } = require('../../src/pcm-core/src/oauth-role');
    let protectedExecutions = 0;
    const requestWithTrustedTransport = {
        mtls: { thumbprint: 'trusted-wrong-role' },
        user: { scope: 'system/*.crus' }
    };
    const roleBoundary = createRequiredScopeMiddleware('introspection');
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    roleBoundary(requestWithTrustedTransport, response, () => { protectedExecutions += 1; });
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error_description, /introspection/);
    assert.equal(protectedExecutions, 0);
});

test('UI listener source contains no duplicate public PCM contract route', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'pcm-core', 'src', 'index.js'), 'utf8');
    const uiSource = source.slice(source.indexOf('const createUiApp'), source.indexOf('const bootstrap'));
    for (const route of ['oauth-authorization-server', 'smart-configuration', '/metadata', '/authorize', '/token', '/introspect', '/r4']) {
        assert.doesNotMatch(uiSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('AWS source preserves end-to-end TLS for PCM public listeners and isolates browser listeners', () => {
    const loadBalancers = fs.readFileSync(
        path.join(repoRoot, 'pcm-connectathon', 'aws', 'terraform', 'team', 'load-balancers.tf'),
        'utf8'
    );
    const securityGroups = fs.readFileSync(
        path.join(repoRoot, 'pcm-connectathon', 'aws', 'terraform', 'baseline', 'security-groups.tf'),
        'utf8'
    );
    const resourceBlock = (kind, name) => {
        const start = loadBalancers.indexOf(`resource "${kind}" "${name}"`);
        assert.notEqual(start, -1, `missing ${kind}.${name}`);
        const next = loadBalancers.indexOf('\nresource "', start + 1);
        return loadBalancers.slice(start, next === -1 ? undefined : next);
    };

    for (const name of ['pcm_api', 'pcm_metadata']) {
        assert.match(resourceBlock('aws_lb_target_group', name), /protocol\s*=\s*"TCP"/);
        assert.match(resourceBlock('aws_lb_listener', name), /protocol\s*=\s*"TCP"/);
        assert.doesNotMatch(resourceBlock('aws_lb_listener', name), /certificate_arn|ssl_policy/i);
    }
    for (const name of ['sp_client', 'pcm_ui']) {
        assert.match(resourceBlock('aws_lb_target_group', name), /protocol\s*=\s*"HTTP"/);
        assert.match(resourceBlock('aws_lb_listener', name), /protocol\s*=\s*"HTTP"/);
    }
    assert.match(securityGroups, /from_port\s*=\s*3001[\s\S]*to_port\s*=\s*3002/);
});

test('workflow browser script is an exact GET exception and cannot open backend or arbitrary asset paths', () => {
    const { isBrowserAuthorizationRequest } = require('../../src/pcm-core/src/public-mtls');
    assert.equal(isBrowserAuthorizationRequest({ method: 'GET', originalUrl: '/assets/system-authentication.js?v=1' }), true);
    for (const [method, originalUrl] of [['POST', '/assets/system-authentication.js'], ['GET', '/assets/system-authentication.js/extra'], ['GET', '/assets/server-secret.key'], ['POST', '/api/fhir-service/r4/token'], ['GET', '/sandbox/authentication/not-an-action']]) {
        assert.equal(isBrowserAuthorizationRequest({ method, originalUrl }), false, `${method} ${originalUrl}`);
    }
});
