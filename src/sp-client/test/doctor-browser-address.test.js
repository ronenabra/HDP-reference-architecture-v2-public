'use strict';
/** Exact callback selection on supported origins, with no Host-driven registrations. */
const test = require('node:test'), assert = require('node:assert/strict');
const { doctorBrowserBase, doctorCallback, selectDoctorCallback, withDoctorBrowserAddress } = require('../../shared/doctor-browser-address');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { smartBrowserBinding, smartBrowserHash } = require('../src/smart-authorization');
const req = (host, protocol = 'http', trusted = false, forwarded) => ({ protocol, socket: { remoteAddress: '127.0.0.1' }, app: { get: () => () => trusted }, get: key => ({ host, 'x-forwarded-host': forwarded })[key] });
for (const base of ['http://localhost:13100', 'http://192.0.2.10:13100', 'https://doctor.example.test:9443/app/', 'http://[2001:db8::1]:13100/doctor']) test(`canonical callback derives exactly from ${base}`, () => {
    const config = withDoctorBrowserAddress(buildTeamConfig(), base), organization = config.organizations.serviceProvider;
    const before = JSON.stringify(config), url = new URL(base);
    assert.equal(organization.redirectUri, `${doctorBrowserBase(base)}/callback`);
    assert.equal(selectDoctorCallback(config, organization, req(url.host, url.protocol.slice(0, -1))), doctorCallback(base));
    assert.throws(() => selectDoctorCallback(config, organization, req('unregistered.test:13100')), /no matching registered/);
    assert.equal(JSON.stringify(config), before, 'selection never registers request metadata');
});
test('unsupported entry gets only a configured/registered canonical link; explicit alternatives stay byte exact', () => {
    const config = withDoctorBrowserAddress(buildTeamConfig(), 'http://doctor.example.test:13100/app');
    const org = config.organizations.serviceProvider;
    assert.throws(() => selectDoctorCallback(config, org, req('127.0.0.1:13100')), error => error.canonicalBase === 'http://doctor.example.test:13100/app');
    org.redirectUris.push('http://127.0.0.1:13100/app/callback');
    assert.equal(selectDoctorCallback(config, org, req('127.0.0.1:13100')), org.redirectUris[1]);
    assert.throws(() => selectDoctorCallback(config, org, req('spoof.test:13100', 'http', false, 'doctor.example.test:13100')));
    assert.equal(selectDoctorCallback(config, org, req('internal:3000', 'http', true, 'doctor.example.test:13100')), org.redirectUris[0]);
    org.redirectUris = ['http://other.test/callback'];
    assert.throws(() => selectDoctorCallback(config, org, req('127.0.0.1:13100')), error => !error.canonicalBase);
});
test('bases reject credentials/query/fragment and migration preserves role identity, scopes, certificates and unrelated data', () => {
    for (const base of ['javascript:alert(1)', 'https://user:secret@doctor.test', 'http://doctor.test/app?q=1', 'http://doctor.test/app#x']) assert.throws(() => doctorBrowserBase(base));
    const config = buildTeamConfig(), next = withDoctorBrowserAddress(config, 'http://doctor.test:13100/app');
    for (const key of ['contract', 'healthOrganizations', 'oauthClients', 'certificateRoles']) assert.deepEqual(next[key], config[key]);
    assert.deepEqual(next.organizations.hospitalBServiceProvider, config.organizations.hospitalBServiceProvider, 'disabled SMART profile is not enabled');
    assert.equal(next.organizations.serviceProvider.clientId, config.organizations.serviceProvider.clientId);
    assert.deepEqual(next.organizations.serviceProvider.smartScopes, config.organizations.serviceProvider.smartScopes);
});
test('browser binding is an opaque cookie, never a supplied identity or URL parameter', () => {
    const binding = 'A'.repeat(43);
    assert.equal(smartBrowserBinding({ headers: { cookie: `other=x; pcmDoctorSmartBrowser=${binding}` } }), binding);
    assert.equal(smartBrowserBinding({ query: { pcmDoctorSmartBrowser: binding }, headers: {} }), null);
    assert.equal(smartBrowserBinding({ headers: { cookie: 'pcmDoctorSmartBrowser=bad' } }), null);
    assert.notEqual(smartBrowserHash(binding), smartBrowserHash('B'.repeat(43))); assert.equal(smartBrowserHash(null), null);
});
