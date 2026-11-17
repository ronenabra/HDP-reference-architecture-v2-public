'use strict';

/** Controlled submission/render delays reproduce the observed browser identity race. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConsent } = require('../ui/tests/helpers/consent-creation');

/** Model separately delayed command completion and redirected card materialization. */
function fixture({ status = 302, after = ['old', 'new'] } = {}) {
    let ids = ['old'], releaseResponse, releaseRender, predicate;
    const response = new Promise(resolve => { releaseResponse = resolve; });
    const render = new Promise(resolve => { releaseRender = resolve; });
    const cards = { evaluateAll: callback => callback(ids.map(value => ({ getAttribute: name => {
        assert.equal(name, 'data-consent-card'); return value;
    } }))) };
    const page = {
        locator: selector => { assert.equal(selector, '[data-consent-card]'); return cards; },
        getByText: () => ({}),
        getByRole: () => ({ click: async () => {} }),
        waitForResponse: selected => { predicate = selected; return response; },
        waitForEvent: event => { assert.equal(event, 'domcontentloaded'); return render; }
    };
    return { page, expect: () => ({ toBeVisible: async () => { await render; } }),
        complete() {
            const actual = { url: () => 'http://localhost:8100/create-consent', request: () => ({ method: () => 'POST' }), status: () => status };
            assert.equal(predicate(actual), true);
            assert.equal(predicate({ ...actual, request: () => ({ method: () => 'GET' }) }), false);
            releaseResponse(actual);
        }, render() { ids = after; releaseRender(); } };
}

test('deferred native submit and redirected render cannot return the previous Consent identity', async () => {
    const f = fixture(); let completed = false;
    const result = createConsent(f.page, { origin: 'http://localhost:8100', expect: f.expect }).then(id => { completed = true; return id; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    f.complete(); await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    f.render(); assert.equal(await result, 'new');
});

test('failed creation and a duplicate old identity cannot count as a new Consent', async () => {
    for (const options of [{ status: 500 }, { after: ['old', 'old'] }]) {
        const f = fixture(options);
        const result = createConsent(f.page, { origin: 'http://localhost:8100', expect: f.expect });
        await new Promise(resolve => setImmediate(resolve)); f.complete(); f.render();
        await assert.rejects(result, /did not succeed|distinct new identity/);
    }
});

test('a changed patient cohort can replace the old visible card after successful creation', async () => {
    const f = fixture({ after: ['new-patient-consent'] });
    const result = createConsent(f.page, { origin: 'http://localhost:8100', expect: f.expect });
    await new Promise(resolve => setImmediate(resolve)); f.complete(); f.render();
    assert.equal(await result, 'new-patient-consent');
});
