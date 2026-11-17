'use strict';
/** Actual TLS Doctor → PCM browser approval → exact callback → confidential code exchange in every preset. */
const test = require('node:test'), assert = require('node:assert/strict'), https = require('node:https'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { startRuntime } = require('../../../test-support/pcm-042-runtime');
/** Trust the disposable server CA; browser requests carry no confidential client key. */
function browser(url, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, { ca: fs.readFileSync(path.join(process.env.CERTS_DIR, 'rootCA.crt')), method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } }, response => {
            let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
        }); request.on('error', reject); request.end(body);
    });
}
test('real code exchange retains exact callback, PKCE and client with no token before explicit approval in all presets', async t => {
    const runtime = await startRuntime(); t.after(() => runtime.close()); await require('../../../src/pcm-core/src/bootstrap')();
    const exchanges = [];
    runtime.api.on('request', (req, res) => {
        if (req.method !== 'POST' || !req.url.endsWith('/token')) return;
        let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
            const form = new URLSearchParams(body); if (form.get('grant_type') !== 'authorization_code') return;
            const row = { redirect: form.get('redirect_uri'), verifierHash: crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') };
            exchanges.push(row); res.once('finish', () => { row.status = res.statusCode; });
        });
    });
    // Exercise the protected reviewed address update before the ordinary callback round trip.
    const proposedBase = runtime.doctorBase.replace('localhost', '127.0.0.1');
    const adminHeaders = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Accept: 'application/json', 'Content-Type': 'application/json' };
    const previewResponse = await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/config/doctor-browser/preview`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ doctorBase: proposedBase }) });
    assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
    const applied = await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/config/doctor-browser/apply`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ doctorBase: proposedBase, reviewDigest: preview.reviewDigest }) });
    assert.equal(applied.status, 200); assert.equal((await applied.json()).restartPendingTests, true);
    runtime.doctorBase = proposedBase; Object.assign(runtime.config, require('../../../src/pcm-core/src/team-config').loadTeamConfig());
    const before = require('../../../src/pcm-core/src/fhir/store').getAll('Consent');
    const states = new Set(), challenges = new Set();
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        runtime.preset(preset);
        const start = await browser(`${runtime.doctorBase}/smart/start?identity=hospital-a&scope=patient%2FObservation.rs`);
        assert.equal(start.status, 302, preset); const authorization = new URL(start.headers.location), cookie = start.headers['set-cookie'][0].split(';')[0];
        assert.equal(authorization.searchParams.get('redirect_uri'), `${runtime.doctorBase}/callback`);
        assert.equal(authorization.searchParams.get('aud'), runtime.endpoints.fhirBase); assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.ok(!states.has(authorization.searchParams.get('state'))); states.add(authorization.searchParams.get('state'));
        assert.ok(!challenges.has(authorization.searchParams.get('code_challenge'))); challenges.add(authorization.searchParams.get('code_challenge'));
        const page = await browser(authorization.toString()); assert.equal(page.status, 200);
        const transaction = /name="transaction_id" value="([^"]+)"/.exec(page.text)[1], count = exchanges.length;
        assert.equal(count, states.size - 1, 'no authorization-code token before a decision');
        const decision = await browser(`${runtime.apiBase}/authorize/decision`, { cookie: page.headers['set-cookie'][0].split(';')[0], body: new URLSearchParams({ transaction_id: transaction, patient: 'configured-patient-1', decision: 'approve', approved_scope: 'patient/Observation.rs' }).toString() });
        assert.equal(decision.status, 302); const callback = new URL(decision.headers.location); assert.equal(callback.origin + callback.pathname, `${runtime.doctorBase}/callback`);
        const wrongBrowser = await browser(callback.toString()); assert.equal(wrongBrowser.status, 302); assert.equal(exchanges.length, count);
        const result = await browser(callback.toString(), { cookie }); assert.equal(result.status, 302); assert.equal(exchanges.length, count + 1);
        assert.equal(exchanges.at(-1).redirect, authorization.searchParams.get('redirect_uri')); assert.equal(exchanges.at(-1).verifierHash, authorization.searchParams.get('code_challenge')); assert.equal(exchanges.at(-1).status, 200, preset);
        const completed = await browser(`${runtime.doctorBase}${result.headers.location}`, { cookie }); assert.match(completed.text, /SMART code exchange completed/);
        await browser(callback.toString(), { cookie }); assert.equal(exchanges.length, count + 1, 'callback replay cannot exchange again');
    }
    assert.deepEqual(require('../../../src/pcm-core/src/fhir/store').getAll('Consent'), before, 'protocol test creates no clinical Consent');
});
