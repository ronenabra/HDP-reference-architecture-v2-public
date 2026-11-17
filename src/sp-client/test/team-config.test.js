const { buildTeamConfig } = require('../../../test-support/team-config');
/**
 * Tests for Doctor's Portal team config links.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

test('loads configured public PCM UI URL for cross-portal links', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-team-config-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;

    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        publicBaseUrls: {
            pcmUi: 'http://localhost:4999',
            spClient: 'http://localhost:3999'
        }
    })));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { loadPublicBaseUrls } = require('../src/team-config');

    const urls = loadPublicBaseUrls();
    assert.equal(urls.pcmUi, 'http://localhost:4999');
    assert.equal(urls.spClient, 'http://localhost:3999');
    assert.equal(urls.pcmApi, 'https://localhost:4101/api/fhir-service/r4');

    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('loads configured team id for visible page headers', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-team-name-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;

    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({ teamId: 'team-visible' })));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { loadTeamId } = require('../src/team-config');

    assert.equal(loadTeamId(), 'team-visible');

    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('offline patient choices exclude configured or cached inventory', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-team-patients-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;

    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        patients: [
            {
                idSystem: 'http://example.org/id',
                idValue: '000000018',
                display: 'Connectathon Test Patient'
            },
            { idSystem: 'urn:test', idValue: 'not-imported', display: 'configured-only' }
        ]
    })));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { choosePatientId, loadPatients } = require('../src/team-config');

    const patients = loadPatients();
    assert.deepEqual(patients, []);
    assert.equal(require('../src/team-config').loadManagedPatients, undefined);
    assert.equal(choosePatientId('', patients), '');
    assert.equal(choosePatientId('999999999', patients), '999999999');

    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('consent request bodies accept only pinned FHIR system value patient identifiers', () => {
    const client = require('../src/client');
    const body = client._test.buildConsentRequestBody(
        'http://hl7.org/fhir/sid/passport-USA|US-000000018',
        'service-1'
    );

    assert.deepEqual(body.patient.identifier, {
        system: 'http://hl7.org/fhir/sid/passport-USA',
        value: 'US-000000018'
    });
    assert.throws(() => client._test.buildConsentRequestBody('http://example.org/patient-id|000000018', 'service-1'), /passport identifier subset/);
});

test('doctor form submits one exact patient value and type from the shared choice/edit flow', () => {
    const ejs = require('ejs');
    const { ORDINARY, identifierTypes, patientChoice } = require('../src/patient-choice');
    const { FIXED } = require('../../shared/sandbox-patients');
    const client = require('../src/client');
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'index.ejs'), 'utf8');
    const config = buildTeamConfig();

    /** Render the actual request composer and keep its submitted controls separate from convenience choices. */
    const renderForm = (system, value) => {
        const html = ejs.render(view, {
            browserBase: '/doctor', teamId: 'patient-form', currentIdentity: 'hospital-a', identities: [{ id: 'hospital-a', label: 'Configured requester' }],
            publicBaseUrls: { pcmUi: 'http://pcm.test' }, flash: null, conformance: { resultLabel: 'Sandbox', warnings: [] },
            selectedPatientId: `${system}|${value}`, patients: [ORDINARY, ...FIXED], identifierTypes: identifierTypes(),
            selectedServiceId: 'owned-service', services: [{ id: 'owned-service', name: 'Owned service', signature: 'current', available: true }], consents: []
        });
        const form = html.match(/<form\b[^>]*action="\/doctor\/create-consent"[^>]*>[\s\S]*?<\/form>/)?.[0];
        assert.ok(form, 'the patient controls belong to the actual POST create form');
        assert.match(form, /method="POST"/);
        assert.equal((form.match(/\bname="patientId"/g) || []).length, 1);
        assert.equal((form.match(/\bname="patientSystem"/g) || []).length, 1);
        const input = form.match(/<input\b[^>]*\bname="patientId"[^>]*>/)?.[0];
        const types = form.match(/<select\b[^>]*\bid="patient-system"[^>]*>[\s\S]*?<\/select>/)?.[0];
        const systemInput = form.match(/<input\b[^>]*\bname="patientSystem"[^>]*>/)?.[0];
        const choice = form.match(/<select\b[^>]*\bid="configured-patient"[^>]*>[\s\S]*?<\/select>/)?.[0];
        assert.ok(input && types && choice && systemInput);
        assert.doesNotMatch(types.split('>')[0], /\bname=/, 'the type convenience picker cannot submit a stale duplicate system');
        assert.match(input, /type="text"/);
        assert.match(input, /\brequired\b/);
        assert.doesNotMatch(input, /\bdisabled\b|type="hidden"/);
        assert.doesNotMatch(choice.split('>')[0], /\bname=/, 'the convenience choice cannot submit an independent stale patient');
        assert.match(choice, /value="http:\/\/fhir.health.gov.il\/identifier\/il-national-id\|000000018"/);
        assert.match(choice, /value="http:\/\/fhir.health.gov.il\/identifier\/il-hdp-test-id\|2"/);
        for (const mode of ['choose', 'manual']) {
            const button = form.match(new RegExp('<button\\b[^>]*data-patient-mode="' + mode + '"[^>]*>'))?.[0];
            assert.ok(button); assert.match(button, /type="button"/, 'changing entry mode cannot submit a request');
        }
        assert.match(form, /<input[^>]*name="identity"[^>]*value="hospital-a"/);
        assert.match(form, /<button[^>]*type="submit"[^>]*data-request-consent/);
        const selected = types.match(/<option\b[^>]*\bselected[^>]*>/)?.[0];
        assert.ok(selected, 'the current identifier type is selected');
        return { value: /\bvalue="([^"]*)"/.exec(input)[1], system: /\bvalue="([^"]*)"/.exec(systemInput)[1] };
    };

    for (const [system, value] of [[ORDINARY.idSystem, '000000018'], ['http://hl7.org/fhir/sid/passport-USA', 'US-000000018'], [FIXED[1].idSystem, '2']]) {
        const submitted = renderForm(system, value);
        assert.deepEqual(submitted, { system, value }, 'rendering preserves exact type/value, including leading zeros');
        const selected = patientChoice(submitted.value, submitted.system, config);
        assert.deepEqual(client._test.buildConsentRequestBody(selected.key, 'owned-service').patient.identifier, { system, value });
    }
    const ordinary = renderForm(ORDINARY.idSystem, ORDINARY.idValue);
    assert.equal(patientChoice(`  ${ordinary.value}  `, ordinary.system, config).key, `${ordinary.system}|000000018`);
    assert.equal(patientChoice(`${ordinary.system}|${ordinary.value}`, FIXED[0].idSystem, config).key, `${ordinary.system}|000000018`, 'a full token keeps its explicit type');
    assert.throws(() => patientChoice(ordinary.value, FIXED[0].idSystem, config), /exactly 1 or 2/, 'changing type revalidates the same exact value');
    assert.throws(() => patientChoice('http://example.org/id|000000018', ordinary.system, config), /passport identifier subset/);

    // Keep the existing bounded-result landmark and keyboard access coverage.
    assert.match(view, /<section[^>]*aria-label="Fetched FHIR data"/);
    assert.match(view, /<details><summary>FHIR technical details<\/summary><pre[^>]*tabindex="0"/);
    assert.doesNotMatch(view, /datalist/);
    assert.doesNotMatch(view, /input-group/);
});
