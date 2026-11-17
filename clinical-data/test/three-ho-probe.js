'use strict';

const assert = require('node:assert/strict');

const credentials = {
    'ho-a': process.env.PCM_A_IMPORT_CREDENTIAL,
    'ho-b': process.env.PCM_B_IMPORT_CREDENTIAL,
    'ho-c': process.env.PCM_C_IMPORT_CREDENTIAL
};

async function request(ho, path, credential = credentials[ho]) {
    const response = await fetch(`https://${ho}-hapi:8080/fhir${path}`, {
        headers: {
            Accept: 'application/fhir+json',
            'X-PCM-Import-Credential': credential || ''
        }
    });
    let body = null;
    try { body = await response.json(); } catch (_error) { body = null; }
    return { response, body };
}

async function main() {
    const nextQueries = {};
    for (const ho of Object.keys(credentials)) {
        assert.ok(credentials[ho]?.length >= 32, `${ho} credential is not configured`);
        const result = await request(ho, '/Observation?_count=1');
        assert.equal(result.response.status, 200, `${ho} search status`);
        assert.equal(result.body.resourceType, 'Bundle');
        assert.equal(result.body.entry.length, 1);
        assert.match(result.body.entry[0].resource.id, new RegExp(`^observation-${ho}-`));
        const next = result.body.link?.find(link => link.relation === 'next')?.url;
        assert.ok(next, `${ho} must expose a native next page`);
        nextQueries[ho] = new URL(next).search;

        const own = await request(ho, `/Observation/observation-${ho}-0001`);
        assert.equal(own.response.status, 200);
        for (const other of Object.keys(credentials).filter(value => value !== ho)) {
            const resourceReuse = await request(other, `/Observation/observation-${ho}-0001`);
            assert.equal(resourceReuse.response.status, 404, `${ho} resource leaked into ${other}`);
            const credentialReuse = await request(other, '/Observation?_count=1', credentials[ho]);
            assert.equal(credentialReuse.response.status, 403, `${ho} credential crossed into ${other}`);
        }
    }

    const crossedCursor = await request('ho-b', nextQueries['ho-a']);
    assert.notEqual(crossedCursor.response.status, 200, 'HO A native page cursor crossed into HO B');
    process.stdout.write('PASS three-HO private resource, credential, and native-cursor isolation\n');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
