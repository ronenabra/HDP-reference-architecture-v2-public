'use strict';
/** Selected managed-data presentation and source-bound startup save contracts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('../../../test-support/team-config').installTestRuntime();
const ui = require('../src/routes/ui');
const { loadTeamConfig } = require('../src/team-config');
const render = ui._test.renderAdminHtml;
const route = ui.stack.find(layer => layer.route?.path === '/admin/config/fhir-servers/:serverId/bootstrap').route.stack.at(-1).handle;
const { operationSummary } = require('../../shared/ui/admin-feedback');

/** Capture HTML and JSON using the real route handler and current isolated config. */
function response(html = false) {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; }, send(body) { this.body = body; },
        redirect(code, url) { this.statusCode = code; this.location = url; },
        format(handlers) { return handlers[html ? 'html' : 'json'](); } };
}
function request(body, extra = {}) {
    return { params: { serverId: 'ho-a' }, path: '/admin/config/fhir-servers/ho-a/bootstrap', body,
        query: { section: 'sources', source: loadTeamConfig().healthOrganizations[1].dataSourceOrganization.id, view: 'registration' },
        get: () => 'text/html', ...extra };
}

test('managed tasks retain exact target, inline replacement risk and independent inventory links', () => {
    const config = loadTeamConfig();
    const html = render({ query: { section: 'sources', source: config.healthOrganizations[0].dataSourceOrganization.id, view: 'data' } });
    for (const heading of ['Current counts and history', 'Manual import or replacement', 'Saved operation and recovery', 'Startup mapping', 'Delete target data and history']) assert.ok(html.includes(heading));
    assert.match(html, /failed load can leave the target empty or incomplete/);
    assert.match(html, /Saving this mapping does not import/);
    assert.match(html, /Raw verified Admin inventory JSON \(all managed sources\)/);
    assert.match(html, /name="confirmation"[^>]*value="delete-all:[^"]+:ho-a"/);
    assert.match(html, new RegExp(`in team ${config.teamId} only`));
    assert.doesNotMatch(html, /name="confirmation"[^>]*checked|data-managed-fhir-server="ho-b"|name="maxBytes"/);
});

test('invalid startup draft returns to route-owned data view and retains non-secret fields', () => {
    const req = request({ policy: 'if-empty', bundleReference: 'catalog/new.source.transaction.json', expectedSource: 'source-draft' });
    const html = render(req, { adminError: { message: 'invalid startup draft', statusCode: 400 } });
    assert.match(html, /name="bundleReference" value="catalog\/new.source.transaction.json"/);
    assert.match(html, /name="expectedSource" value="source-draft"/);
    assert.match(html, /<option selected>if-empty<\/option>/);
    assert.match(html, /data-managed-fhir-server="ho-a"/);
    assert.doesNotMatch(html, /data-managed-fhir-server="ho-b"/);
});

test('startup form rejects stale revision without writing and keeps failed draft', () => {
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    const req = request({ adminForm: 'clinical-bootstrap', expectedRevision: -1, policy: 'replace', bundleReference: 'draft.source.transaction.json', expectedSource: 'ho-a' });
    const res = response(true); route(req, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /Startup settings changed/);
    assert.match(res.body, /name="bundleReference" value="draft.source.transaction.json"/);
    assert.ok(before.equals(fs.readFileSync(process.env.TEAM_CONFIG_PATH)));
});

test('startup save changes only selected mapping, returns its mounted workspace and never imports', () => {
    const config = loadTeamConfig();
    const other = structuredClone(config.healthOrganizations[1]);
    const req = request({ adminForm: 'clinical-bootstrap', expectedRevision: config.runtime.revision || 0,
        policy: 'if-empty', bundleReference: 'ci/ho-a.source.transaction.json', expectedSource: 'ho-a' });
    const res = response(true); route(req, res);
    assert.equal(res.statusCode, 303, String(res.body));
    assert.match(res.location, /section=sources/); assert.match(res.location, /view=data/);
    assert.ok(res.location.includes(encodeURIComponent(config.healthOrganizations[0].dataSourceOrganization.id)));
    assert.deepEqual(loadTeamConfig().healthOrganizations[1], other);
    assert.equal(loadTeamConfig().healthOrganizations[0].clinicalData.bootstrap.policy, 'if-empty');
    assert.equal(fs.existsSync(`${process.env.STATE_DIR}/data-operations`), false);
});

test('startup no-op result and import verification never imply Doctor picker publication', () => {
    assert.match(operationSummary({ phase: 'succeeded', result: 'skipped' }), /skipped.*preserved/);
    assert.match(operationSummary({ phase: 'succeeded' }), /private Admin inventory/);
    assert.doesNotMatch(operationSummary({ phase: 'succeeded' }), /patients are available/);
});

/** Recovery result errors retain the saved operation’s source, without query substitution. */
test('failed recovery renders the operation-owned managed workspace', () => {
    const { DataOperationRegistry } = require('../src/data-operations');
    const registry = new DataOperationRegistry();
    const operation = registry.create('ho-b', 'import');
    registry.transition(operation.id, 'failed', { mutationSubmitted:true, needsReconciliation:true });
    const html = render({ params:{operationId:operation.id}, path:`/admin/api/data-operations/${operation.id}/recover`,
        query:{section:'sources',source:loadTeamConfig().healthOrganizations[0].dataSourceOrganization.id,view:'registration'} },
        {adminError:{message:'Stopped-worker proof is missing',statusCode:409}});
    assert.match(html,/data-managed-fhir-server="ho-b"/);
    assert.doesNotMatch(html,/data-managed-fhir-server="ho-a"/);
    assert.match(html,/Check this import/);
});
