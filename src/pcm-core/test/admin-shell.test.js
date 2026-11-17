'use strict';
/** Server-rendered area/return contracts and passive authenticated navigation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime({ publicBaseUrls: { pcmUi: 'http://localhost:14100/pcm', spClient: 'http://localhost:13100/doctor' } });
const shell = require('../src/routes/admin-shell');
const router = require('../src/routes/ui');
const request = section => ({ query: { section }, protocol: 'http', get: key => key === 'host' ? 'reachable.test:14100' : undefined });

test('stable area/source addresses, escaped unknown sources and safe local returns', () => {
    assert.equal(shell.address('/pcm', 'sources', 'source:x/y'), '/pcm/admin?section=sources&source=source%3Ax%2Fy');
    for (const value of ['https://outside.test/admin', '//outside.test/admin', '/other/admin', '/pcm/admin/evil', '/pcm/admin\\evil', 'javascript:alert(1)']) {
        assert.equal(shell.safeReturn(value, '/pcm'), '/pcm/admin?section=overview');
    }
    assert.equal(shell.safeReturn('/pcm/admin?section=sources&source=ho-a&token=never', '/pcm'), '/pcm/admin?section=sources&source=ho-a');
    const sources = [{ id: 'ho-a' }];
    assert.deepEqual(shell.sectionState({ query: { section: 'sources', source: 'ho-a' } }, sources), { selected: 'sources', source: 'ho-a', error: '' });
    assert.equal(shell.sectionState({ query: { section: 'unknown' } }, sources).selected, 'overview');
    assert.match(shell.sectionState({ query: { source: 'removed' } }, sources).error, /no longer configured/);
    const html = router._test.renderAdminHtml({ query: { section: 'sources', source: '<script>stale</script>' } });
    assert.match(html, /no longer configured/); assert.doesNotMatch(html, /<script>stale/);
});

test('each selected area renders one editor owner and full common navigation', () => {
    const expectations = { overview: 'data-exact-address', sources: 'data-source-address', security: 'data-simulation-form', apps: 'Configured provider/application inventory', certificates: 'data-admin-toggle="certificate-renewal"', logs: '/admin/logs/clear', maintenance: '/admin/restore' };
    for (const [section, content] of Object.entries(expectations)) {
        const html = router._test.renderAdminHtml(request(section));
        assert.ok(html.includes(content), section);
        assert.equal((html.match(/data-admin-section=/g) || []).length, 7);
        assert.equal((html.match(/class="explain-toggle"/g) || []).length, 1);
        assert.match(html, new RegExp(`data-admin-section="${section}"[^>]+aria-current="page"`));
        assert.match(html, /href="\/pcm\/admin\/services"/);
        assert.match(html, /href="http:\/\/reachable.test:13100\/doctor"/);
        if (section !== 'sources') assert.doesNotMatch(html, /data-async-operation/);
        if (section !== 'security') assert.doesNotMatch(html, /data-simulation-form/);
    }
});

test('exact configured bases, issuer/callbacks, non-browser internal addresses and honest state', () => {
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    const html = router._test.renderAdminHtml(request('overview'));
    assert.match(html, /http:\/\/localhost:14100\/pcm<\/code>/);
    assert.match(html, /http:\/\/reachable.test:14100\/pcm\/ui/);
    assert.match(html, /Internal — not browser-routable/);
    assert.match(html, /Running revision: unknown/);
    assert.match(html, /Saved configuration revision/);
    assert.ok(html.includes(config.contract.operational.oauthBase));
    const apps = router._test.renderAdminHtml(request('apps'));
    for (const uri of config.organizations.serviceProvider.redirectUris) assert.ok(apps.includes(uri));
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
});

test('unauthorized mounted navigation, login return, GET purity, legacy and result routes', async t => {
    process.env.TEAM_ADMIN_PASSWORD = 'admin22-owned-only';
    const express = require('express');
    const inner = require('../src/index').createUiApp();
    const app = express(); app.use('/pcm', inner);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { delete process.env.TEAM_ADMIN_PASSWORD; inner.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/pcm`;
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    const unauthorized = await fetch(`${base}/admin?section=sources&source=org-team-a-ho-b-source`, { headers: { Accept: 'text/html' } });
    assert.equal(unauthorized.status, 401); const login = await unauthorized.text();
    assert.match(login, /name="returnTo" value="\/pcm\/admin\?section=sources&amp;source=org-team-a-ho-b-source"/);
    assert.match(login, /aria-label="Admin header"/); assert.match(login, /Explain this page/);
    assert.equal((await fetch(`${base}/admin/status`)).status, 401);
    const signed = await fetch(`${base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ adminPassword: process.env.TEAM_ADMIN_PASSWORD, returnTo: '/pcm/admin?section=sources&source=org-team-a-ho-b-source' }) });
    assert.equal(signed.headers.get('location'), '/pcm/admin?section=sources&source=org-team-a-ho-b-source');
    assert.match(signed.headers.get('set-cookie'), /Path=\/pcm\/admin; HttpOnly; SameSite=Strict/);
    const headers = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Accept: 'text/html' };
    const tokenCount = require('../src/store').tokens.size;
    for (const [section] of shell.areas) assert.equal((await fetch(`${base}/admin?section=${section}`, { headers })).status, 200);
    const legacy = await fetch(`${base}/admin/logs/view?operationId=owned22&target=ho-a`, { headers });
    assert.equal(legacy.status, 200); const diagnostics = await legacy.text();
    assert.match(diagnostics, /Admin header/); assert.match(diagnostics, /operationId=owned22/);
    const invalidDiagnostic = await fetch(`${base}/admin/logs/view?since=invalid`, {headers});
    assert.equal(invalidDiagnostic.status,200);const invalidHtml=await invalidDiagnostic.text();
    assert.match(invalidHtml,/cannot preserve these legacy constraints: since/);assert.match(invalidHtml,/href="\/pcm\/admin\?section=logs"/);
    const renewal = await fetch(`${base}/admin/certs/regenerate`, { method: 'POST', headers });
    assert.equal(renewal.status, 409); const refusal = await renewal.text();
    assert.match(refusal, /No credentials were changed/); assert.match(refusal, /data-admin-section="certificates"[^>]+aria-current/);
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
    assert.equal(require('../src/store').tokens.size, tokenCount);
    assert.deepEqual(new (require('../src/data-operations').DataOperationRegistry)().list(), []);
});

test('moved legacy field saves only its ownership and old form endpoints return to owner', () => {
    const configFile = process.env.TEAM_CONFIG_PATH;
    const saved = JSON.parse(fs.readFileSync(configFile));
    const handler = router.stack.find(layer => layer.route?.path === '/admin/config/security').route.stack[0].handle;
    const response = { code: 200, status(code) { this.code = code; return this; }, format(types) { types.json(); }, json(value) { this.value = value; }, send(value) { this.value = value; } };
    handler({ body: { adminForm: 'legacy-upstream', expectedRevision: saved.runtime.revision || 0, dsGatewayToFhirServerCustomUrl: 'http://legacy-upstream.test:8088/fhir', pcmApiClientAuth: 'mtls', accessTokenExpiresInSeconds: '1' }, get: () => 'application/json' }, response);
    assert.equal(response.code, 200);
    const next = JSON.parse(fs.readFileSync(configFile));
    assert.equal(next.security.dsGatewayToFhirServer.customUrl, 'http://legacy-upstream.test:8088/fhir');
    assert.deepEqual(next.security.pcmApi, saved.security.pcmApi);
    assert.equal(next.security.dsFhirServer.enforceMappedPatients, saved.security.dsFhirServer.enforceMappedPatients);
    const after = fs.readFileSync(configFile);
    handler({ body: { adminForm: 'legacy-upstream', expectedRevision: -1, dsGatewayToFhirServerCustomUrl: '' }, get: () => 'application/json' }, response);
    assert.equal(response.code, 409); assert.deepEqual(fs.readFileSync(configFile), after);
    fs.writeFileSync(configFile, JSON.stringify(saved));
});

/** Transport facts follow the effective source policy in every supported preset. */
test('deployment transport and disabled diagnostics preserve all-preset and proxy identities', () => {
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    for (const preset of ['connectathon-easy','connectathon-balanced','connectathon-mtls','strict']) {
        const candidate = require('../../../test-support/team-config').buildTeamConfig({}, preset);
        candidate.securitySimulation.global = {}; // Effective preset defaults, as in generated configurations.
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(candidate));
        const rows = router._test.buildDeploymentEndpoints(request('overview'));
        const pcm = rows.find(row => row.key === 'pcmApi'), metadata = rows.find(row => row.key === 'pcmMetadata');
        const expected = candidate.security.pcmApi.clientAuth === 'mtls';
        assert.equal(pcm.transport.includes('mTLS'), expected); assert.equal(metadata.transport.includes('mTLS'), expected);
        assert.equal(pcm.url, candidate.publicBaseUrls.pcmApi);
        assert.match(pcm.diagnosticUrl, /reachable.test/);
        assert.equal(rows.find(row => row.key === 'legacyGatewayPublic').enabled, preset !== 'strict');
        if(preset === 'strict') assert.equal(rows.find(row => row.key === 'legacyGatewayPublic').diagnosticUrl, null);
        if(preset === 'connectathon-mtls') assert.match(rows.find(row => row.key === 'legacyGatewayPublic').transport, /mTLS/);
    }
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, before);
});

