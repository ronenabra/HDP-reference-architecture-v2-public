'use strict';

/** Generated three-HO matrix for the strict HAPI result-filtering pipeline. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { buildEffectivePolicy, simulationPolicyStamp } = require(fs.existsSync('/shared/conformance-policy.js') ? '/shared/conformance-policy' : '../../src/shared/conformance-policy');
const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json', 'utf8'));
const policy = buildEffectivePolicy(config, process.env);
const { presenceScope } = require('./pcm-042-native-fixture');

const CERTS_DIR = process.env.PCM_MATRIX_CERTS_DIR || '/runtime/certs';
const PATIENT = Object.freeze({
    system: 'http://fhir.health.gov.il/identifier/il-national-id',
    value: '000000018'
});
const HOS = Object.freeze({
    'ho-a': { audience: 'urn:pcm:ho:a:fhir-server' },
    'ho-b': { audience: 'urn:pcm:ho:b:fhir-server' },
    'ho-c': { audience: 'urn:pcm:ho:c:fhir-server' }
});

function keyId(privateKey) {
    const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    return `local-jwt-${crypto.createHash('sha256').update(der).digest('base64url').slice(0, 16)}`;
}

function localToken(ho, scope, uri, overrides = {}, method = 'GET') {
    const key = fs.readFileSync(path.join(CERTS_DIR, `${ho}-gateway.key`), 'utf8');
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        schema: 'pcm-ds-local-token/5',
        policy_stamp: simulationPolicyStamp(policy.simulation.perSource[ho] || policy.simulation.controls, ho, config.runtime?.revision || 0),
        authorization_schema: 'pcm-ds-authorization-context/4',
        ho_id: ho,
        kind: 'data-source-access',
        sub: 'pcm-matrix-client-0000000001',
        client_id: 'pcm-matrix-client-0000000001',
        scope,
        pcm_issuer: config.contract.operational.oauthBase,
        pcm_audience: `https://${ho}-gateway:8080/fhir`,
        pcm_expires_at: now + 60,
        authentication: {
            tokenEndpointMtlsThumbprint: 'A'.repeat(43),
            clientAssertionSigningThumbprint: 'B'.repeat(43),
            correlationVerified: true
        },
        patient_identifier: PATIENT,
        scenario: 'consent-access',
        consent_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'matrix-consent' },
        healthcare_service_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-instance-id', value: 'matrix-service' },
        organization: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: 'matrix-client' },
        request_binding: { method, uri },
        ...overrides
    };
    return jwt.sign(payload, key, {
        algorithm: 'RS256', keyid: keyId(key), issuer: `https://${ho}-adapter.internal/${ho}`,
        audience: HOS[ho].audience, expiresIn: 30, jwtid: crypto.randomUUID(),
        header: { alg: 'RS256', typ: 'JWT', kid: keyId(key) }
    });
}

async function request(ho, uri, scope, options = {}) {
    const tokenHo = options.tokenHo || ho;
    const method = options.method || 'GET';
    const token = options.token || localToken(tokenHo, scope, uri, options.claims, method);
    const response = await fetch(`https://${ho}-hapi:8080${uri}`, {
        method,
        headers: {
            Accept: 'application/fhir+json', Authorization: `Bearer ${token}`,
            'Content-Type': 'application/fhir+json',
            'X-PCM-Request-Method': method, 'X-PCM-Request-URI': uri
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_error) { /* retain text for leakage checks */ }
    return { response, body, text };
}

function presenceClaims(kind, patientIdentifier, presenceIdentifiers) {
    return {
        kind,
        sub: 'pcm-presence-orchestrator',
        client_id: 'pcm-presence-orchestrator',
        patient_identifier: undefined, consent_identifier: undefined, organization: undefined,
        scenario: 'presence-check',
        contract_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' },
        healthcare_service_identifier: undefined,
        presence_identifiers: presenceIdentifiers || [patientIdentifier]
    };
}

function presenceEntry(identifier) {
    return {
        request: {
            method: 'GET',
            url: `Patient?identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}&_summary=count&_count=0`
        }
    };
}

