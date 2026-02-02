/**
 * Tests for DS identity mapping.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mapIdentity } = require('../src/mapper');

const LOCAL_SECRET = 'local-secret-key-for-internal-usage';

test('mapIdentity maps patient identifier to local patient reference', () => {
    const pcmIntrospection = {
        active: true,
        client_id: 'sp-client',
        scope: 'patient/Observation.rs',
        iss: 'http://pcm.fhir.health.gov.il/',
        aud: 'https://ds-gateway:8080/fhir',
        iat: Math.floor(Date.now() / 1000),
        patient: 'http://fhir.health.gov.il/identifier/il-national-id|123'
    };

    const token = mapIdentity(pcmIntrospection);
    const payload = jwt.verify(token, LOCAL_SECRET);

    assert.equal(payload.sub, 'sp-client');
    assert.equal(payload.patient, 'Patient/a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3');
});
