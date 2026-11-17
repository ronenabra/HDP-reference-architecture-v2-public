'use strict';

/** Verify browser ownership fencing and real-response cancellation checks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { cancellationProof, installOwnedSmartCancellation } = require('../ui/tests/helpers/owned-smart-cancellation');
const callback = 'http://foreign.test/callback';
const location = `${callback}?error=access_denied&state=owned-state`;

test('real upstream denial must bind status, registered callback and original state', () => {
    assert.equal(cancellationProof(302, { location }, callback, 'owned-state').stateMatched, true);
    for (const [status, target] of [[200, location], [302, location.replace('foreign.test', 'wrong.test')],
        [302, location.replace('/callback?', '/other?')], [302, location.replace('owned-state', 'other')],
        [302, location.replace('access_denied', 'invalid_request')], [302, `${location}&code=unwanted`],
        [302, `${location}&access_token=unwanted`]]) {
        assert.throws(() => cancellationProof(status, { location: target }, callback, 'owned-state'));
    }
    assert.throws(() => cancellationProof(302, {}, callback, 'owned-state'));
});

/** Expose only transport events, never credentials, from a controlled route. */
function routeFixture(url, { method = 'POST', body = 'decision=cancel', status = 302, redirect = location, navigation = true } = {}) {
    const events = [];
    return { events, route: {
        request: () => ({ url: () => url, method: () => method, postData: () => body, isNavigationRequest: () => navigation }),
        abort: async reason => events.push(['abort', reason]),
        continue: async () => events.push(['continue']),
        fetch: async options => {
            events.push(['fetch', options]);
            return { status: () => status, headers: () => ({ location: redirect }), dispose: async () => events.push(['dispose']) };
        },
        fulfill: async response => events.push(['fulfill', response.status])
    } };
}

test('guard is context-wide, blocks every foreign path and permits owned ordinary navigation', async () => {
    let handler;
    const context = { route: async (pattern, value) => { assert.equal(pattern, '**/*'); handler = value; } };
    const guard = await installOwnedSmartCancellation(context, { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://owned.test/decision' });
    for (const pathname of ['/callback', '/', '/favicon.ico']) {
        const f = routeFixture(`http://foreign.test${pathname}`, { method: 'GET' });
        await handler(f.route); assert.deepEqual(f.events, [['abort', 'failed']]);
    }
    assert.equal(guard.blocked.length, 3);
    const owned = routeFixture('http://owned.test/start', { method: 'GET', status: 200 });
    await handler(owned.route); assert.deepEqual(owned.events, [['fetch', { maxRedirects: 0 }], ['fulfill', undefined], ['dispose']]);
    await assert.rejects(installOwnedSmartCancellation(context, { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://foreign.test/decision' }), /owned fixture/);
});

test('native cancel forwards with zero redirects and distinguishes actual 302 from local 200 acknowledgement', async () => {
    let handler;
    const guard = await installOwnedSmartCancellation({ route: async (_, value) => { handler = value; } },
        { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://owned.test/decision' });
    assert.throws(() => guard.expectCancellation(callback, ''), /nonempty/);
    const result = guard.expectCancellation(callback, 'owned-state');
    const f = routeFixture('http://owned.test/decision'); await handler(f.route);
    assert.deepEqual(f.events, [['fetch', { maxRedirects: 0 }], ['fulfill', 200], ['dispose']]);
    assert.equal((await result).upstreamStatus, 302);
    assert.equal((await result).browserAcknowledgementStatus, 200);
    assert.deepEqual(guard.blocked, []);
});

test('missing expected submission, wrong native decision and server failures abort rather than acknowledge', async () => {
    for (const options of [{ unset: true }, { body: 'decision=approve' }, { status: 500 }]) {
        let handler;
        const guard = await installOwnedSmartCancellation({ route: async (_, value) => { handler = value; } },
            { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://owned.test/decision' });
        const result = options.unset ? null : guard.expectCancellation(callback, 'owned-state');
        const f = routeFixture('http://owned.test/decision', options); await handler(f.route);
        if (result) await assert.rejects(result);
        assert.equal(f.events.some(event => event[0] === 'fulfill'), false);
        assert.equal(f.events.some(event => event[0] === 'abort'), true);
    }
});


test('each owned redirect is fetched without following and foreign redirects fail before dispatch', async () => {
    for (const pathname of ['/start-direct', '/authorize?state=owned-state', '/start-via-authorize']) {
        let handler;
        const guard = await installOwnedSmartCancellation({ route: async (_, value) => { handler = value; } },
            { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://owned.test/decision' });
        if (pathname === '/start-via-authorize') {
            const first = routeFixture(`http://owned.test${pathname}`, { method: 'GET', redirect: '/authorize?state=owned-state' });
            await handler(first.route);
            assert.deepEqual(first.events, [['fetch', { maxRedirects: 0 }], ['fulfill', 200], ['dispose']]);
        }
        const redirected = routeFixture(`http://owned.test${pathname === '/start-via-authorize' ? '/authorize' : pathname}`,
            { method: 'GET', redirect: location.replace('access_denied', 'invalid_scope') });
        await handler(redirected.route);
        assert.deepEqual(redirected.events, [['fetch', { maxRedirects: 0 }], ['abort', 'failed'], ['dispose']]);
        assert.equal(guard.blocked.length, 1);
        assert.throws(() => guard.assertSafe(), /redirect to unowned origin blocked before dispatch/);
        await assert.rejects(guard.expectCancellation(callback, 'owned-state'), /before dispatch/);
    }
});

test('owned navigation redirects are separate guarded requests and unsupported redirects fail closed', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
        let handler;
        const guard = await installOwnedSmartCancellation({ route: async (_, value) => { handler = value; } },
            { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://owned.test/decision' });
        let fulfilled;
        const first = routeFixture('http://owned.test/start', { method: 'GET', status, redirect: '/authorize?state=owned-state' });
        first.route.fulfill = async response => { fulfilled = response; };
        await handler(first.route);
        assert.equal(fulfilled.status, 200);
        assert.match(fulfilled.body, /location.replace/);
        assert.equal(guard.ownedNavigationHops[0].upstreamStatus, status);
        const final = routeFixture('http://owned.test/authorize?state=owned-state', { method: 'GET', status: 200 });
        await handler(final.route);
        guard.assertSafe();
        assert.equal(guard.blocked.length, 0);
    }
    for (const options of [{ method: 'POST' }, { method: 'GET', navigation: false }, { method: 'GET', redirect: 'data:text/html,unsafe' }, { method: 'GET', redirect: '' }]) {
        let handler;
        const guard = await installOwnedSmartCancellation({ route: async (_, value) => { handler = value; } },
            { allowedOrigins: ['http://owned.test'], decisionUrl: 'http://owned.test/decision' });
        const f = routeFixture('http://owned.test/start', { redirect: '/authorize', ...options });
        await handler(f.route);
        assert.equal(f.events.some(event => event[0] === 'fulfill'), false);
        assert.throws(() => guard.assertSafe());
    }
});
