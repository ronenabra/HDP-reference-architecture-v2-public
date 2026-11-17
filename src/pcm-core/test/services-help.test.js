'use strict';
/** Services language and help are checked against rendered states, not snapshots. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ejs = require('ejs');
const root = path.resolve(__dirname, '../../..');
const { parseCatalog } = require(path.join(root, 'scripts/generate-ui-help'));
const catalog = parseCatalog(fs.readFileSync(path.join(root, 'docs/ui-explanation-catalog.md'), 'utf8'));
const form = require('../src/service-definition-form');
const { SENSITIVITY_LABELS } = require('../../shared/information-buckets');

/** Render empty/error/partial/disabled cases using the same real Services EJS. */
function render(overrides = {}) {
    return ejs.render(fs.readFileSync(path.join(root, 'src/pcm-core/src/views/services.ejs'), 'utf8'), {
        browserBase: '/mount', teamId: 'help-owned', role: 'serviceProvider', providers: [{ role: 'serviceProvider', id: 'provider', name: 'Test provider' }],
        list: { owned: [], available: [], others: [] }, templates: [], targets: [], context: null, error: '', warnings: [], nextPage: '',
        privateActionsUnavailable: false, formCsrf: 'fixture', ownerCsrf: () => 'fixture', units: form.UNITS,
        bucketResources: { laboratoryTests: { Observation: 'rs' } }, categoryLabels: { laboratoryTests: 'Laboratory tests' }, sensitivityLabels: SENSITIVITY_LABELS, ...overrides
    });
}

test('Services rendered fields use plain labels and keep unsupported category choice honest', () => {
    const html = render();
    assert.equal((html.match(/class="explain-toggle"/g) || []).length, 1);
    assert.match(html, /<header class="sandbox-header">/);
    for (const label of ['>Maximum consent period</label>', '>Include records from the past</label>', 'Let patients choose data categories', 'no separate category editor', 'Human immunodeficiency virus (HIV)', 'Physician-requested sensitivity', 'Patient-requested sensitivity']) assert.ok(html.includes(label), label);
    assert.doesNotMatch(html, /Exact sensitive-category codes/);
    for (const tag of SENSITIVITY_LABELS) { assert.ok(html.includes(`${tag.system}|${tag.code}`), tag.code); assert.ok(html.includes(`<code>(${tag.system} | ${tag.code})</code></label>`), 'exact code beside its labelled checkbox'); }
    assert.match(html, /name="includeMasterData"[^>]*checked/);
    for (const type of ['Organization', 'Practitioner', 'PractitionerRole', 'Location']) assert.ok(html.includes(type));
    assert.match(html, /data-help-key="services.create" data-help-disabled-key="services.result" data-help-proxy>Create service/);
    assert.match(html, /Approval freezes one exact scope; different permissions require a new Consent/);
    assert.match(html, /Saving this default grants no access/);
    assert.match(html, /Generated history uses a fixed creation-time cutoff; newer records stay eligible/);
    assert.doesNotMatch(html, /Disabled sandbox checks|Enabled global bypasses|coordinated approval, token and source rollout remains pending/);
    assert.match(html, /Clinical permissions and Patient\/source context are enforced in every security preset/);
    assert.match(html, /Successful access does not prove real patient or Ministry approval/);
});

test('Services error, empty, partial, unavailable and result states retain useful help and next steps', () => {
    const empty = render({ catalog: { items: [], total: 0, complete: true, nextOffset: null } });
    assert.match(empty, /No shared service definitions on this page/);
    assert.match(empty, /Create a service before connecting providers/);
    assert.doesNotMatch(empty, /id="service-provider"/);
    assert.match(empty, /Templates unavailable. New service remains available/);
    const failed = render({ catalogError: 'Provider credentials unavailable', warnings: ['Linked definition unavailable'], nextPage: 'owned-page', privateActionsUnavailable: true });
    assert.match(failed, /Provider credentials unavailable.*Refresh from the first page/);
    assert.match(failed, /Result notices \(1\): some information is unavailable/);
    assert.match(failed, /Provider connections are unknown/);
    assert.match(failed, /Private catalog creation is unavailable in Strict/);
    assert.doesNotMatch(failed, /Load provider assignments/);
    assert.match(failed, /data-service-peer="catalog"/);
    assert.match(failed, /data-service-peer="assignments"/);
    assert.doesNotMatch(failed, /id="service-admin"/);
    for (const key of failed.matchAll(/data-help-key="([\w.-]+)"/g)) assert.ok(catalog[key[1]], key[1]);
});

test('Services help separates defaults, deliberate overrides, frozen grant, validity and historical dates', () => {
    assert.match(catalog['services.scope'].body, /default offered at Consent approval/);
    assert.match(catalog['services.scope'].body, /including broader sandbox permissions/);
    assert.match(catalog['services.scope'].technical, /issued scope and active introspection retain it unchanged/);
    assert.match(catalog['services.scope'].technical, /Source edits change sources only/);
    assert.match(catalog['services.history'].body, /fixed lower date once/);
    assert.match(catalog['services.history'].body, /lookback grows/);
    assert.match(catalog['services.duration'].technical, /Clinical-history filters are separate/);
    assert.match(catalog['services.mode'].technical, /cannot restart that window/);
    assert.match(catalog['services.status'].body, /Connected alone does not establish usable access/);
    assert.match(catalog['services.status'].technical, /Access still requires an eligible Consent/);
    for (const key of ['services.kind', 'services.template-scope', 'simulation.smartScopes', 'simulation.resultFiltering', 'services.available', 'services.others', 'services.sandbox', 'services.template-history', 'services.template-policy', 'services.rebind']) assert.equal(catalog[key], undefined, 'retired dormant key must not revive a control');
});