async function runPresenceHo(ho) {
    const system = 'http://fhir.health.gov.il/identifier/il-hdp-test-id';
    const one = { system, value: '1' };
    const two = { system, value: '2' };
    const absent = {
        system: 'http://fhir.health.gov.il/identifier/il-national-id',
        value: '000000026'
    };
    for (const [identifier, total] of [[one, 1], [absent, 0]]) {
        const scope = presenceScope([identifier]);
        const uri = `/fhir/Patient?identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}&_summary=count&_count=0`;
        const result = await request(ho, uri, scope, {
            claims: presenceClaims('online-presence', identifier)
        });
        assert.equal(result.response.status, 200, `${ho} online presence: ${result.text}`);
        assert.equal(result.body.type, 'searchset');
        assert.equal(result.body.total, total);
        assert.deepEqual(result.body.entry || [], []);
        assert.equal(result.text.includes('Synthetic HTEST'), false);
    }

    const onlineScope = presenceScope([one]);
    await expectDenied(await request(ho,
        `/fhir/Patient?identifier=${encodeURIComponent(`${one.system}|${one.value}`)}&_summary=count&_count=0&name=secret`,
        onlineScope, { claims: presenceClaims('online-presence', one) }), `${ho} online extra query`, ['secret']);
    const clinicalPatientCount = await request(ho,
        `/fhir/Patient?identifier=${encodeURIComponent(`${one.system}|${one.value}`)}&_summary=count&_count=0`,
        'patient/Patient.s');
    assert.equal(clinicalPatientCount.response.status, 200, `${ho} clinical count remains patient constrained`);
    assert.equal(clinicalPatientCount.body.total, 0, `${ho} clinical count cannot see presence-only Patient`);

    const batchScope = presenceScope([one, two]);
    const batchClaims = presenceClaims('batch-presence', undefined, [one, two]);
    const batch = await request(ho, '/fhir/', batchScope, {
        method: 'POST', claims: batchClaims,
        body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry(one), presenceEntry(two)] }
    });
    assert.equal(batch.response.status, 200, `${ho} batch presence: ${batch.text}`);
    assert.equal(batch.body.type, 'batch-response');
    assert.deepEqual(batch.body.entry.map(entry => entry.response.status), ['200', '200']);
    assert.deepEqual(batch.body.entry.map(entry => entry.resource.total), [1, 1], JSON.stringify(batch.body));
    assert.ok(batch.body.entry.every(entry => (entry.resource.entry || []).length === 0));

    const isolated = await request(ho, '/fhir/', batchScope, {
        method: 'POST', claims: batchClaims,
        body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry(one), presenceEntry(absent)] }
    });
    assert.deepEqual(isolated.body.entry.map(entry => entry.response.status), ['200', '403']);
    assert.equal(isolated.text.includes(absent.value), false);

    await expectRejected(await request(ho, '/fhir/', batchScope, {
        method: 'POST', claims: batchClaims,
        body: { resourceType: 'Bundle', type: 'transaction', entry: [presenceEntry(one)] }
    }), `${ho} transaction under batch token`);
    await expectRejected(await request(ho, '/fhir/', 'patient/Observation.rs', {
        method: 'POST', body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry(one)] }
    }), `${ho} clinical token on root POST`);
    process.stdout.write(`PASS ${ho} online/batch presence and HTEST matrix\n`);
}

function ids(bundle) {
    return (bundle.entry || []).map(entry => `${entry.resource.resourceType}/${entry.resource.id}`).sort();
}

async function expectDenied(result, label, forbidden = []) {
    assert.ok([403, 404].includes(result.response.status), `${label}: ${result.response.status}`);
    assert.equal(result.text.includes(PATIENT.value), false, `${label}: diagnostic leaked Patient identifier`);
    for (const value of forbidden) {
        assert.equal(result.text.includes(value), false,
            `${label}: diagnostic leaked ${value}: ${result.text}`);
    }
}

async function expectRejected(result, label, forbidden = []) {
    assert.ok(result.response.status >= 400 && result.response.status < 500, `${label}: ${result.response.status}`);
    assert.equal(result.text.includes(PATIENT.value), false, `${label}: diagnostic leaked Patient identifier`);
    for (const value of forbidden) assert.equal(result.text.includes(value), false, `${label}: diagnostic leaked ${value}`);
}

