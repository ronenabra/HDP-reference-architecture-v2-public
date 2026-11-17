require('../../../test-support/team-config').installTestRuntime();
/**
 * Route-level tests for compact harness logging.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

/** Supply current ordinary Consent/service context before the intentionally failing source boundary. */
function currentContext() {
    const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
    const fixture = clinicalTokenFixture({ now: Math.floor(Date.now() / 1000) - 1,
        scope: `patient/Patient.rs?${V} patient/Observation.rs?${V}` });
    const instance = fixture.store.get('HealthcareService', fixture.service.id);
    const definitionId = require('../../pcm-core/src/fhir/healthcare-service-lifecycle').basedOnId(instance);
    const definition = fixture.store.get('HealthcareService', definitionId);
    const provider = fixture.store.get('Organization', fixture.client.organizationId);
    const service = require('../src/service-directory').projectOwnedServices({ entry: [instance, definition].map(resource => ({ resource })) }, provider.id, provider)[0];
    assert.equal(service.available, true);
    return { consent: fixture.consent, service };
}

function readLogs(tmp) {
    return fs.readFileSync(path.join(tmp, 'current.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

test('fetch-data route emits diagnostic harness boundary events for malformed successful DS responses', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-harness-route-'));
    const previousLogDir = process.env.LOG_DIR;
    const previousSessionId = process.env.LOG_SESSION_ID;
    process.env.LOG_DIR = tmp;
    process.env.LOG_SESSION_ID = 'sp-harness-test-session';

    const clientPath = require.resolve('../src/client');
    const indexPath = require.resolve('../src/index');
    const loggerPath = require.resolve('../src/logger');
    const previousClientCache = require.cache[clientPath];
    const context = currentContext();
    let sourceCalls = 0;
    delete require.cache[indexPath];
    delete require.cache[loggerPath];
    require.cache[clientPath] = {
        id: clientPath,
        filename: clientPath,
        loaded: true,
        exports: {
            createConsentRequest: async () => ({ id: 'unused' }),
            checkConsentStatus: async (id, identity) => {
                assert.equal(id, context.consent.id); assert.equal(identity, 'hospital-a');
                return structuredClone(context.consent);
            },
            readOwnedService: async (id, identity) => {
                assert.equal(id, context.service.id); assert.equal(identity, 'hospital-a');
                return structuredClone(context.service);
            },
            fetchData: async (id, endpoint, identity, query) => {
                assert.equal(id, context.consent.id); assert.equal(endpoint, 'https://external.example/fhir');
                assert.equal(identity, 'hospital-a'); assert.equal(query, 'patient/Observation.rs');
                sourceCalls++;

                const err = new Error('Data Source Observation fetch returned an unexpected successful response: missing FHIR resourceType');
                err.classification = 'unexpected_response';
                err.response = { status: 200, data: '<html>not FHIR</html>' };
                throw err;
            },
            resetCache: () => {}
        }
    };

    const { app } = require('../src/index');
    const server = app.listen(0);

    try {
        const body = new URLSearchParams({
            identity: 'hospital-a',
            consentId: context.consent.id,
            endpointUrl: 'https://external.example/fhir',
            requestedScope: 'patient/Observation.rs'
        }).toString();
        const { port } = server.address();
        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/fetch-data',
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': Buffer.byteLength(body),
                    'x-correlation-id': 'route-correlation'
                }
            }, res => {
                res.resume();
                res.on('end', () => resolve(res));
            });
            req.on('error', reject);
            req.end(body);
        });

        assert.equal(response.statusCode, 502, 'a rejected HTTP 200 source response cannot become a successful Doctor response');

        assert.equal(sourceCalls, 1, 'the malformed-response probe must reach the source boundary');
        const harnessLogs = readLogs(tmp).filter(log => log.details.category === 'harness');
        assert.ok(harnessLogs.some(log => log.details.type === 'HARNESS_ACTION_STARTED'));
        const failed = harnessLogs.find(log => log.details.type === 'HARNESS_ACTION_FAILED');
        assert.equal(failed.details.visibility, 'diagnostic');
        assert.equal(failed.details.operation, 'fetch-data');
        assert.equal(failed.details.causesSystemFlow, true);
        assert.equal(failed.details.correlationId, 'route-correlation');
        assert.ok(failed.details.flowId);
        assert.notEqual(failed.details.flowId, failed.details.correlationId);
        assert.equal(harnessLogs.find(log => log.details.type === 'HARNESS_ACTION_STARTED').details.flowId, failed.details.flowId);
        assert.match(failed.details.error.message, /unexpected successful response/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousClientCache) require.cache[clientPath] = previousClientCache;
        else delete require.cache[clientPath];
        delete require.cache[indexPath];
        delete require.cache[loggerPath];
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
        if (previousSessionId === undefined) delete process.env.LOG_SESSION_ID;
        else process.env.LOG_SESSION_ID = previousSessionId;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('fetch-data route emits diagnostic harness failure for external DS timeouts', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-harness-timeout-'));
    const previousLogDir = process.env.LOG_DIR;
    const previousSessionId = process.env.LOG_SESSION_ID;
    process.env.LOG_DIR = tmp;
    process.env.LOG_SESSION_ID = 'sp-harness-timeout-session';

    const clientPath = require.resolve('../src/client');
    const indexPath = require.resolve('../src/index');
    const loggerPath = require.resolve('../src/logger');
    const previousClientCache = require.cache[clientPath];
    const context = currentContext();
    let sourceCalls = 0;
    delete require.cache[indexPath];
    delete require.cache[loggerPath];
    require.cache[clientPath] = {
        id: clientPath,
        filename: clientPath,
        loaded: true,
        exports: {
            createConsentRequest: async () => ({ id: 'unused' }),
            checkConsentStatus: async (id, identity) => {
                assert.equal(id, context.consent.id); assert.equal(identity, 'hospital-a');
                return structuredClone(context.consent);
            },
            readOwnedService: async (id, identity) => {
                assert.equal(id, context.service.id); assert.equal(identity, 'hospital-a');
                return structuredClone(context.service);
            },
            fetchData: async (id, endpoint, identity, query) => {
                assert.equal(id, context.consent.id); assert.equal(endpoint, 'https://external.example/fhir');
                assert.equal(identity, 'hospital-a'); assert.equal(query, 'patient/Observation.rs');
                sourceCalls++;

                const err = new Error('Data Source Observation fetch timed out after 12000ms within 12000ms: https://external.example/fhir/Observation');
                err.classification = 'timeout';
                throw err;
            },
            resetCache: () => {}
        }
    };

    const { app } = require('../src/index');
    const server = app.listen(0);

    try {
        const body = new URLSearchParams({
            identity: 'hospital-a',
            consentId: context.consent.id,
            endpointUrl: 'https://external.example/fhir',
            requestedScope: 'patient/Observation.rs'
        }).toString();
        const { port } = server.address();
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/fetch-data',
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'content-length': Buffer.byteLength(body),
                    'x-correlation-id': 'timeout-correlation'
                }
            }, res => {
                res.resume();
                res.on('end', () => resolve(res));
            });
            req.on('error', reject);
            req.end(body);
        });

        assert.equal(sourceCalls, 1, 'the timeout probe must reach the source boundary');
        const failed = readLogs(tmp)
            .filter(log => log.details.category === 'harness')
            .find(log => log.details.type === 'HARNESS_ACTION_FAILED');
        assert.equal(failed.details.operation, 'fetch-data');
        assert.equal(failed.details.correlationId, 'timeout-correlation');
        assert.equal(failed.details.visibility, 'diagnostic');
        assert.equal(failed.details.causesSystemFlow, true);
        assert.ok(failed.details.flowId);
        assert.notEqual(failed.details.flowId, failed.details.correlationId);
        assert.equal(readLogs(tmp).find(log => log.details.type === 'HARNESS_ACTION_STARTED').details.flowId, failed.details.flowId);
        assert.match(failed.details.error.message, /timed out/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousClientCache) require.cache[clientPath] = previousClientCache;
        else delete require.cache[clientPath];
        delete require.cache[indexPath];
        delete require.cache[loggerPath];
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
        if (previousSessionId === undefined) delete process.env.LOG_SESSION_ID;
        else process.env.LOG_SESSION_ID = previousSessionId;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
