'use strict';
/** Protected ordinary backup/reset/restore with actual resources, tokens and recovery owners. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const config = require('../../../test-support/team-config').installTestRuntime();
fs.cpSync(require('../../../test-support/certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
const store = require('../src/fhir/store'), tokens = require('../src/store').tokens;
const checkpoint = require('../src/migration-checkpoint'), maintenance = require('../src/admin-maintenance');
const owner = require('../src/team-config');
let server, app, base;
const clinicalServers = [], clinicalRequests = [], clinicalUrls = [];
/** Read actual owned independent HTTPS source bytes without passing them through PCM. */
function clinicalRead(url) {
    return new Promise((resolve, reject) => require('node:https').get(url, { rejectUnauthorized: false }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject));
}
const headers = { 'x-admin-password': 'owned-maintenance31', Accept: 'application/json', 'Content-Type': 'application/json' };
const read = () => JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
/** Make a protected request, returning only the response body to this private process. */
async function request(route, body, authorized = true) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: authorized ? headers : { Accept: 'application/json', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
}
const backup = async () => (await request('/admin/backup')).body;
const wrap = payload => ({ backupJson: JSON.stringify(payload), expectedRevision: read().runtime.revision || 0 });
const graph = () => checkpoint.snapshot(store, { privateState: true });
const bytes = () => fs.readFileSync(process.env.TEAM_CONFIG_PATH);

test.before(async () => {
    process.env.TEAM_ADMIN_PASSWORD = headers['x-admin-password'];
    fs.mkdirSync(process.env.STATE_DIR, { recursive: true });
    const current = read();
    for (const ho of current.healthOrganizations) {
        const file = path.join(process.env.STATE_DIR, `${ho.id}-clinical.json`);
        fs.writeFileSync(file, JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: `untouched-${ho.id}` } }] }));
        const source = require('node:https').createServer({ key: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.key')), cert: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.crt')) }, (request, response) => {
            clinicalRequests.push({ source: ho.id, method: request.method }); response.setHeader('Content-Type', 'application/fhir+json'); response.end(fs.readFileSync(file));
        });
        source.listen(0, '127.0.0.1'); await new Promise(resolve => source.once('listening', resolve)); clinicalServers.push(source);
        const endpoint = `https://127.0.0.1:${source.address().port}/fhir`; clinicalUrls.push(endpoint);
        const registered = require('../src/data-sources').toConfigDataSource({ id: `maintenance31-${ho.id}`, name: `Owned clinical fixture ${ho.id}`, clientId: `client-maintenance31-${ho.id}`, endpoint });
        registered.pcmClientAuth.certThumbprint = 'A'.repeat(43);
        current.organizations.dataSources.push(registered);
    }
    require('../../shared/team-config-validator').assertValidTeamConfig(current, { env: process.env });
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(current));
    app = require('../src/index').createUiApp(); server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await require('../src/bootstrap')();
});
test.after(async () => { app.locals.closeLogSearch(); if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } for (const source of clinicalServers) { source.closeAllConnections(); await new Promise(resolve => source.close(resolve)); } delete process.env.TEAM_ADMIN_PASSWORD; });

test('ordinary export is protected no-store attachment with exact complete config and actual private-key files only', async () => {
    assert.equal((await request('/admin/backup', undefined, false)).status, 401);
    assert.equal((await request('/admin/restore', {}, false)).status, 401);
    assert.equal((await request('/admin/reset', {}, false)).status, 401);
    const result = await request('/admin/backup'); assert.equal(result.status, 200);
    assert.match(result.headers.get('content-disposition'), /attachment/); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.body.teamConfig, read()); assert.equal(result.body.teamId, config.teamId);
    assert.equal(result.body.certificates['pcm-core.key'], fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.key'), 'utf8'));
    assert.ok(Object.keys(result.body.certificates).some(name => name.endsWith('.key')));
    assert.deepEqual(Object.keys(result.body).sort(), ['certificates', 'exportedAt', 'security', 'teamConfig', 'teamId', 'thumbprints']);
});

