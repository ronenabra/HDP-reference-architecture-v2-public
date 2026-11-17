'use strict';
/** Real Doctor HTTP routes with an isolated protocol exchange double: cookie binding and one-use boundaries. */
const test = require('node:test'), assert = require('node:assert/strict');
const { installTestRuntime } = require('../../../test-support/team-config');
const { createAuthorizationTransaction } = require('../src/smart-authorization');

test('Doctor callbacks require the original browser, retain private identity and cannot replay or extend expiry', async t => {
    const config = installTestRuntime(), clientPath = require.resolve('../src/client'), previous = require.cache[clientPath];
    let exchanges = 0, expired = false, chosenIdentity;
    require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: {
        beginSmartAuthorization: async () => createAuthorizationTransaction({ authorizationEndpoint: 'https://pcm.example.test/authorize', clientId: config.organizations.serviceProvider.clientId,
            redirectUri: config.organizations.serviceProvider.redirectUri, audience: config.contract.operational.fhirBase, scope: 'patient/*.rs', ...(expired ? { clock: () => Date.now() - 600000 } : {}) }),
        exchangeSmartAuthorization: async (transaction, query, identity) => { exchanges++; chosenIdentity = identity; assert.equal(transaction.redirectUri, config.organizations.serviceProvider.redirectUri); assert.equal(query.code, 'owned-code'); return { scope: 'patient/*.rs' }; }
    } };
    delete require.cache[require.resolve('../src/index')];
    const { app } = require('../src/index'), server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); if (previous) require.cache[clientPath] = previous; else delete require.cache[clientPath]; });
    const root = `http://127.0.0.1:${server.address().port}`;
    const start = async cookie => {
        const response = await fetch(`${root}/smart/start?identity=hospital-a`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
        assert.equal(response.status, 302); const header = response.headers.get('set-cookie'); assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/);
        return { state: new URL(response.headers.get('location')).searchParams.get('state'), cookie: header.split(';')[0] };
    };
    const first = await start();
    const callback = (state, cookie, identity = '') => fetch(`${root}/callback?state=${state}&code=owned-code${identity}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
    assert.equal((await callback(first.state)).status, 302); assert.equal(exchanges, 0, 'another browser cannot consume state');
    assert.equal((await callback('invented-state', first.cookie)).status, 302); assert.equal(exchanges, 0);
    await callback(first.state, first.cookie, '&identity=hospital-b'); assert.equal(exchanges, 1); assert.equal(chosenIdentity, 'hospital-a', 'query identity cannot replace private owner');
    await callback(first.state, first.cookie); assert.equal(exchanges, 1, 'atomic one-use map boundary');
    const second = await start(first.cookie); assert.equal(second.cookie, first.cookie, 'concurrent tabs keep the browser binding but fresh protocol state'); assert.notEqual(second.state, first.state);
    expired = true; const old = await start(first.cookie); await callback(old.state, old.cookie); assert.equal(exchanges, 1, 'cookie refresh never extends a request');
    await callback(second.state, second.cookie); assert.equal(exchanges, 2);
});
