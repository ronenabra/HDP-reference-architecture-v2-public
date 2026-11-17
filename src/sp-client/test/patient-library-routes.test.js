'use strict';
/** Actual Doctor routes and the ordinary Contract/TLS source seam, using owned fixtures. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { SYSTEM, URI } = require('../../shared/sandbox-patients');

/** Wait for the fixture to observe one exact bounded source request without arbitrary sleeps. */
async function sampled(fixture, count) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (fixture.requests.filter(request => request.path.startsWith('/sample/')).length >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected source request not observed');
}

test('loaded/partial/empty/failed routes retain only current application/source generations and reject stale selection', async () => {
    const fixture = await require('../../../test-support/doctor-public-server').startDoctorPublicServer({ sampling: true });
    const post = (route, body) => fetch(fixture.doctorBase + '/patients/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'hospital-a', sourceId: 'ho-a', ...body }), redirect: 'manual' });
    try {
        const load = await post('load', {}), first = await load.json();
        assert.equal(load.status, 200, JSON.stringify(first)); assert.equal(first.patients.length, 3);
        assert.equal(first.patients[0].identifierType, 'Sandbox synthetic GUID');
        assert.equal(first.patients[2].display, 'Name unknown');
        assert.deepEqual(first.patients.map(patient => patient.birthDate), ['1985-03-12', '1985-03', undefined]);
        let html = await (await fetch(fixture.doctorBase + '/patients?identity=hospital-a')).text();
        const [offline, sample] = html.split('data-library-group="demo"')[1].split('data-library-group="sample"');
        assert.doesNotMatch(offline, /Ab123456/); assert.match(sample, /Ab123456/);
        assert.match(sample, /&lt;img src=x onerror=/); assert.doesNotMatch(sample, /<img/);
        assert.match(sample, new RegExp(`name="sampleGeneration" value="${first.generation}"`));
        html = await (await fetch(fixture.doctorBase + '/patients?identity=hospital-b')).text();
        assert.doesNotMatch(html, /Ab123456/);
        const selected = { patientId: `${SYSTEM}|${first.patients[0].idValue}`, sampleGeneration: first.generation };
        assert.equal((await post('select', selected)).status, 303);
        const other = await post('select', { ...selected, identity: 'hospital-b' }); assert.equal(other.status, 400);
        await post('source', { sourceId: 'ho-b' });
        assert.equal((await post('select', selected)).status, 400);
        fixture.state.sampleMode = 'partial';
        const partial = await (await post('load', { sourceId: 'ho-b' })).json();
        assert.equal(partial.state, 'partial'); assert.equal(partial.rejected, 2);
        fixture.state.sampleMode = 'empty';
        assert.equal((await (await post('load', {})).json()).state, 'empty');
        fixture.state.sampleMode = 'failed';
        assert.equal((await post('load', {})).status, 400);
        html = await (await fetch(fixture.doctorBase + '/patients?identity=hospital-a')).text();
        assert.match(html, /data-state="failed"/); assert.doesNotMatch(html, /Ab123456/);
        // A late successful source response cannot publish after source invalidation.
        fixture.state.sampleMode = 'loaded'; let release;
        fixture.state.sampleDelay = new Promise(resolve => { release = resolve; });
        const before = fixture.requests.filter(request => request.path.startsWith('/sample/')).length;
        const pending = post('load', {}); await sampled(fixture, before + 1);
        await post('source', { sourceId: 'ho-b', cancelled: true }); release();
        assert.equal((await pending).status, 400); fixture.state.sampleDelay = null;
        html = await (await fetch(fixture.doctorBase + '/patients?identity=hospital-a')).text();
        assert.match(html, /data-state="cancelled"/); assert.doesNotMatch(html, /Ab123456/);
        // A real configuration replacement invalidates cached rows and their posted selection.
        const latest = await (await post('load', {})).json();
        fixture.config.runtime = { ...fixture.config.runtime, revision: (fixture.config.runtime?.revision || 0) + 1 };
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
        assert.equal((await post('select', { ...selected, sampleGeneration: latest.generation })).status, 400);
        // Strict and no-source alternatives retain offline rows without requesting the source.
        const strict = require('../../../test-support/team-config').buildTeamConfig({}, 'strict');
        const config = { ...fixture.config, conformance: strict.conformance, security: strict.security, securitySimulation: strict.securitySimulation, legacyDataSource: strict.legacyDataSource };
        delete config.sandboxSampling;
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
        const count = fixture.requests.length;
        html = await (await fetch(fixture.doctorBase + '/patients?identity=hospital-a')).text();
        assert.match(html, /Unsupported: sampling is disabled in Strict/);
        assert.match(html, /Israel Israelov/); assert.equal((await post('load', {})).status, 400);
        assert.equal(fixture.requests.length, count);
        assert.ok(fixture.requests.filter(request => request.path.startsWith('/sample/')).every(request => '/fhir/Patient' + request.query === URI));
        assert.ok(fixture.requests.some(request => request.authorizationBasis === 'Contract' && request.requestedScope === 'system/Patient.s'));
        assert.equal(fixture.consents.size, 2); assert.deepEqual(fixture.violations, []);
    } finally { fixture.state.sampleDelay = null; await fixture.close(); }
});