async function runHo(ho) {
    const base = 'patient/Observation.rs';
    const simple = await request(ho, '/fhir/Observation', base);
    assert.equal(simple.response.status, 200, `${ho} simple search`);
    assert.equal(Object.hasOwn(simple.body, 'total'), false, `${ho} ordinary total`);
    assert.deepEqual(ids(simple.body), [1, 2, 3, 4].map(n => `Observation/observation-${ho}-000${n}`));

    const conjunction = await request(ho, '/fhir/Observation',
        'patient/Observation.s?status=final&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|procedures&date=ge2026-01-01');
    assert.deepEqual(ids(conjunction.body), [`Observation/observation-${ho}-0003`], `${ho} conjunction`);

    const union = await request(ho, '/fhir/Observation',
        'patient/Observation.s?status=final patient/Observation.s?status=preliminary');
    assert.deepEqual(ids(union.body), ids(simple.body), `${ho} independent scope union`);

    const sensitive = await request(ho, '/fhir/Observation',
        'patient/Observation.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&date=ge2026-01-01');
    assert.deepEqual(ids(sensitive.body), [
        `Observation/observation-${ho}-0001`, `Observation/observation-${ho}-0002`
    ], `${ho} sensitivity exclusion`);

    const empty = await request(ho, '/fhir/Observation', 'patient/Observation.s?status=entered-in-error');
    assert.equal(empty.response.status, 200, `${ho} authorized empty`);
    assert.deepEqual(ids(empty.body), []);
    assert.equal(Object.hasOwn(empty.body, 'total'), false);


    await expectDenied(await request(ho, `/fhir/Observation/observation-${ho}-0001`, 'patient/Observation.s'), `${ho} s read`);
    const read = await request(ho, `/fhir/Observation/observation-${ho}-0001`, 'patient/Observation.r');
    assert.equal(read.response.status, 200, `${ho} r read`);
    await expectDenied(await request(ho, '/fhir/Observation', 'patient/Observation.r'), `${ho} r search`);
    await expectDenied(await request(ho, `/fhir/Observation/observation-${ho}-0003`,
        'patient/Observation.r?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests'),
    `${ho} filtered hidden read`, [`observation-${ho}-0003`]);

    const history = await request(ho, `/fhir/Observation/observation-${ho}-0001/_history`, 'patient/Observation.r');
    assert.equal(history.response.status, 200, `${ho} history`);
    assert.ok(ids(history.body).includes(`Observation/observation-${ho}-0001`));

    const include = await request(ho, '/fhir/Observation?_id=observation-' + ho + '-0001&_include=Observation%3Asubject',
        'patient/Observation.s patient/Patient.r');
    assert.deepEqual(ids(include.body), [
        `Observation/observation-${ho}-0001`, `Patient/patient-${ho}-0001`
    ]);

    const revinclude = await request(ho,
        `/fhir/Patient?_id=patient-${ho}-0001&_revinclude=Observation%3Asubject`,
        'patient/Patient.s patient/Observation.r');
    assert.deepEqual(ids(revinclude.body), [
        ...[1, 2, 3, 4].map(n => `Observation/observation-${ho}-000${n}`), `Patient/patient-${ho}-0001`
    ], `${ho} revinclude`);

    const firstPage = await request(ho, '/fhir/Observation?_count=1', base);
    assert.equal(firstPage.response.status, 200);
    assert.equal(ids(firstPage.body).length, 1);
    assert.equal(Object.hasOwn(firstPage.body, 'total'), false);
    const nextUrl = firstPage.body.link?.find(link => link.relation === 'next')?.url;
    assert.ok(nextUrl, `${ho} native next link: ${JSON.stringify(firstPage.body)}`);
    const parsedNext = new URL(nextUrl);
    const nextUri = `${parsedNext.pathname}${parsedNext.search}`;
    const nextPage = await request(ho, nextUri, base);
    assert.equal(nextPage.response.status, 200, `${ho} next page: ${nextPage.text}`);
    assert.equal(ids(nextPage.body).length, 1);
    assert.notDeepEqual(ids(nextPage.body), ids(firstPage.body));

    for (const uri of [
        '/fhir/Observation?_filter=status%20eq%20final',
        '/fhir/Observation?_has:Provenance:target:agent=Practitioner%2F1',
        '/fhir/Observation?subject.identifier=123',
        '/fhir/Observation?_lastUpdated=ge2026-01-01', '/fhir/Binary'
    ]) await expectDenied(await request(ho, uri, base), `${ho} deferred ${uri}`);

    for (const unsupportedScope of [
        'user/Observation.r', 'patient/Observation.cruds',
        'patient/Observation.s?_sort=date', 'patient/Observation.s?status:not=final'
    ]) await expectDenied(await request(ho, '/fhir/Observation', unsupportedScope),
        `${ho} unsupported scope ${unsupportedScope}`);

    await expectDenied(await request(ho, '/fhir/Observation', base, {
        claims: { patient_identifier: { system: PATIENT.system, value: 'does-not-exist' } }
    }), `${ho} zero Patient match`);

    // These are well-signed requests with invalid authorization context, not invalid JWTs.
    for (const patientIdentifier of [undefined, null, PATIENT.value, [PATIENT], {},
        { value: PATIENT.value }, { system: PATIENT.system },
        { system: PATIENT.system, value: '' }, { system: PATIENT.system, value: 18 },
        { system: 'urn:unsupported-patient-identifier', value: PATIENT.value }]) {
        await expectRejected(await request(ho, '/fhir/Observation', base, {
            claims: { patient_identifier: patientIdentifier }
        }), `${ho} malformed Patient authorization context`);
    }

    process.stdout.write(`PASS ${ho} resource/interaction/patient/bucket/history/sensitivity/include/page/malformed-context matrix\n`);
}

