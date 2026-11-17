'use strict';
/** Exercise real Consent render states and the Doctor header's identity boundary. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startApprovalFixture } = require('../../../test-support/approval-scope-fixture');
const { render } = require('../../../test-support/doctor-ux-render');

test('Doctor current navigation preserves the exact mounted application and escapes identity', () => {
    const html = render(undefined, 'active', { currentIdentity: 'app/with & space', teamId: '<test team>' });
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.match(header, /href="\/doctor\/\?identity=app%2Fwith%20%26%20space" aria-current="page"/);
    assert.match(header, /&lt;test team&gt;/);
    assert.match(header, /<form action="\/doctor\/" method="GET"/);
    assert.match(header, /id="doctor-identity" name="identity"/);
    assert.match(header, /type="button" id="doctor-tools-button"/);
    assert.equal((header.match(/class="explain-toggle"/g) || []).length, 1);
    assert.ok(header.indexOf('>Consents</a>') < header.indexOf('>Logs</a>'));
    assert.ok(header.indexOf('>Close tools</button>') < header.indexOf('Explain this page'));
});

test('Consent headers keep approval fields and details states; missing records remain 404', async () => {
    const fixture = await startApprovalFixture();
    try {
        const consent = fixture.create();
        const requested = await fetch(`${fixture.base}/ui/approve/${consent.id}`);
        assert.equal(requested.status, 200);
        const html = await requested.text();
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        assert.match(header, /Review consent request/);
        assert.match(header, /aria-current="page" href="\/ui"/);
        assert.match(header, /href="\/admin\/services"/);
        assert.equal((header.match(/class="explain-toggle"/g) || []).length, 1);
        assert.doesNotMatch(header, /<form|<button/);
        assert.match(html, /name="expectedVersion"/);
        assert.match(html, /name="scopeChoice" value="service-provided"/);
        assert.match(html, /name="action" value="approve"/);
        assert.equal(fixture.store.get('Consent', consent.id).status, 'proposed');
        const saved = fixture.store.get('Consent', consent.id); saved.status = 'rejected'; fixture.store.update(saved);
        const details = await (await fetch(`${fixture.base}/ui/approve/${consent.id}`)).text();
        assert.match(details, /Consent details/);
        assert.doesNotMatch(details, /name="scopeChoice"/);
        assert.match(details, /Missing legacy approval snapshot/);
        assert.equal((await fetch(`${fixture.base}/ui/approve/missing-foundation-record`)).status, 404);
    } finally { await fixture.close(); }
});
