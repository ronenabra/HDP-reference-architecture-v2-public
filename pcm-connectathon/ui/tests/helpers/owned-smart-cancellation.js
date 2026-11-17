'use strict';

/** Validate the real authorization-server response without following its registered callback. */
function cancellationProof(status, headers, callback, state) {
    if (status !== 302) throw new Error(`Cancellation server returned ${status}, expected 302`);
    const destination = new URL(headers.location);
    const registered = new URL(callback);
    if (destination.origin !== registered.origin || destination.pathname !== registered.pathname
        || destination.searchParams.get('error') !== 'access_denied'
        || destination.searchParams.get('state') !== state
        || destination.searchParams.has('code') || destination.searchParams.has('access_token')) {
        throw new Error('Cancellation redirect does not match the registered callback, denial and state');
    }
    return { upstreamStatus: status, callbackOrigin: destination.origin,
        callbackPath: destination.pathname, error: 'access_denied', stateMatched: true };
}

/**
 * Fence this browser context to owned origins before navigation. Native Cancel
 * submits the real form. Fetch every owned response without redirects because
 * Playwright does not route later URLs in a browser HTTP redirect chain. An
 * owned GET navigation becomes a separate guarded navigation; foreign redirects
 * fail before dispatch. API/subresource redirects fail closed.
 */
async function installOwnedSmartCancellation(context, { allowedOrigins, decisionUrl }) {
    const owned = new Set(allowedOrigins.map(value => new URL(value).origin));
    const decision = new URL(decisionUrl).href;
    if (!owned.has(new URL(decision).origin)) throw new Error('Decision endpoint must belong to the owned fixture');
    const blocked = [];
    const ownedNavigationHops = [];
    let failure;
    let expected;
    let resolve, reject;
    const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A navigation may fail before the caller awaits completion. Keep the error
    // observable through completed without creating an unhandled rejection.
    completed.catch(() => {});
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        let response;
        try {
            if (!owned.has(url.origin)) {
                blocked.push({ origin: url.origin, pathname: url.pathname, method: request.method() });
                throw new Error(`Unowned SMART request blocked before dispatch: ${url.origin}${url.pathname}`);
            }
            const isDecision = url.href === decision && request.method() === 'POST';
            if (isDecision && (!expected || new URLSearchParams(request.postData() || '').get('decision') !== 'cancel')) {
                throw new Error('Expected the native cancellation form submission');
            }
            response = await route.fetch({ maxRedirects: 0 });
            if (!isDecision) {
                if ([301, 302, 303, 307, 308].includes(response.status())) {
                    const location = response.headers().location;
                    if (!location) throw new Error('Owned SMART redirect is missing its Location header');
                    const destination = new URL(location, url);
                    if (!owned.has(destination.origin)) {
                        blocked.push({ origin: destination.origin, pathname: destination.pathname, method: request.method() });
                        throw new Error(`Owned SMART redirect to unowned origin blocked before dispatch: ${destination.origin}${destination.pathname}`);
                    }
                    if (!request.isNavigationRequest() || request.method() !== 'GET') {
                        throw new Error('Owned SMART redirects require a GET document navigation');
                    }
                    ownedNavigationHops.push({ origin: url.origin, pathname: url.pathname,
                        upstreamStatus: response.status(), destinationOrigin: destination.origin,
                        destinationPath: destination.pathname });
                    // Returning an HTTP redirect would bypass routing again. A local
                    // navigation acknowledgement creates a fresh guarded request.
                    // route.fetch shares the context cookie jar, preserving Set-Cookie.
                    const target = JSON.stringify(destination.href).replace(/</g, '\\u003c');
                    await route.fulfill({ status: 200, contentType: 'text/html',
                        body: `<!doctype html><title>Owned navigation checked</title><script>location.replace(${target})</script>` });
                } else {
                    await route.fulfill({ response });
                }
                return;
            }
            const proof = cancellationProof(response.status(), response.headers(), expected.callback, expected.state);
            // This local acknowledgement deliberately is not presented as the
            // upstream 302. The proof above records the actual server response.
            await route.fulfill({ status: 200, contentType: 'text/html',
                body: '<!doctype html><title>Cancellation checked</title><p>Cancellation response checked; callback navigation stopped.</p>' });
            resolve({ ...proof, nativeCancelSubmitted: true, browserAcknowledgementStatus: 200 });
        } catch (error) {
            failure = error;
            reject(error);
            await route.abort('failed').catch(() => {});
        } finally { if (response) await response.dispose(); }
    });
    return {
        blocked,
        ownedNavigationHops,
        assertSafe() { if (failure) throw failure; },
        expectCancellation(callback, state) {
            if (!state) throw new Error('Cancellation requires a nonempty request state');
            expected = { callback, state };
            return completed;
        }
    };
}

module.exports = { cancellationProof, installOwnedSmartCancellation };