/** Exact-count matrix shared by protected and explicitly signed easy-mode requests. */
async function runCountHo(ho) {
    const base = 'patient/Observation.rs';
    // Independently enumerated fixture IDs and ordinary authorized results are
    // both count oracles. Repeated/overlapping scope alternatives never add twice.
    const countCases = [
        [base, '', 4],
        [base, '&status=entered-in-error', 0],
        [base, `&_id=observation-${ho}-0001`, 1],
        ['patient/Observation.s?status=final patient/Observation.s?status=preliminary', '', 4],
        ['patient/Observation.s?status=final patient/Observation.s?status=final', '', 3],
        ['patient/Observation.s?status=final patient/Observation.r', '', 3],
        ['patient/Observation.s?status=final', '&status=preliminary', 0],
        ['patient/Observation.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&date=ge2026-01-01', '', 2],
        ['patient/Observation.s', `&_id=observation-${ho}-0001&_include=Observation%3Aperformer`, 1]
    ];
    for (const [scope, query, expected] of countCases) {
        for (const spelling of ['_summary=count', '_count=0', '_summary=count&_count=25&_total=accurate']) {
            const counted = await request(ho, `/fhir/Observation?${spelling}${query}`, scope);
            assert.equal(counted.response.status, 200, `${ho} exact count ${scope}: ${counted.text}`);
            assert.equal(counted.body.type, 'searchset');
            assert.equal(counted.body.total, expected, `${ho} ${scope} ${spelling}`);
            assert.deepEqual(counted.body.entry || [], []);
            assert.deepEqual(counted.body.link || [], []);
        }
    }
    // Scope filters use the ordinary authorization matcher as the oracle on one
    // independently known fixture. Client date semantics remain native FHIR.
    for (const kind of ['patient']) {
        for (const filter of ['date=sa1900-01-01', 'date=ne1900-01-01', 'date=ap1900-01-01',
            'date=eb1900-01-01', 'code=|718-7', 'code=http://loinc.org|', '_security=|laboratoryTests',
            '_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|',
            '_security=|', '_security:not=laboratoryTests,missing']) {
            const scope = `${kind}/Observation.s?${filter}`;
            for (const authority of [scope, `${scope} patient/Observation.s?status=final`]) {
                const uri = `/fhir/Observation?_id=observation-${ho}-0001`;
                const ordinary = await request(ho, `${uri}&_count=10`, authority);
                assert.equal(ordinary.response.status, 200, `${ho} ordinary exceptional scope ${authority}`);
                const ids = new Set((ordinary.body.entry || []).map(entry => entry.resource.id));
                for (const alias of ['_summary=count', '_count=0']) {
                    const count = await request(ho, `${uri}&${alias}`, authority);
                    assert.equal(count.response.status, 200, `${ho} exceptional scope ${authority}: ${count.text}`);
                    assert.equal(count.body.total, ids.size, `${ho} exceptional scope ${authority}`);
                }
            }
        }
        const clientDate = await request(ho, `/fhir/Observation?_id=observation-${ho}-0001&date=sa1900-01-01&_summary=count`, `${kind}/Observation.s`);
        assert.equal(clientDate.response.status, 200);
        assert.equal(clientDate.body.total, 1, 'native client sa date must not inherit scope matcher restrictions');
    }
    for (const controls of ['_summary=count&_total=estimate', '_summary=count&_total=none',
        '_count=0&_count=1', '_summary=count&_summary=count', '_count=-1', '_summary=count&_count=abc']) {
        const result = await request(ho, `/fhir/Observation?${controls}`, base);
        assert.equal(result.response.status, 400, `${ho} invalid count controls: ${result.text}`);
        assert.equal(result.body.resourceType, 'OperationOutcome');
    }
    await expectDenied(await request(ho, '/fhir/Observation?_summary=count', 'patient/Observation.r'), `${ho} read-only count`);
    // Consent clinical context accepts only patient scope alternatives, even when well signed.
    for (const scope of ['system/Observation.s', 'patient/Observation.s system/Observation.r']) {
        for (const uri of ['/fhir/Observation', '/fhir/Observation?_summary=count']) {
            await expectDenied(await request(ho, uri, scope), `${ho} invalid clinical scope prefix ${scope}`);
        }
    }

}

