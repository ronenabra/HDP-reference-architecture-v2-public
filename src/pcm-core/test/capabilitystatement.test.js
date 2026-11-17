require('../../../test-support/team-config').installTestRuntime();
/**
 * Tests for CapabilityStatement content.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const previousLogDir = process.env.LOG_DIR;
const logDir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-capability-logs-'));
process.env.LOG_DIR = logDir;
const fhirRouter = require('../src/routes/fhir');

test.after(() => {
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    fs.rmSync(logDir, { recursive: true, force: true });
});

function getMetadataHandler() {
    const layer = fhirRouter.stack.find(l =>
        l.route && l.route.path === '/metadata' && l.route.methods.get
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getSmartConfigurationHandler() {
    const layer = fhirRouter.stack.find(l =>
        l.route && l.route.path === '/.well-known/smart-configuration' && l.route.methods.get
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        type(value) {
            this.headers['content-type'] = value;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

test('CapabilityStatement includes consent patient search param', () => {
    const handler = getMetadataHandler();
    const req = {
        protocol: 'https',
        get: name => (name === 'host' ? 'pcm.fhir.health.gov.il' : undefined)
    };
    const res = createRes();

    handler(req, res);

    const consent = res.body.rest[0].resource.find(r => r.type === 'Consent');
    const searchParamNames = consent.searchParam.map(p => p.name);
    assert.ok(searchParamNames.includes('patient'));
});

test('SMART configuration advertises the confidential asymmetric client capability', () => {
    const handler = getSmartConfigurationHandler();
    const req = {
        protocol: 'https',
        get: name => (name === 'host' ? 'pcm.fhir.health.gov.il' : undefined)
    };
    const res = createRes();

    handler(req, res);

    assert.equal(res.body.issuer, 'https://pcm2mtest.health.gov.il/api/fhir-service/r4');
    assert.doesNotMatch(res.body.authorization_endpoint, /pcm-core/);
    assert.ok(res.body.capabilities.includes('client-confidential-asymmetric'));
    assert.ok(!res.body.capabilities.includes('client-confidential-assymmetric'));
});