/** Failure responses retain only values the exact visible editor owns. */
test('validation HTML preserves non-secret drafts without echoing credentials or another form', () => {
    const options = { adminError: { message: 'Correct the source URL.', statusCode: 400 } };
    const html = router._test.renderAdminHtml({ path: '/admin/config/data-sources/add', body: {
        name: '<script>draft</script>', endpoint: 'invalid-source-url', clientId: 'opaque-draft-client',
        serverTrustMode: 'pinned-thumbprint', adminPassword: 'never-echo-password', backupJson: 'never-echo-backup', pcmClientAuthKeyFile: 'never-echo-key'
    } }, options);
    assert.match(html, /value="&lt;script&gt;draft&lt;\/script&gt;"/);
    assert.match(html, /value="invalid-source-url"/);assert.match(html, /value="opaque-draft-client"/);
    assert.doesNotMatch(html, /<script>draft|never-echo/);
    assert.match(html, /value="upload" selected/);
    const other = router._test.renderAdminHtml({path:'/admin/config/identity-mapping/add',body:{name:'wrong-owner-draft',businessId:'0001',internalId:'Patient/local-0001'}},options);
    assert.doesNotMatch(other,/wrong-owner-draft/);assert.match(other,/value="0001"/);
    const value = require('../src/routes/admin-draft').draftValue;
    assert.equal(value({path:'/owned',body:{adminPassword:'never'}},options,'/owned','adminPassword','fallback'),'fallback');
});

/** Diagnostic navigation uses a known gateway route without discarding proxy mounts. */
test('source browser diagnostics preserve configured prefixes and exact copied bases', () => {
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    const candidate = JSON.parse(before);candidate.publicBaseUrls.healthOrganizations['ho-a']='https://localhost:8180/owned/source/fhir';
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH,JSON.stringify(candidate));
    const row=router._test.buildDeploymentEndpoints(request('overview')).find(row=>row.key==='ho-aGatewayPublic');
    assert.equal(row.url,'https://localhost:8180/owned/source/fhir');
    assert.equal(row.diagnosticUrl,'https://reachable.test:8180/owned/source/healthz');
    candidate.publicBaseUrls.healthOrganizations['ho-a']='https://external-source.test/custom-clinical';
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH,JSON.stringify(candidate));
    assert.equal(router._test.buildDeploymentEndpoints(request('overview')).find(row=>row.key==='ho-aGatewayPublic').diagnosticUrl,null);
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH,before);
});