test('same server validator accepts file/paste bytes and refuses wrong team/version/scope, malformed/oversized, stale review and changed listener material without secrets or writes', async () => {
    const payload = await backup(), current = read();
    assert.deepEqual(maintenance.validateRestore(wrap(payload), current, payload.certificates), payload.teamConfig);
    const before = bytes(), state = graph();
    const cases = [
        [{ backupJson: '{secret:PRIVATE_KEY_CANARY', expectedRevision: current.runtime.revision || 0 }, 400],
        [{ backupJson: ' '.repeat(maintenance.MAX_BACKUP_BYTES + 1) }, 413],
        [wrap({ ...payload, teamId: 'other' }), 400],
        [wrap({ ...payload, schema: 'pcm-public-metadata-migration/1' }), 400],
        [wrap({ ...payload, teamConfig: { ...payload.teamConfig, configVersion: 'pcm-team-config/4' } }), 409],
        [{ ...wrap(payload), expectedRevision: 999999 }, 409],
        [wrap({ ...payload, certificates: { ...payload.certificates, 'pcm-core.key': 'PRIVATE_KEY_CANARY' } }), 409],
        [wrap({ ...payload, teamConfig: { ...payload.teamConfig, publicBaseUrls: { ...payload.teamConfig.publicBaseUrls, pcmUi: 'http://other.invalid' } } }), 409],
        [wrap({ ...payload, teamConfig: { ...payload.teamConfig, organizations: { ...payload.teamConfig.organizations, dataSources: payload.teamConfig.organizations.dataSources.map((source, index) => index ? source : { ...source, clientId: 'changed-client-binding' }) } } }), 409],
        [wrap({ ...payload, teamConfig: { ...payload.teamConfig, healthOrganizations: payload.teamConfig.healthOrganizations.map((ho, index) => index ? ho : { ...ho, database: { ...ho.database, name: 'changed-database-owner' } }) } }), 400],
        [wrap({ ...payload, teamConfig: {} }), 400],
        [wrap({ certificates: {} }), 400]
    ];
    for (const [body, status] of cases) {
        const response = await request('/admin/restore', body); assert.equal(response.status, status, JSON.stringify(response.body));
        assert.match(response.body.error, /Restore backup failed\. (Backup|Wrong|Saved|Restoration)/, 'the safe actionable reason is in the primary error, not a hidden detail');
        assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_KEY_CANARY|BEGIN.*PRIVATE KEY/);
        assert.deepEqual(bytes(), before); assert.deepEqual(graph(), state);
    }
    const restricted = read();
    restricted.organizations.removedDataSourceRegistrations = [{ id: 'removed-maintenance31', endpointId: 'endpoint-removed-maintenance31', clientId: 'client-removed-maintenance31-0001' }];
    owner.saveTeamConfig(owner.markRuntimeChange(restricted, 'owned-source-removal-reservation'));
    const restrictedBytes = bytes(), restrictedGraph = graph();
    const denied = await request('/admin/restore', wrap(payload));
    assert.equal(denied.status, 400); assert.match(denied.body.error, /later source removal/);
    assert.deepEqual(bytes(), restrictedBytes); assert.deepEqual(graph(), restrictedGraph);
});

test('compatible config restore actually resets Consent/token/runtime catalog choices and bootstraps catalog while all owned source bytes remain unchanged', async () => {
    const original = await backup();
    const sources = config.healthOrganizations.map(ho => path.join(process.env.STATE_DIR, `${ho.id}-clinical.json`));
    const sourceBytes = await Promise.all(clinicalUrls.map(url => clinicalRead(url)));
    const beforeSourceRequests = clinicalRequests.length;
    const next = read(); next.security.pcmApi.accessTokenExpiresInSeconds = 17; owner.saveTeamConfig(owner.markRuntimeChange(next, 'owned-test'));
    store.add({ resourceType: 'Consent', id: 'old-runtime-consent', status: 'draft' });
    store.add({ resourceType: 'HealthcareService', id: 'runtime-only-catalog-choice', active: false });
    const token = tokens.issue('management', {}, 60).token; assert.ok(tokens.peek(token));
    const response = await request('/admin/restore', wrap(original)); assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(read().security.pcmApi.accessTokenExpiresInSeconds, original.teamConfig.security.pcmApi.accessTokenExpiresInSeconds);
    assert.equal(store.get('Consent', 'old-runtime-consent'), null); assert.equal(store.get('HealthcareService', 'runtime-only-catalog-choice'), null);
    assert.ok(store.getAll('HealthcareService').length); assert.ok(store.getAll('Organization').length); assert.ok(store.getAll('Contract').length); assert.equal(tokens.peek(token), undefined);
    assert.equal(clinicalRequests.length, beforeSourceRequests, 'restore sent no request to any configured clinical source');
    const afterClinical = await Promise.all(clinicalUrls.map(url => clinicalRead(url)));
    sources.forEach((file, index) => { assert.deepEqual(fs.readFileSync(file), sourceBytes[index]); assert.deepEqual(afterClinical[index], sourceBytes[index]); });
    assert.equal(fs.existsSync(path.join(process.env.STATE_DIR, 'configuration-mutation')), false);
});

