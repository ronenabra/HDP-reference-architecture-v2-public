'use strict';
/** Certificate inventory boundaries, passive handoff and protected actual portable exports. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { inventory } = require('../src/admin-certificates');
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime();
fs.cpSync(require('../../../test-support/certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
const directory = process.env.CERTS_DIR;
const { getConfiguredDataSources } = require('../src/data-sources');
const router = require('../src/routes/ui');
const sources = () => getConfiguredDataSources(config, { includeDisabled: true });
const projection = options => inventory(config, directory, { sources: sources(), clients: require('../src/store').buildClients(), ...options });

/** Hash every owned credential, without persisting credential bytes in test evidence. */
function hashes() { return Object.fromEntries(fs.readdirSync(directory).filter(name => fs.statSync(path.join(directory, name)).isFile()).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')])); }

/** Decode this application's stored ZIP members to verify actual exported content. */
function zipFiles(buffer) {
    const result = {}; let offset = 0;
    while (buffer.readUInt32LE(offset) === 0x04034b50) {
        assert.equal(buffer.readUInt16LE(offset + 8), 0);
        const size = buffer.readUInt32LE(offset + 18), length = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
        const name = buffer.subarray(offset + 30, offset + 30 + length).toString();
        const start = offset + 30 + length + extra; result[name] = buffer.subarray(start, start + size).toString(); offset = start + size;
    }
    return result;
}

test('owner/role projection covers shared ES256, separate ES384, every source and system client without key contents', () => {
    const result = projection();
    const primary = result.rows.filter(row => row.owner.id === config.organizations.serviceProvider.id);
    assert.equal(primary.length, 2); assert.ok(primary.every(row => row.profile.startsWith('Shared')));
    assert.ok(primary.every(row => row.algorithm === 'ES256' && row.registration === 'Matches current PCM client resolver'));
    const secondary = result.rows.find(row => row.owner.id === config.organizations.hospitalBServiceProvider.id && row.role === 'assertion');
    assert.equal(secondary.algorithm, 'ES384'); assert.equal(secondary.profile, 'Separate or public-only role');
    for (const source of sources()) assert.ok(result.rows.some(row => row.owner.id === source.id));
    for (const client of Object.values(config.oauthClients)) assert.ok(result.rows.some(row => row.owner.clientId === client.clientId));
    assert.ok(result.rows.some(row => row.owner.kind === 'Negative fixture'));
    assert.ok(result.rows.some(row => row.owner.kind === 'Protected authority'));
    assert.ok(result.rows.every(row => row.loaded === 'Unknown — listener adoption not checked'));
    assert.doesNotMatch(JSON.stringify(result), /BEGIN|PRIVATE KEY|privateKey|\.key"/);
});

test('missing, invalid, expired, future, mismatched pairs and registrations remain independent honest facts', () => {
    const candidate = structuredClone(config);
    candidate.certificateRoles.serviceProvider.mtls.key = 'hospital-b-sp.key';
    candidate.certificateRoles.hospitalBServiceProvider.assertion.cert = 'missing.crt';
    candidate.organizations.serviceProvider.assertionCertificates = { ES384: candidate.certificateRoles.serviceProvider.assertion.cert };
    const clients = require('../src/store').buildClients().map(client => ({ ...client, mtlsThumbprint: 'different' }));
    const facts = inventory(candidate, directory, { sources: sources(), clients, now: Date.now() + 1000 * 86400 * 2000 });
    const primary = facts.rows.find(row => row.owner.id === candidate.organizations.serviceProvider.id && row.role === 'mtls');
    assert.equal(primary.material, 'Certificate/key mismatch'); assert.equal(primary.validity, 'Expired'); assert.equal(primary.registration, 'PCM client registration mismatch');
    assert.equal(facts.rows.find(row => row.role === 'assertion' && row.owner.id === candidate.organizations.serviceProvider.id).material, 'Registered algorithm mismatch');
    const missing = facts.rows.find(row => row.role === 'assertion' && row.owner.id === candidate.organizations.hospitalBServiceProvider.id);
    assert.equal(missing.fingerprint, ''); assert.equal(missing.validity, 'Unknown');
    assert.equal(projection({ now: 0 }).rows.find(row => row.role === 'mtls').validity, 'Not yet valid');
    const resolver = require('../src/store').buildClients(); resolver.find(client => client.clientId === config.organizations.serviceProvider.clientId).assertionKeyPaths = { ES256: path.join(directory, 'presence-orchestrator-assertion.crt') };
    assert.equal(projection({ clients: resolver }).rows.find(row => row.owner.id === config.organizations.serviceProvider.id && row.role === 'assertion').registration, 'Not registered for assertions by current PCM resolver');
    candidate.certificateRoles.serviceProvider.mtls.cert = 'sp-client.key';
    assert.equal(inventory(candidate, directory).rows.find(row => row.role === 'mtls' && row.owner.id === candidate.organizations.serviceProvider.id).fingerprint, '');
});

test('unknown/public-only owners, ambiguous clients, invalid paths and disabled sources never borrow another identity', () => {
    const candidate = structuredClone(config);
    candidate.certificateRoles.unknown = { assertion: { cert: '../outside.crt', key: '../outside.key' } };
    const source = { id: 'source:unusual/a', name: 'Same label', clientId: 'duplicate', enabled: false, pcmClientAuth: { cert: 'sp-client-assertion.crt' } };
    const facts = inventory(candidate, directory, { sources: [source], files: ['sp-client.crt'], clients: [{ clientId: 'duplicate' }, { clientId: 'duplicate' }] });
    const sourceRows = facts.rows.filter(row => row.owner.id === source.id);
    assert.ok(sourceRows.filter(row => ['mtls', 'assertion'].includes(row.role)).every(row => row.registration.startsWith('Disabled')));
    assert.ok(facts.rows.some(row => row.owner.kind === 'Unknown owner'));
    assert.equal(facts.rows.find(row => row.owner.id === 'role:unknown').fingerprint, '');
    source.enabled = true;
    assert.ok(inventory(candidate, directory, { sources: [source], clients: [{ clientId: 'duplicate' }, { clientId: 'duplicate' }] }).rows.filter(row => row.owner.id === source.id && ['mtls', 'assertion'].includes(row.role)).every(row => row.registration.startsWith('Unknown — ambiguous')));
});

test('actual rendered inventory escapes stale owners and preserves exact app/source context and safe login return', () => {
    const render = query => router._test.renderAdminHtml({ query: { section: 'certificates', ...query } });
    const html = render({ owner: config.organizations.serviceProvider.id });
    assert.match(html, /Open app registration/); assert.match(html, /#provider-serviceProvider/); assert.doesNotMatch(html, /BEGIN.*PRIVATE KEY/);
    const source = sources()[0]; const scoped = render({ owner: source.id });
    assert.ok(scoped.includes(`source=${encodeURIComponent(source.id)}&amp;view=credentials`));
    const stale = render({ owner: '<script>removed</script>' });
    assert.match(stale, /no longer configured/); assert.doesNotMatch(stale, /data-credential-row|<script>removed/);
    assert.equal(require('../src/routes/admin-shell').safeReturn('/admin?section=certificates&owner=source%3Ax&token=secret', ''), '/admin?section=certificates&owner=source%3Ax');
});

test('protected JSON and ZIP contain the actual file roles/private keys; review never changes credentials/config/tokens', async t => {
    process.env.TEAM_ADMIN_PASSWORD = 'owned-certificate29';
    const app = require('../src/index').createUiApp(), server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { app.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.TEAM_ADMIN_PASSWORD; });
    const base = `http://127.0.0.1:${server.address().port}`, headers = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Accept: 'application/json' };
    const before = hashes(), configBefore = fs.readFileSync(process.env.TEAM_CONFIG_PATH), tokensBefore = require('../src/store').tokens.size;
    for (const route of ['/admin/certs/download-bundle', '/admin/certs/download-zip']) assert.equal((await fetch(base + route)).status, 401);
    assert.equal((await fetch(base + '/admin/certs/regenerate', { method: 'POST' })).status, 401);
    const row = projection().rows.find(row => row.owner.id === config.organizations.serviceProvider.id && row.role === 'assertion');
    const selection = new URLSearchParams({owner:row.owner.id,role:row.role,fingerprint:row.fingerprint});
    const certificateUrl = base + '/admin/certs/certificate?' + selection;
    assert.equal((await fetch(certificateUrl)).status,401);
    const certificate = await fetch(certificateUrl,{headers}); assert.equal(certificate.status,200); assert.equal(certificate.headers.get('cache-control'),'no-store');
    const pem = await certificate.text(); assert.equal(new crypto.X509Certificate(pem).fingerprint256,new crypto.X509Certificate(fs.readFileSync(path.join(directory,row.file))).fingerprint256);
    assert.match(pem,/BEGIN CERTIFICATE/);assert.doesNotMatch(pem,/PRIVATE KEY/);assert.match(certificate.headers.get('content-disposition'),/certificate.pem/);
    for (const patch of [{owner:'missing'}, {role:'not-the-role'}, {fingerprint:'A'.repeat(43)}]) {
        const params = new URLSearchParams({...Object.fromEntries(selection),...patch});
        assert.equal((await fetch(base+'/admin/certs/certificate?'+params,{headers})).status,404);
    }
    assert.equal((await fetch(certificateUrl+'&path=rootCA.key',{headers})).status,400);
    assert.equal((await fetch(base+'/admin/certs/certificate?owner=../rootCA.key&role=assertion&fingerprint=x',{headers})).status,404);
    const response = await fetch(base + '/admin/certs/download-bundle', { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-disposition'), /attachment/);
    const bundle = await response.json(); assert.match(bundle.warning, /Private keys/); assert.match(bundle.scope, /not a complete team backup/);
    const zipped = await fetch(base + '/admin/certs/download-zip', { headers }); assert.equal(zipped.headers.get('cache-control'), 'no-store');
    const files = zipFiles(Buffer.from(await zipped.arrayBuffer())); assert.deepEqual(files, bundle.certificates);
    for (const name of ['rootCA.key', 'sp-client-assertion.key', 'hospital-b-sp.key', 'hospital-b-sp-assertion.key']) assert.equal(files[name], fs.readFileSync(path.join(directory, name), 'utf8'));
    for (const row of bundle.roles.rows.filter(row => row.fingerprint)) assert.ok(bundle.certificates[row.file]);
    const review = await fetch(base + '/admin/certs/regenerate', { method: 'POST', headers }); assert.equal(review.status, 409); assert.equal((await review.json()).rootChanged, false);
    const htmlReview = await fetch(base + '/admin/certs/regenerate', { method: 'POST', headers: { ...headers, Accept: 'text/html' } });
    assert.equal(htmlReview.status, 409); const html = await htmlReview.text(); assert.match(html, /Renew team-managed certificates/); assert.match(html, /--rotate-keys/); assert.match(html, /No credentials were changed/); assert.doesNotMatch(html, /Could not complete admin action|BEGIN.*PRIVATE KEY/);
    const status = await fetch(base + '/admin/status', { headers }); assert.doesNotMatch(JSON.stringify(await status.json()), /BEGIN.*PRIVATE KEY/);
    assert.deepEqual(hashes(), before); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), configBefore); assert.equal(require('../src/store').tokens.size, tokensBefore);
});


test('certificate-only resolver strips appended keys and rejects missing, changed, ambiguous or unregistered bindings', () => {
    const {publicCertificate}=require('../src/admin-certificates');
    const row=projection().rows.find(row=>row.owner.id===config.organizations.serviceProvider.id&&row.role==='assertion');
    const selection={owner:row.owner.id,role:row.role,fingerprint:row.fingerprint}, target=path.join(directory,row.file), original=fs.readFileSync(target);
    try {
        fs.appendFileSync(target,fs.readFileSync(path.join(directory,'sp-client.key')));
        const pem=publicCertificate(directory,{rows:[row]},selection); assert.doesNotMatch(pem,/PRIVATE KEY/);assert.equal((pem.match(/BEGIN CERTIFICATE/g)||[]).length,1);
        assert.throws(()=>publicCertificate(directory,{rows:[row,row]},selection),/unavailable/);
        assert.throws(()=>publicCertificate(directory,{rows:[{...row,owner:{...row.owner,kind:'Unknown owner'}}]},selection),/unavailable/);
        fs.writeFileSync(target,'invalid');assert.throws(()=>publicCertificate(directory,{rows:[row]},selection),/changed or is unavailable/);
        fs.rmSync(target);assert.throws(()=>publicCertificate(directory,{rows:[row]},selection),/changed or is unavailable/);
    } finally {fs.writeFileSync(target,original);}
});