async function main() {
    const selected = (process.env.PCM_MATRIX_HOS || Object.keys(HOS).join(','))
        .split(',').filter(ho => Object.hasOwn(HOS, ho));
    assert.ok(selected.length, 'PCM_MATRIX_HOS selected no known HO');
    for (const ho of selected) {
        await runHo(ho);
        await runPresenceHo(ho);
    }
    if (selected.length !== Object.keys(HOS).length) return;
    for (const [source, target] of [['ho-a', 'ho-b'], ['ho-b', 'ho-c'], ['ho-c', 'ho-a']]) {
        const uri = '/fhir/Observation';
        await expectDenied(await request(target, uri, 'patient/Observation.rs', { tokenHo: source }), `${source}->${target}`);
        await expectDenied(await request(source, uri, 'patient/Observation.rs', {
            claims: { ho_id: target }
        }), `${source} wrong HO claim`);
        const firstPage = await request(target, '/fhir/Observation?_count=1', 'patient/Observation.rs');
        const nextUrl = firstPage.body.link?.find(link => link.relation === 'next')?.url;
        assert.ok(nextUrl, `${target} cross-HO page setup`);
        const parsedNext = new URL(nextUrl);
        await expectDenied(await request(target, `${parsedNext.pathname}${parsedNext.search}`,
            'patient/Observation.rs', { tokenHo: source }), `${source}->${target} page`);

        const testIdentifier = { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' };
        const onlineScope = presenceScope([testIdentifier]);
        const presenceUri = `/fhir/Patient?identifier=${encodeURIComponent(`${testIdentifier.system}|1`)}&_summary=count&_count=0`;
        await expectDenied(await request(target, presenceUri, onlineScope, {
            tokenHo: source, claims: presenceClaims('online-presence', testIdentifier)
        }), `${source}->${target} online presence`);

        const second = { ...testIdentifier, value: '2' };
        const batchScope = presenceScope([testIdentifier, second]);
        await expectRejected(await request(target, '/fhir/', batchScope, {
            tokenHo: source, method: 'POST', claims: presenceClaims('batch-presence', undefined, [testIdentifier, second]),
            body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry(testIdentifier), presenceEntry(second)] }
        }), `${source}->${target} batch presence`);
    }
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify({ scenarios: [{ id: 'hapi-authorized-results', status: 'pass', executed: true }] }));
    process.stdout.write('STRICT HAPI THREE-HO AUTHORIZATION MATRIX PASS\n');
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { runHo, runPresenceHo, runCountHo, request, localToken, expectDenied, expectRejected, presenceClaims };
