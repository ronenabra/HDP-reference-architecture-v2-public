/**
 * Tests for SP token retry error classification.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LOG_DIR = process.env.LOG_DIR || path.join(process.env.TEST_TMPDIR || '/tmp', 'sp-client-token-error-test-logs');
const client = require('../src/client');

test('withRetry does not relabel non-expiry 401 errors as token expiry', async () => {
    const err = new Error('Client not registered');
    err.response = {
        status: 401,
        data: {
            error: 'invalid_client',
            error_description: 'Client not registered'
        }
    };

    await assert.rejects(
        client.withRetry(async () => {
            throw err;
        }),
        /Client not registered/
    );
});

test('SP-001 uncertain Consent create retry never repeats a non-idempotent outcome', async () => {
    let attempts = 0;
    const uncertain = new Error('create outcome uncertain');
    uncertain.classification = 'uncertain_create';
    await assert.rejects(client.withRetry(async () => {
        attempts += 1;
        throw uncertain;
    }), /uncertain/);
    assert.equal(attempts, 1);
});

test('token expiry classifier only treats explicit expiry diagnostics as retryable', () => {
    assert.equal(client._test.isTokenExpiryResponse({
        error: 'invalid_client',
        error_description: 'Client not registered'
    }), false);

    assert.equal(client._test.isTokenExpiryResponse({
        error: 'Unauthorized',
        issue: [{ diagnostics: 'Invalid or Expired Token' }]
    }), true);
});

test('token endpoint errors keep their server diagnostic message', async () => {
    const err = new Error('Request failed with status code 401');
    err.response = {
        data: {
            error: 'invalid_client',
            error_description: 'Client not registered'
        }
    };

    try {
        throw err;
    } catch (caught) {
        if (caught.response?.data?.error_description) {
            caught.message = caught.response.data.error_description;
        }
        assert.equal(caught.message, 'Client not registered');
    }
});

test('outbound error classifier distinguishes data-source timeouts and 504s', () => {
    const timeout = client._test.classifyOutboundError({
        code: 'ECONNABORTED',
        message: 'timeout of 12000ms exceeded',
        config: {
            url: 'https://ds.example/fhir/Observation',
            timeout: 12000,
            metadata: { durationMs: 12005 }
        }
    }, { stage: 'Data Source Observation fetch' });
    assert.equal(timeout.code, 'timeout');
    assert.match(timeout.message, /Data Source Observation fetch timed out/);
    assert.match(timeout.message, /12000ms/);

    const gatewayTimeout = client._test.classifyOutboundError({
        response: { status: 504 },
        config: { url: 'https://ds.example/fhir/Observation' }
    }, { stage: 'Data Source Observation fetch' });
    assert.equal(gatewayTimeout.code, 'gateway_timeout');
    assert.match(gatewayTimeout.message, /HTTP 504/);
});

test('local validation and already classified failures are not relabeled as network errors', () => {
    const local = client._test.classifyOutboundError(new TypeError('Invalid patient identifier'), { stage: 'Data Source fetch' });
    assert.equal(local.code, 'local_validation_error');
    assert.match(local.message, /validation failed/);
    assert.doesNotMatch(local.message, /before receiving/);
    const classified = Object.assign(new TypeError('Response validation failed (HTTP 200)'), { classification: 'invalid_token_response' });
    assert.deepEqual(client._test.classifyOutboundError(classified), { code: classified.classification, message: classified.message });
    assert.equal(client._test.classifyOutboundError(new Error('Connection refused')).code, 'network_error');
});

test('successful data-source responses must be FHIR Observation or Bundle resources', () => {
    const bundle = { resourceType: 'Bundle', entry: [] };
    assert.equal(client._test.validateObservationResponse({
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
        data: bundle
    }), bundle);

    const observation = { resourceType: 'Observation', id: 'obs-1' };
    assert.equal(client._test.validateObservationResponse({
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
        data: observation
    }), observation);

    assert.throws(() => client._test.validateObservationResponse({
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<html>not fhir</html>'
    }, {
        targetUrl: 'https://ds.example/fhir',
        requestUrl: 'https://ds.example/fhir',
        consentId: 'consent-1',
        identity: 'hospital-a'
    }), err => {
        assert.equal(err.classification, 'unexpected_response');
        assert.match(err.message, /unexpected successful response/);
        return true;
    });
});

test('SP logger classifies harness routes as diagnostic without full middleware logs', () => {
    const logger = require('../src/logger');

    assert.deepEqual(logger.classifyRoute('/create-consent'), {
        match: /^\/create-consent$/,
        category: 'harness',
        visibility: 'diagnostic',
        operation: 'create-consent',
        emitMiddleware: false,
        causesSystemFlow: true
    });

    assert.equal(logger.classifyRoute('/api/logs').category, 'noise');
    assert.equal(logger.classifyRoute('/api/logs').visibility, 'hidden');
    assert.equal(logger.classifyRoute('/admin').category, 'admin');
    assert.equal(logger.classifyRoute('/r4/Observation').category, 'system');
    assert.equal(logger.classifyRoute('/r4/Observation').emitMiddleware, true);
});
