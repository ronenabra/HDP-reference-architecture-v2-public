'use strict';
/** Focused QA contract tests; mocks verify fixture construction, never claim native authorization. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { runHo, scope, caseName, boundaryNames } = require('./hapi-everything-simulation-matrix');

test('common signer emits current schema/context and preserves explicit obsolete negative overrides', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-native-context-'));
    const oldConfig = process.env.TEAM_CONFIG_PATH, oldCerts = process.env.PCM_MATRIX_CERTS_DIR;
    try {
        process.env.TEAM_CONFIG_PATH = path.join(directory, 'config.json');
        process.env.PCM_MATRIX_CERTS_DIR = directory;
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(require('../../test-support/team-config').buildTeamConfig()));
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        for (const ho of ['ho-a', 'ho-b', 'ho-c']) fs.writeFileSync(path.join(directory, `${ho}-gateway.key`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
        const { localToken, presenceClaims } = require('./hapi-authorization-matrix');
        for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
            const payload = jwt.verify(localToken(ho, scope, '/fhir/Patient/$everything'), publicKey, { algorithms: ['RS256'], audience: `urn:pcm:ho:${ho.at(-1)}:fhir-server` });
            assert.equal(payload.schema, 'pcm-ds-local-token/5');
            assert.equal(payload.authorization_schema, 'pcm-ds-authorization-context/4');
            assert.equal(payload.kind, 'data-source-access'); assert.equal(payload.scope, scope);
            assert.equal(payload.patient_identifier.value, '000000018');
            assert.ok(payload.consent_identifier && payload.healthcare_service_identifier && payload.organization);
            const old = jwt.decode(localToken(ho, scope, '/fhir/Patient/$everything', { schema: 'pcm-ds-local-token/4', authorization_schema: 'pcm-ds-authorization-context/3' }));
            assert.equal(old.schema, 'pcm-ds-local-token/4'); assert.equal(old.authorization_schema, 'pcm-ds-authorization-context/3');
            const identifiers = [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' },
                { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '2' }];
            const presenceScope = require('./pcm-042-native-fixture').presenceScope(identifiers);
            const presence = jwt.decode(localToken(ho, presenceScope, '/fhir', presenceClaims('batch-presence', undefined, identifiers)));
            assert.deepEqual(presence.presence_identifiers, identifiers);
            assert.equal(presence.scope, presenceScope);
            assert.equal(presence.contract_identifier.value, 'PCM-POLICY-PRESENCE-001');
            assert.equal(presence.scenario, 'presence-check'); assert.equal(presence.patient_identifier, undefined);
            assert.equal(presence.consent_identifier, undefined); assert.equal(presence.organization, undefined);
            const { claims } = require('./hapi-system-workflow-matrix');
            for (const scenario of ['patient-authentication', 'dependent-discovery']) {
                const workflow = claims(scenario);
                assert.equal(workflow.scenario, scenario); assert.equal(workflow.kind, scenario);
                assert.equal(workflow.consent_identifier, undefined); assert.equal(workflow.organization, undefined);
                assert.equal(workflow.healthcare_service_identifier, undefined);
                assert.equal(workflow.contract_identifier.system, 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id');
                assert.equal(workflow.contract_identifier.value, scenario === 'patient-authentication' ? 'PCM-POLICY-PATIENT-AUTHENTICATION-001' : 'PCM-POLICY-DEPENDENT-DISCOVERY-001');
                assert.equal((scenario === 'patient-authentication' ? workflow.patient_identifier : workflow.representative_identifier).value, '000000018');
                assert.equal(scenario === 'patient-authentication' ? workflow.representative_identifier : workflow.patient_identifier, undefined);
            }
        }
    } finally {
        if (oldConfig === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = oldConfig;
        if (oldCerts === undefined) delete process.env.PCM_MATRIX_CERTS_DIR; else process.env.PCM_MATRIX_CERTS_DIR = oldCerts;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

/** Independently specified wire-plan spy distinguishes baseline, later denials and admission denials. */
function fixtureIo(ho, baselineStatus = 200) {
    const calls = [];
    const io = {
        traverse: async (source, uri, retained, expected, options) => {
            assert.equal(source, ho); assert.equal(retained, scope); assert.equal(options, undefined);
            assert.deepEqual(expected, [1, 2].map(n => `Observation/observation-${ho}-000${n}`));
            return expected.map(id => ({ ids: [id] }));
        },
        request: async (source, uri, retained, options = {}) => {
            assert.equal(source, ho); assert.equal(retained, scope); calls.push({ uri, claims: options.claims });
            if (calls.length === 1) return { response: { status: baselineStatus }, body: { link: [{ relation: 'next', url: `https://${ho}-gateway:8080/fhir?cursor=one` }] } };
            const control = /_count=0|_summary=count|_total=accurate/.test(uri);
            return { response: { status: control ? 400 : 403 } };
        },
        localToken: (source, retained, uri, claims) => {
            assert.equal(source, ho); assert.equal(retained, scope); assert.equal(claims, undefined); return 'current.valid.signature';
        },
        fetch: async (uri, options) => {
            calls.push({ wire: uri, headers: options.headers });
            return { status: 403, text: async () => '' };
        }
    };
    return { io, calls };
}
test('each source plans supported two-row traversal and independently varied request boundaries', async () => {
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        const { io, calls } = fixtureIo(ho);
        const result = await runHo(ho, io);
        assert.equal(result.name, caseName); assert.deepEqual(result.checks, boundaryNames);
        assert.equal(result.baselineStatus, 200); assert.equal(result.pages.length, 2);
        assert.equal(calls[1].claims.patient_identifier, undefined);
        assert.match(calls[2].uri, /htest-1/);
        assert.equal(calls[3].claims.patient_identifier.value, '1');
        const raw = calls.find(item => item.headers?.Authorization);
        assert.match(raw.wire, /_type=Patient/); assert.match(raw.headers['X-PCM-Request-URI'], /_type=Observation/);
        assert.equal(calls.filter(item => item.claims?.kind === 'unfiltered-simulation').length, 1);
        assert.equal(calls.at(-3).claims.schema, 'pcm-ds-local-token/4');
        assert.equal(calls.at(-2).claims.authorization_schema, 'pcm-ds-authorization-context/3');
    }
});
test('failed admission baseline stops all later boundary claims', async () => {
    const { io, calls } = fixtureIo('ho-a', 403);
    await assert.rejects(runHo('ho-a', io));
    assert.equal(calls.length, 1);
});
