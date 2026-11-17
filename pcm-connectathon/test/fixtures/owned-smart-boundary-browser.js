'use strict';

/** Isolated pinned-browser regression: use only owned loopback listeners, with --network none. */
const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/suite/node_modules/playwright');
const { installOwnedSmartCancellation } = require(process.env.SMART_BOUNDARY_MODULE || '../../ui/tests/helpers/owned-smart-cancellation');

/** Start one exclusively owned ephemeral loopback HTTP fixture. */
async function listener(handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** Reproduce the three error chains and a cookie-preserving native Cancel on both input devices. */
async function main() {
    let callbackRequests = 0, rootRequests = 0, decisionPosts = 0, cookieObserved = false;
    const foreign = await listener((req, res) => {
        if (req.url.startsWith('/registered/callback')) {
            callbackRequests++; res.writeHead(302, { Location: '/' }).end();
        } else { rootRequests++; res.end('Owned fake callback root'); }
    });
    const callback = `${foreign.origin}/registered/callback`;
    let own;
    own = await listener((req, res) => {
        if (req.method === 'POST') {
            decisionPosts++; res.writeHead(302, { Location: `${callback}?error=access_denied&state=owned-state` }).end();
        } else if (req.url === '/start-via-authorize') {
            res.writeHead(302, { Location: '/authorize-error?state=owned-state' }).end();
        } else if (req.url === '/start-normal') {
            res.writeHead(302, { Location: '/authorize-normal?state=owned-state', 'Set-Cookie': 'owned_fixture=present; Path=/; HttpOnly; SameSite=Lax' }).end();
        } else if (req.url.startsWith('/authorize-normal')) {
            cookieObserved = req.headers.cookie === 'owned_fixture=present';
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><title>Owned authorize</title><form method="post" action="/authorize/decision"><button name="decision" value="cancel">Cancel</button></form>');
        } else if (req.url.startsWith('/start-direct') || req.url.startsWith('/authorize-error')) {
            res.writeHead(302, { Location: `${callback}?error=invalid_scope&state=owned-state` }).end();
        } else { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Owned ancillary resource'); }
    });
    const browser = await chromium.launch({ headless: true });
    const cases = [];
    try {
        for (const initialPath of ['/start-direct', '/authorize-error?state=owned-state', '/start-via-authorize']) {
            callbackRequests = 0; rootRequests = 0; decisionPosts = 0;
            const context = await browser.newContext();
            try {
                const guard = await installOwnedSmartCancellation(context, { allowedOrigins: [own.origin], decisionUrl: `${own.origin}/authorize/decision` });
                const page = await context.newPage();
                await page.goto(own.origin + initialPath).catch(() => {});
                // A separately guarded hop may begin after the first acknowledgement.
                await assert.rejects(guard.expectCancellation(callback, 'owned-state'), /redirect to unowned origin blocked before dispatch/);
                assert.throws(() => guard.assertSafe(), /before dispatch/);
                assert.equal(callbackRequests, 0); assert.equal(rootRequests, 0); assert.equal(decisionPosts, 0);
                assert.equal(guard.blocked.length, 1);
                cases.push({ initialPath, callbackRequests, rootRequests, decisionPosts, guardBlockedCount: guard.blocked.length,
                    ownedNavigationHops: guard.ownedNavigationHops, descriptiveFailure: true, foreignDispatchPrevented: true });
            } finally { await context.close(); }
        }
        for (const device of ['desktop', 'mobile']) {
            callbackRequests = 0; rootRequests = 0; decisionPosts = 0; cookieObserved = false;
            const context = await browser.newContext({ hasTouch: device === 'mobile', isMobile: device === 'mobile',
                viewport: device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
            try {
                const guard = await installOwnedSmartCancellation(context, { allowedOrigins: [own.origin], decisionUrl: `${own.origin}/authorize/decision` });
                const page = await context.newPage();
                await page.goto(`${own.origin}/start-normal`);
                await page.waitForURL(`${own.origin}/authorize-normal?state=owned-state`);
                assert.equal(cookieObserved, true);
                const [proof] = await Promise.all([guard.expectCancellation(callback, 'owned-state'),
                    page.getByRole('button', { name: 'Cancel', exact: true })[device === 'mobile' ? 'tap' : 'click']()]);
                guard.assertSafe();
                assert.equal(proof.upstreamStatus, 302); assert.equal(proof.browserAcknowledgementStatus, 200);
                assert.equal(decisionPosts, 1); assert.equal(callbackRequests, 0); assert.equal(rootRequests, 0);
                assert.equal(guard.blocked.length, 0); assert.equal(guard.ownedNavigationHops.length, 1);
                cases.push({ device, ...proof, cookieObserved, decisionPosts, callbackRequests, rootRequests,
                    ownedNavigationHops: guard.ownedNavigationHops, guardBlockedCount: guard.blocked.length });
            } finally { await context.close(); }
        }
        const result = { schemaVersion: 'pcm-owned-smart-boundary-proof/1', network: 'none; two owned loopback listeners', cases, pass: true };
        if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
        console.log(JSON.stringify(result));
    } finally { await browser.close(); own.server.close(); foreign.server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
