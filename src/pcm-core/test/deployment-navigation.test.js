'use strict';

/** Exact API bases remain copyable while diagnostic navigation follows listener contracts. */
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const router = require('../src/routes/ui');

test('non-default deployment links use supported paths and disable stale placeholder sources', () => {
    config.publicBaseUrls.spClient = 'http://localhost:13100';
    config.publicBaseUrls.pcmUi = 'http://localhost:14100';
    config.publicBaseUrls.pcmApi = 'https://localhost:14101/api/fhir-service/r4';
    config.publicBaseUrls.pcmMetadata = 'https://localhost:14102/api/fhir-service/r4';
    config.publicBaseUrls.dataSourceMetadata = 'http://localhost:18184';
    config.organizations.teamDataSource.enabled = false;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    const endpoints = router._test.buildDeploymentEndpoints();
    assert.equal(endpoints.find(item => item.key === 'pcmApi').url, 'https://localhost:14101/api/fhir-service/r4');
    assert.equal(endpoints.find(item => item.key === 'pcmApi').diagnosticUrl, 'https://localhost:14101/api/fhir-service/r4/metadata');
    assert.equal(endpoints.find(item => item.key === 'dataSourceMetadata').diagnosticUrl, 'http://localhost:18184/.well-known/oauth-authorization-server');
    const disabled = endpoints.find(item => item.key === 'teamDataSource');
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.diagnosticUrl, null);
    const html = router._test.renderAdminHtml();
    assert.ok(html.includes('>https://localhost:14101/api/fhir-service/r4</code>'));
    assert.ok(!html.includes(`href="${config.publicBaseUrls.teamDataSource}"`));
});


test('request-free Admin fixture renders current institution forms without invented save feedback', () => {
    const html = require('../src/routes/ui')._test.renderAdminHtml({ query: { section: 'sources', source: config.healthOrganizations[0].dataSourceOrganization.id, view: 'registration' } });
    assert.match(html, /name="institutionType"/);
    assert.doesNotMatch(html, /Institution type saved\./);
});

test('mounted Admin keeps browser forms, assets and observed links under its own UI path', () => {
    const before = structuredClone(config);
    config.publicBaseUrls.pcmUi = 'http://localhost:14100/pcm';
    config.publicBaseUrls.spClient = 'http://localhost:13100/doctor';
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    const req = { protocol: 'http', socket: { remoteAddress: '127.0.0.1' }, app: { get: () => () => false }, get: key => key === 'host' ? 'reachable.test:14100' : undefined };
    const html = router._test.renderAdminHtml({ ...req, query: { section: 'sources', view: 'onboarding' } });
    assert.match(html, /action="\/pcm\/admin\/config\/data-sources\/add"/);
    assert.match(html, /src="\/pcm\/assets\/help.js"/);
    assert.match(html, /data-browser-base="\/pcm"/);
    assert.match(html, /href="http:\/\/reachable.test:13100\/doctor"/);
    const endpoints = router._test.buildDeploymentEndpoints(req);
    assert.equal(endpoints.find(row => row.key === 'pcmUi').url, 'http://localhost:14100/pcm');
    assert.equal(endpoints.find(row => row.key === 'spClient').url, 'http://localhost:13100/doctor');
    assert.equal(endpoints.find(row => row.key === 'spClient').diagnosticUrl, 'http://reachable.test:13100/doctor');
    assert.deepEqual(config.contract, before.contract); assert.deepEqual(config.healthOrganizations, before.healthOrganizations);
    assert.deepEqual(config.organizations.serviceProvider.redirectUris, before.organizations.serviceProvider.redirectUris);
});
