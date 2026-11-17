'use strict';
/** Cross-area Admin qualification: operation reachability and passive mounted context. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startAdminSourcesFixture } = require('../../../test-support/admin-sources-fixture');

test('Admin32 current operation census retains every original form owner and all rendered Help bindings', async t => {
    const fixture = await startAdminSourcesFixture(); t.after(() => fixture.close());
    const router = require('../src/routes/ui');
    const config = require('../src/team-config').loadTeamConfig();
    const sources = require('../src/data-sources').getConfiguredDataSources(config, { includeDisabled: true });
    const model = require('../src/routes/admin-source-model');
    const rows = model.sourceDirectory(sources, require('../src/data-operations').managedFhirServers(config));
    const queries = [
        ...require('../src/routes/admin-shell').areas.map(([section]) => ({ section })),
        ...['onboarding', 'defaults', 'workflows'].map(view => ({ section: 'sources', view })),
        ...rows.flatMap(source => source.tabs.map(view => ({ section: 'sources', source: source.id, view }))),
        ...sources.map(source => ({ section: 'security', source: source.id }))
    ];
    const vm = require('node:vm'), context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../shared/ui/help-copy.js'), 'utf8'), context);
    const copy = context.window.PCM_HELP_COPY, forms = [], help = new Set();
    for (const query of queries) {
        const html = router._test.renderAdminHtml({ query });
        for (const match of html.matchAll(/data-help-(?:key|disabled-key)="([^"]+)"/g)) {
            assert.ok(copy[match[1]]?.title && copy[match[1]]?.body, `${JSON.stringify(query)}: ${match[1]}`);
            help.add(match[1]);
        }
        for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)) {
            forms.push({ query, action: match[0].match(/action="([^"]+)"/)?.[1]?.split('?')[0].replace(/^\/pcm(?=\/admin)/, ''), method: match[0].match(/method="([^"]+)"/)?.[1] || 'get' });
        }
        assert.equal((html.match(/class="explain-toggle"/g) || []).length, 1);
        assert.doesNotMatch(html, /class="[^"]*(?:help-icon|help-gutter|explain-icon)/);
    }
    const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../test-support/fixtures/admin/form-parity.json')));
    // R8 intentionally replaces the refusing renewal POST form with passive instructions.
    // Its protected API refusal is covered by admin-certificates; no mutation capability is removed.
    const passiveReplacement = before => before.action === '/admin/certs/regenerate' && before.method === 'post';
    const missing = baseline.forms.filter(before => !passiveReplacement(before) && !forms.some(now => now.action === before.action && now.method === before.method));
    const certificates = router._test.renderAdminHtml({query:{section:'certificates'}});
    assert.match(certificates,/data-admin-toggle="certificate-renewal"/);
    assert.doesNotMatch(certificates,/<form[^>]*action="[^"]*certs\/regenerate/);
    assert.deepEqual(missing, [], 'A pre-redesign form must retain a reachable owner');
    assert.ok(fixture.unchanged());
    const audit = { queries, baselineInstances: baseline.forms.length, renderedInstances: forms.length, distinctActionMethods: [...new Set(forms.map(form => `${form.method} ${form.action}`))], missing, helpKeys: [...help].sort(), forms };
    if (process.env.PCM_ADMIN_QUALIFICATION_OUTPUT) fs.writeFileSync(process.env.PCM_ADMIN_QUALIFICATION_OUTPUT, JSON.stringify(audit, null, 2) + '\n');
});

test('Admin32 protected mounted views retain exact app/source links, stale/disabled context and passive state', async t => {
    const fixture = await startAdminSourcesFixture(); t.after(() => fixture.close());
    const source = fixture.config.healthOrganizations[1].dataSourceOrganization.id;
    const tokens = require('../src/store').tokens, beforeTokens = tokens.size;
    const registry = new (require('../src/data-operations').DataOperationRegistry)();
    const headers = { 'x-admin-password': fixture.password, Accept: 'text/html' };
    for (const section of ['overview', 'sources', 'security', 'apps', 'certificates', 'logs', 'maintenance']) {
        const response = await fetch(`${fixture.base}/admin?section=${section}&source=${source}`, { headers });
        assert.equal(response.status, 200); const html = await response.text();
        assert.match(html, new RegExp(`data-admin-section="${section}"[^>]*aria-current="page"`));
        assert.ok(html.includes(`/pcm/admin?section=certificates&amp;source=${source}`));
        for (const href of ['/pcm/ui', '/pcm/admin/services', '/pcm/logs-view', '/pcm/docs/admin-api']) assert.ok(html.includes(`href="${href}"`), `${section}: ${href}`);
        assert.match(html, /http:\/\/127\.0\.0\.1:13100\/doctor/);
        if (section === 'apps') {
            assert.match(html, /providerRole=serviceProvider/);
            assert.ok(html.includes(`owner=${fixture.config.organizations.serviceProvider.id}`));
            assert.ok(html.includes(`section=certificates&amp;source=${source}&amp;owner=${fixture.config.organizations.serviceProvider.id}`));
            assert.match(html, /separately deferred owner/);
        }
    }
    const certificates = await (await fetch(`${fixture.base}/admin?section=certificates&source=${source}&owner=${fixture.config.organizations.serviceProvider.id}`, { headers })).text();
    assert.ok(certificates.includes(`section=apps&amp;source=${source}#provider-serviceProvider`));
    assert.ok(certificates.includes('data-admin-toggle="certificate-renewal"'));
    assert.ok(certificates.includes(`name="source" value="${source}"`));
    for (const selected of [source, 'source-fourth-long']) {
        const html = await (await fetch(`${fixture.base}/admin?section=sources&source=${selected}&view=credentials`, { headers })).text();
        assert.ok(html.includes(`section=certificates&amp;source=${selected}&amp;owner=${selected}`));
    }
    for (const view of ['registration', 'trust', 'credentials', 'limits', 'diagnostics']) {
        const response = await fetch(`${fixture.base}/admin?section=sources&source=source-disabled&view=${view}`, { headers });
        assert.equal(response.status, 200); const html = await response.text();
        assert.match(html, /Disabled/); assert.match(html, /data-source-workspace="source-disabled"/);
        assert.doesNotMatch(html, /data-managed-fhir-server/);
    }
    const stale = await fetch(`${fixture.base}/admin?section=sources&source=removed-exact-source&view=data`, { headers });
    const staleHtml = await stale.text(); assert.match(staleHtml, /no longer configured/); assert.doesNotMatch(staleHtml, /data-source-workspace=/);
    const unauthenticated = await fetch(`${fixture.base}/admin?section=certificates&source=${source}&owner=${source}`, { headers: { Accept: 'text/html' } });
    assert.equal(unauthenticated.status, 401);
    const login = await unauthenticated.text();
    assert.ok(login.includes(`source=${source}&amp;owner=${source}`), login.match(/name="returnTo"[^>]+/)?.[0]);
    const destination = `/pcm/admin?section=certificates&source=${source}&owner=${source}`;
    const signed = await fetch(`${fixture.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ adminPassword: fixture.password, returnTo: destination }) });
    assert.equal(signed.status, 302); assert.equal(signed.headers.get('location'), destination);
    for (const [section, owner, retained] of [['certificates', 'removed:<exact>&owner', true], ['apps', source, false]]) {
        const response = await fetch(`${fixture.base}/admin?section=${section}&source=${source}&owner=${encodeURIComponent(owner)}&token=never`, { headers: { Accept: 'text/html' } });
        const returnTo = (await response.text()).match(/name="returnTo" value="([^"]+)"/)[1];
        assert.equal(returnTo.includes('owner='), retained); assert.ok(!returnTo.includes('token='));
        if (retained) assert.ok(returnTo.includes(encodeURIComponent(owner)));
    }
    assert.equal(tokens.size, beforeTokens); assert.deepEqual(registry.list(), []); assert.ok(fixture.unchanged());
});