test('reset uses the actual bootstrap owner, clears tokens/resources/catalog edits and preserves config and clinical files', async () => {
    const before = bytes(); store.add({ resourceType: 'Consent', id: 'reset-consent', status: 'draft' });
    const service = store.getAll('HealthcareService')[0]; store.update({ ...service, active: false });
    const token = tokens.issue('management', {}, 60).token, clinical = config.healthOrganizations.map(ho => path.join(process.env.STATE_DIR, `${ho.id}-clinical.json`)), beforeClinical = clinical.map(file => fs.readFileSync(file));
    const beforeSourceRequests = clinicalRequests.length;
    assert.equal((await request('/admin/reset', {})).status, 200);
    assert.equal(clinicalRequests.length, beforeSourceRequests, 'reset sent no request to a clinical source');
    assert.equal(store.get('Consent', 'reset-consent'), null); assert.equal(tokens.peek(token), undefined); assert.equal(store.get('HealthcareService', service.id).active, true);
    assert.deepEqual(bytes(), before); clinical.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), beforeClinical[i]));
});

test('failed restore after config publication rolls back exact config and public/private authority; failed reset/bootstrap preserves old graph', async () => {
    const before = bytes(), payload = await backup(); payload.teamConfig.security.pcmApi.accessTokenExpiresInSeconds = 19;
    store.add({ resourceType: 'Consent', id: 'rollback-consent', status: 'draft' }); const state = graph();
    const original = require('../src/bootstrap').synchronous;
    require('../src/bootstrap').synchronous = () => { store.add({ resourceType: 'Organization', id: 'injected-partial', active: false }); throw Error('PRIVATE_KEY_CANARY'); };
    try {
        const restore = await request('/admin/restore', wrap(payload)); assert.equal(restore.status, 400); assert.doesNotMatch(JSON.stringify(restore.body), /PRIVATE_KEY_CANARY/);
        assert.deepEqual(bytes(), before); assert.deepEqual(graph(), state); assert.equal(fs.existsSync(path.join(process.env.STATE_DIR, 'configuration-mutation')), false);
        assert.equal((await request('/admin/reset', {})).status, 409); assert.deepEqual(graph(), state);
    } finally { require('../src/bootstrap').synchronous = original; }
});

test('Maintenance owner links retain exact registered source and recorded operation without another editor or target fallback', () => {
    const registry = new (require('../src/data-operations').DataOperationRegistry)();
    const operation = registry.create('ho-b', 'import'); registry.transition(operation.id, 'failed');
    const source = config.healthOrganizations[1].dataSourceOrganization.id;
    const html = require('../src/routes/ui')._test.renderAdminHtml({ query: { section: 'maintenance', source } });
    assert.ok(html.includes(`/admin/api/data-operations/${operation.id}`));
    assert.ok(html.includes(`operationId=${operation.id}&amp;sourceId=${encodeURIComponent(source)}`));
    assert.ok(html.includes(`section=sources&amp;source=${encodeURIComponent(source)}&amp;view=data`));
    assert.doesNotMatch(html, /name="workersStopped"|data-managed-fhir-server|action="[^"]*logs\/clear|action="[^"]*certs\/regenerate/);
    const stale = require('../src/routes/ui')._test.renderAdminHtml({ query: { section: 'maintenance', source: 'removed-source' } });
    assert.match(stale, /no longer configured/); assert.ok(!stale.includes(`Saved operation · ${operation.id}`));
});

