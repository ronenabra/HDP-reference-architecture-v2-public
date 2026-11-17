'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
// Each Node test worker owns its log rotation directory.
const testLogs = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ds-adapter-test-'));
process.env.LOG_DIR = testLogs;
test.after(() => fs.rmSync(testLogs, { recursive: true, force: true }));
const { resolveRequestBinding } = require('../src/index');

const nginx = fs.readFileSync(path.join(__dirname, '..', '..', 'ds-gateway', 'nginx.conf'), 'utf8');
const reload = fs.readFileSync(path.join(__dirname, '..', '..', 'ds-gateway', 'runtime-reload.sh'), 'utf8');

test('the only public FHIR location always traverses the internal auth subrequest', () => {
    const fhir = nginx.match(/location \/fhir\/ \{([\s\S]*?)\n        \}/)?.[1];
    assert.ok(fhir, 'protected /fhir/ location exists');
    assert.match(fhir, /auth_request \/auth;/);
    assert.match(fhir, /proxy_set_header Authorization "Bearer \$auth_resp_x_local_token";/);
    assert.match(fhir, /proxy_set_header X-Local-Token "";/);
    assert.match(fhir, /proxy_set_header X-PCM-Request-URI \$request_uri;/);
    assert.match(fhir, /proxy_set_header X-PCM-Request-Method \$request_method;/);
    assert.match(fhir, /proxy_pass http:\/\/ds_fhir\//);
    const root = nginx.match(/location = \/fhir \{([\s\S]*?)\n        \}/)?.[1];
    assert.ok(root, 'protected batch-presence root exists');
    assert.match(root, /auth_request \/auth;/);
    assert.match(root, /proxy_set_header Authorization "Bearer \$auth_resp_x_local_token";/);
    assert.match(root, /proxy_set_header X-PCM-Import-Credential "";/);
    assert.match(root, /proxy_set_header X-PCM-Request-URI \$request_uri;/);
});

test('runtime gateway preserves the HAPI /fhir servlet base', () => {
    assert.match(reload, /DS_FHIR_SERVER_PORT\}\/fhir"/);
});

test('adapter preserves clinical GET/HEAD and the separate root POST candidate', () => {
    const request = (method, uri) => ({ get(name) {
        return name === 'x-original-method' ? method : uri;
    } });
    assert.deepEqual(resolveRequestBinding(request('GET', '/fhir/Observation?_count=1')),
        { method: 'GET', uri: '/fhir/Observation?_count=1' });
    assert.deepEqual(resolveRequestBinding(request('GET', '/fhir?_getpages=11111111-1111-1111-1111-111111111111.1.Mac_value-1&_count=1')),
        { method: 'GET', uri: '/fhir?_getpages=11111111-1111-1111-1111-111111111111.1.Mac_value-1&_count=1' });
    assert.deepEqual(resolveRequestBinding(request('GET', '/fhir?_getpages=opaque-1&_getpagesoffset=1')),
        { method: 'GET', uri: '/fhir?_getpages=opaque-1&_getpagesoffset=1' });
    assert.deepEqual(resolveRequestBinding(request('POST', '/fhir')),
        { method: 'POST', uri: '/fhir' });
    assert.throws(() => resolveRequestBinding(request('GET', '/fhir?status=final')), /invalid/);
    assert.throws(() => resolveRequestBinding(request('POST', '/fhir/Observation')), /invalid/);
});

test('adapter signs exactly the authored Patient everything GET routes without normalizing the URI', () => {
    const request = (method, uri) => ({ get: name => name === 'x-original-method' ? method : uri });
    for (const uri of ['/fhir/Patient/$everything?_count=1&_type=Patient,Observation', '/fhir/Patient/patient-1/$everything']) {
        assert.deepEqual(resolveRequestBinding(request('GET', uri)), { method: 'GET', uri });
        assert.throws(() => resolveRequestBinding(request('HEAD', uri)), /invalid/);
    }
    for (const uri of ['/fhir/Patient/$export', '/fhir/Observation/p/$everything', '/fhir/Patient/%70/$everything', '/fhir/Patient/p/$everything/more']) {
        assert.throws(() => resolveRequestBinding(request('GET', uri)), /invalid/);
    }
});

test('auth-check, adapter metadata/JWKS, and FHIR origin have no public bypass', () => {
    const auth = nginx.match(/location = \/auth \{([\s\S]*?)\n        \}/)?.[1];
    assert.ok(auth);
    assert.match(auth, /internal;/);
    assert.match(auth, /proxy_pass http:\/\/ds_auth_adapter\/auth-check;/);
    assert.match(auth, /proxy_set_header X-Original-URI \$request_uri;/);
    assert.match(auth, /proxy_set_header X-Original-Method \$request_method;/);
    assert.doesNotMatch(nginx, /location[^\n]*well-known/);
    assert.match(nginx, /location \/ \{\s*return 404;/);
    assert.equal((nginx.match(/proxy_set_header X-PCM-Import-Credential "";/g) || []).length, 2);
    assert.equal((nginx.match(/proxy_pass http:\/\/ds_fhir\//g) || []).length, 2);
});

test('complete multi-resource contexts have bounded auth-header capacity in both gateways', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../../../pcm-connectathon/nginx/nginx.conf.template'), 'utf8');
    for (const config of [nginx, template]) {
        const auth = config.match(/location = \/auth \{([\s\S]*?)\n        \}/)[1];
        assert.match(auth, /proxy_buffer_size 64k;/);
        assert.match(auth, /internal;/);
    }
});

test('POST binds only a literal type-level _search and leaves membership to native GET policy', () => {
    const { classifyRequestBinding } = require('../src/request-binding');
    for (const uri of ['/fhir/Patient/_search', '/fhir/Observation/_search?code=a%7Cb&code=c%7Cd']) {
        assert.deepEqual(classifyRequestBinding({ method: 'POST', uri }), { route: 'type-search', clinicalTarget: true });
    }
    for (const uri of ['/fhir/_search', '/fhir/Patient/p/_search', '/fhir/Patient/_history/_search',
        '/fhir/Patient/_search/', '/fhir/Patient/%5Fsearch', '/fhir/Patient/$everything', '/fhir?x=y']) {
        assert.throws(() => classifyRequestBinding({ method: 'POST', uri }), /invalid/);
    }
});
