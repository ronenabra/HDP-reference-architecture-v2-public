'use strict';

/** Doctor local logs, stable selection and separately signed negative identities. */
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const client = require('../src/client');
const logger = require('../src/logger');
const { app } = require('../src/index');
const { getIdentities } = require('../src/identities');

/** Invoke the read-only log handler independently of request logging side effects. */
function readLogs() {
    const handler = app._router.stack.find(layer => layer.route?.path === '/api/logs').route.stack[0].handle;
    const result = { status: 200, headers: {} };
    handler({}, { set(name, value) { result.headers[name] = value; return this; },
        status(value) { result.status = value; return this; }, json(value) { result.body = value; } });
    return result;
}

test('Doctor reads the logger configured location and distinguishes missing, empty and unreadable logs', () => {
    const filename = logger.getLogPath();
    assert.equal(filename, path.join(process.env.LOG_DIR, 'current.log'));
    fs.rmSync(filename, { force: true });
    assert.equal(readLogs().headers['X-Log-State'], 'missing');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, '');
    assert.equal(readLogs().headers['X-Log-State'], 'empty');
    logger.info('doctor diagnostic test <script>literal</script>', { type: 'DOCTOR_TEST', raw: '<b>preserve</b>' });
    const result = readLogs();
    assert.equal(result.headers['X-Log-State'], 'available');
    assert.equal(result.body[0].details.raw, '<b>preserve</b>');
    fs.unlinkSync(filename);
    fs.mkdirSync(filename);
    assert.equal(readLogs().status, 503);
    fs.rmdirSync(filename);
});

test('management selector renders labels and stable IDs for every offered identity', () => {
    const ejs = require('ejs');
    const view = fs.readFileSync(path.join(__dirname, '../src/views/manage.ejs'), 'utf8');
    for (const selected of getIdentities()) {
        const html = ejs.render(view, { identity: selected.id, currentIdentity: selected.id,
            identities: getIdentities(), publicBaseUrls: config.publicBaseUrls, teamId: config.teamId, orgs: [], endpoints: [], flash: null });
        assert.ok(html.includes(`value="${selected.id}" selected`));
        assert.ok(html.includes(ejs.escapeXML(selected.label)));
        assert.ok(!html.includes('[object Object]'));
    }
});

test('library shell receives configured application, browser destinations and actual effective warnings without participant reads', () => {
    const handler = app._router.stack.find(layer => layer.route?.path === '/patients').route.stack[0].handle;
    for (const identity of getIdentities()) {
        let rendered;
        handler({ query: { identity: identity.id }, headers: { host: 'doctor.example' }, protocol: 'https' },
            { render(view, locals) { rendered = { view, locals }; } });
        assert.equal(rendered.view, 'patients');
        assert.equal(rendered.locals.applicationLabel, identity.label);
        assert.equal(rendered.locals.identity, identity.id);
        assert.equal(rendered.locals.conformance.resultLabel, client.getConformanceInfo().resultLabel);
        assert.equal(rendered.locals.sandboxNotice.sources.length, config.healthOrganizations.filter(source => source.enabled !== false).length);
        assert.equal(typeof rendered.locals.publicBaseUrls.pcmUi, 'string');
        assert.equal(rendered.locals.state.state, 'unloaded');
        assert.equal(rendered.locals.fixed.length, 3);
    }
});

test('unknown route identities fail before dispatch to a participant', async t => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/?identity=unknown', '/manage?identity=%5Bobject%20Object%5D', '/smart/start?identity=unknown']) {
        assert.equal((await fetch(`${base}${route}`)).status, 400);
    }
    assert.equal((await fetch(`${base}/create-consent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: 'unknown' }) })).status, 400);
    assert.throws(() => client._test.generateClientAssertion('unknown', null, 'https://pcm.example/token'), /Unknown Doctor identity/);
});

test('negative identities use a valid independent P-256 assertion, never the RSA transport key', () => {
    const filename = path.join(process.env.CERTS_DIR, 'untrusted-client-assertion.key');
    assert.throws(() => client._test.generateClientAssertion('untrusted', null, 'https://pcm.example/token'), /P-256 assertion key is missing/);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(filename, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const certs = require('../../../test-support/certificates').certificates();
    for (const name of ['rootCA.crt', 'untrusted-client.crt', 'untrusted-client.key', 'sp-client-assertion.crt', 'sp-client-assertion.key']) fs.copyFileSync(path.join(certs, name), path.join(process.env.CERTS_DIR, name));
    for (const identity of ['untrusted', 'untrusted-assertion']) {
        const token = client._test.generateClientAssertion(identity, null, 'https://pcm.example/token');
        const [header, payload, signature] = token.split('.');
        assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
        assert.equal(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, identity === 'untrusted' ? config.organizations.untrustedClient.clientId : config.organizations.serviceProvider.clientId);
    }
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    fs.writeFileSync(filename, rsa.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => client._test.generateClientAssertion('untrusted', null, 'https://pcm.example/token'), /transport keys cannot sign ES256/);
});

test('select help covers configured omissions and every fallback demo option', () => {
    const cases = [
        [{}, ['hospital-a', 'hospital-b', 'untrusted']],
        [{ organizations: { serviceProvider: { name: 'Primary' } } }, ['hospital-a']],
        [{ organizations: { serviceProvider: {}, hospitalBServiceProvider: {}, untrustedClient: {} } },
            ['hospital-a', 'hospital-b', 'untrusted', 'untrusted-assertion']]
    ];
    for (const [fixture, ids] of cases) {
        const choices = getIdentities(fixture);
        assert.deepEqual(choices.map(item => item.id), ids);
        assert.ok(choices.every(item => item.helpKey && item.label));
    }
});