test('existing maintenance/checkpoint/active-operation fences refuse reset and restore before mutation; passive review creates no fence', async () => {
    const before = bytes(), state = graph();
    const html = await fetch(base + '/admin?section=maintenance', { headers }); assert.equal(html.status, 200); await html.text();
    assert.equal(fs.existsSync(require('../../shared/migration-maintenance').fencePath(process.env.STATE_DIR)), false);
    const fence = require('../../shared/migration-maintenance').fencePath(process.env.STATE_DIR); fs.writeFileSync(fence, 'owned fixture');
    for (const route of ['/admin/reset', '/admin/restore']) assert.equal((await request(route, {})).status, 503);
    fs.rmSync(fence);
    const root = path.join(process.env.STATE_DIR, 'pcm-ig-041'); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'manifest.json'), '{}');
    for (const route of ['/admin/reset', '/admin/restore']) assert.equal((await request(route, {})).status, 409);
    fs.rmSync(root, { recursive: true });
    const operations = path.join(process.env.STATE_DIR, 'data-operations'); fs.mkdirSync(operations, { recursive: true }); fs.writeFileSync(path.join(operations, 'owned-running.json'), JSON.stringify({ id: 'owned-running', phase: 'running' }));
    for (const route of ['/admin/reset', '/admin/restore']) assert.notEqual((await request(route, {})).status, 200);
    fs.rmSync(path.join(operations, 'owned-running.json')); assert.deepEqual(bytes(), before); assert.deepEqual(graph(), state);
});

test('journal cleanup failure reports uncertain503 and blocks new work until the real owned listener stops for reviewed recovery', async () => {
    const payload = await backup(), before = bytes(), remove = fs.rmSync;
    let injected = false;
    fs.rmSync = (target, options) => { if (!injected && target === path.join(process.env.STATE_DIR, 'configuration-mutation/source-publication.json')) { injected = true; throw Error('owned cleanup disk failure'); } return remove(target, options); };
    try { assert.equal((await request('/admin/restore', wrap(payload))).status, 503); } finally { fs.rmSync = remove; }
    assert.equal(injected, true); assert.equal((await request('/admin/reset', {})).status, 503);
    const file = path.join(process.env.STATE_DIR, 'configuration-mutation/source-publication.json'), journal = JSON.parse(fs.readFileSync(file));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    require('../src/source-publication-recovery').recover({ stateDirectory: process.env.STATE_DIR, configPath: process.env.TEAM_CONFIG_PATH, certsDirectory: process.env.CERTS_DIR, workersStopped: true, expectedDigest: require('../../shared/migration-hash').hash(journal) });
    assert.deepEqual(bytes(), before);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});

test('uncertain config restore retains the existing journal/fence and stopped exact-digest recovery restores original bytes', async () => {
    const before = bytes(), payload = await backup(), state = graph(); payload.teamConfig.security.pcmApi.accessTokenExpiresInSeconds = 21;
    const publish = owner.publishTeamConfig, rename = fs.renameSync;
    let injected = false;
    owner.publishTeamConfig = candidate => {
        publish(candidate);
        // Fail the real rollback rename once after actual candidate publication.
        fs.renameSync = (from, to) => { if (!injected && to === process.env.TEAM_CONFIG_PATH) { injected = true; throw Error('owned rollback disk failure'); } return rename(from, to); };
        throw Error('owned after-publication failure');
    };
    try { assert.equal((await request('/admin/restore', wrap(payload))).status, 503); } finally { owner.publishTeamConfig = publish; fs.renameSync = rename; }
    assert.equal(injected, true);
    const journalFile = path.join(process.env.STATE_DIR, 'configuration-mutation', 'source-publication.json'); assert.ok(fs.existsSync(journalFile));
    assert.equal((await request('/admin/reset', {})).status, 503); assert.deepEqual(graph(), state);
    const journal = JSON.parse(fs.readFileSync(journalFile)), recovery = require('../src/source-publication-recovery');
    const options = { stateDirectory: process.env.STATE_DIR, configPath: process.env.TEAM_CONFIG_PATH, certsDirectory: process.env.CERTS_DIR, expectedDigest: require('../../shared/migration-hash').hash(journal) };
    assert.throws(() => recovery.recover(options), /Stop workers/);
    assert.throws(() => recovery.recover({ ...options, workersStopped: true, expectedDigest: 'wrong' }), /Stop workers/);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(server.listening, false, 'the owned runtime listener is actually stopped before explicit recovery');
    recovery.recover({ ...options, workersStopped: true }); assert.deepEqual(bytes(), before); assert.equal(fs.existsSync(journalFile), false);
});
