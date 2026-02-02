/**
 * Tests for CapabilityStatement content.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fhirRouter = require('../src/routes/fhir');

function getMetadataHandler() {
    const layer = fhirRouter.stack.find(l =>
        l.route && l.route.path === '/metadata' && l.route.methods.get
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
        get: () => 'pcm.fhir.health.gov.il'
    };
    const res = createRes();

    handler(req, res);

    const consent = res.body.rest[0].resource.find(r => r.type === 'Consent');
    const searchParamNames = consent.searchParam.map(p => p.name);
    assert.ok(searchParamNames.includes('patient'));
});