/** The visible notice and actual confirmation distinguish checkpointed state from memory-only state. */
test('restart and cleanup copy consistently qualifies uncheckpointed changes and retained checkpoints', async () => {
    const html = render();
    const notice = /<p data-help-key="services.restart">([^<]+)<\/p>/.exec(html)?.[1];
    assert.match(notice, /Uncheckpointed runtime changes are lost on restart\/reset/);
    assert.match(notice, /explicit retained checkpoint can preserve services and registrations/);
    assert.match(notice, /never changes seed files or deletes patient data/);
    // Execute the actual submit closure only as far as a cancelled confirmation:
    // no copied confirmation string or backend/persistence double supplies the copy.
    const controller = fs.readFileSync(path.join(root, 'src/shared/ui/services.js'), 'utf8');
    let submit, confirmation = '', requests = 0;
    const sandbox = { dataset: { targetKind: 'instance', providerName: 'Test provider', serviceName: 'Owned service' },
        hasAttribute: name => name === 'data-service-sandbox',
        addEventListener(_name, listener) { submit = listener; } };
    const context = { create: {}, boundForms: new WeakSet(), loadingData: false, submitting: false,
        document: { querySelectorAll: () => [sandbox] },
        window: { confirm(message) { confirmation = message; return false; } },
        fetch() { requests++; throw new Error('A cancelled confirmation must make no request.'); } };
    const start = controller.indexOf('    function bindForms()');
    const end = controller.lastIndexOf('    bindForms();');
    assert.ok(start >= 0 && end > start);
    require('node:vm').runInNewContext(controller.slice(start, end) + '\nbindForms();', context);
    await submit({ preventDefault() {}, submitter: { value: 'delete', disabled: false, textContent: 'Delete from this runtime' } });
    assert.match(confirmation, /Uncheckpointed runtime changes are lost on restart\/reset/);
    assert.match(confirmation, /explicit retained checkpoint can preserve them/);
    assert.match(confirmation, /No patient data or seed files are deleted/);
    assert.equal(requests, 0);
    for (const key of ['services.restart', 'services.delete']) {
        const copy = `${catalog[key].body} ${catalog[key].technical}`;
        assert.match(copy, /Uncheckpointed runtime changes are lost on restart\/reset/);
        assert.match(copy, /explicit retained checkpoint can preserve/);
        assert.doesNotMatch(copy, /Runtime-created services[^.]*disappear/);
    }
    const guide = fs.readFileSync(path.join(root, 'docs/service-templates.md'), 'utf8');
    assert.match(guide, /Uncheckpointed runtime changes are lost on restart\/reset/);
    assert.match(guide, /explicit retained\s+checkpoint can preserve services and registrations/);
    assert.match(guide, /Deleting a service or provider\s+registration does not delete clinical records/);
    assert.doesNotMatch(guide, /Runtime-created services disappear on restart|reset\/restart removes them/);
});

/** Render real connection states so irreversible consequences remain beside their controls. */
test('connection actions retain inline terminal consequences and source-specific Help', () => {
    const service = { id: 'ordinary', name: 'Ordinary service', state: 'active', stateLabel: 'Active', registrationCount: 3 };
    const provider = { id: 'owner', name: 'Exact provider', source: 'persisted-private-owner', standardManagement: true,
        connect: { available: true, csrf: 'connect' }, registrations: ['active', 'pending', 'suspended'].map((state, index) => ({
            id: `registration-${index}`, version: '1', state, availability: state,
            standard: { csrf: 'owner', actions: ['suspended', 'cancelled', 'active'] },
            admin: { csrf: 'admin', actions: [], actionReasons: {}, reason: 'Strict excludes private commands', deleteReason: 'Retained approval history' }
        })) };
    const html = render({ selectedView: 'assignments', catalog: { items: [], total: 1, complete: true },
        groups: [{ service, providers: { items: [provider], total: 1, complete: true, nextOffset: null } }] });
    for (const [index, consequence] of [[0, /Disconnect is terminal; reconnect creates a new request/], [1, /withdrawing this request is terminal/], [2, /Old approvals stay terminal/]]) {
        const row = html.split(`data-service-id="registration-${index}"`)[1].split('</tbody>')[0];
        assert.match(row, consequence);
        assert.match(row, /Permanently remove this inactive registration; no undo or cascade/);
        assert.match(row, /Retained approval history/);
        assert.match(row, /Strict excludes private commands/);
    }
    assert.match(html, /Pause and End are checked separately and are not atomic/);
    assert.match(catalog['services.technical'].body, /source labelled in this panel/);
    assert.match(catalog['services.technical'].body, /Protected Admin inventory is distinct/);
    assert.doesNotMatch(catalog['services.technical'].body, /returned through the regular provider API/);
    assert.match(catalog['services.category'].body, /Laboratory tests/);
    assert.match(catalog['services.duration'].technical, /six months of consent.*past two years/);
    assert.match(catalog['services.confidentiality'].technical, /patient\/\*\.rs includes R and V/);
});
