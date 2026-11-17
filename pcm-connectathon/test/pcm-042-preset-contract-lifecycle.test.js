'use strict';
/** All-preset integration of the maintained private Contract boundary and actual token repositories.
 * Registered-actor authentication is supplied by the named grant harness; no HTTP mutation or cryptography is claimed.
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const test = require('node:test'), assert = require('node:assert/strict');
const root = process.env.PCM_04109_ROOT || path.resolve(__dirname, '../..');
const load = name => require(path.join(root, name));
const { grantHarness, requested } = load('test-support/pcm-042-grants');
const { NOW } = load('test-support/data-grants');
const { PRESETS } = load('src/shared/conformance-policy');
const { scenarioOf, updatePolicy, transitionPolicy, provisionSystemPolicies, buildSystemPolicies, evaluatePolicy } = load('src/pcm-core/src/fhir/system-policy');
const { previewCatalog, reconcileCatalog } = load('src/pcm-core/src/catalog-bootstrap');
const scenarios = ['presence-check', 'patient-authentication', 'dependent-discovery'];
const rows = [], expectedCases = PRESETS.length * scenarios.length * 6;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Save the reviewed synthetic graph before the maintained coupled catalog publication. */
function reconcile(f) {
    const proposed = buildSystemPolicies(f.config, NOW + 1);
    let backedUp = false;
    reconcileCatalog(f.store, proposed, previewCatalog(f.store, proposed).versions, backup => {
        const file = path.join(f.directory, `reviewed-backup-${crypto.randomUUID()}.json`), bytes = JSON.stringify(backup);
        const fd = fs.openSync(file, 'wx');
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        assert.equal(hash(fs.readFileSync(file)), hash(bytes)); backedUp = true;
    });
    assert.equal(backedUp, true);
}

/** Execute one isolated real-store/issuer/introspection case without changing any preset control. */
function boundary(preset, scenario, name, operation) {
    test(`${preset} ${scenario}: ${name}`, () => {
        const f = grantHarness(preset), controls = structuredClone(f.config.securitySimulation);
        try {
            const contract = f.store.getAll('Contract').find(value => scenarioOf(value) === scenario);
            assert.ok(contract); assert.equal(contract.status, 'executed');
            const issued = f.issue(scenario); assert.equal(issued.status, 200, JSON.stringify(issued));
            assert.equal(f.inspect(issued.body.access_token).body.active, true);
            const context = issued.body.authorization_details[0].fhirContext;
            assert.equal(context[0].identifier.value, contract.identifier[0].value);
            assert.ok(!context.some(value => value.type === 'HealthcareService'));
            operation(f, contract, issued);
            assert.deepEqual(f.config.securitySimulation, controls);
            assert.equal(f.config.conformance.preset, preset);
            rows.push({ preset, scenario, case: name, status: 'pass', executed: true,
                contractBusinessIdentifier: contract.identifier[0], controlsPreserved: true,
                notice: preset === 'strict' ? 'Strict system authority invariants' : 'CONNECTATHON COMPATIBILITY — NOT CONFORMANT; system authority invariants retained' });
        } finally { f.close(); }
    });
}
for (const preset of PRESETS) for (const scenario of scenarios) {
    for (const terminal of ['terminated', 'revoked', 'entered-in-error']) boundary(preset, scenario, terminal, (f, contract, issued) => {
        transitionPolicy(f.store, contract.id, terminal, f.config);
        assert.equal(f.issue(scenario).status, 400);
        assert.equal(f.inspect(issued.body.access_token).body.active, false);
        for (const next of ['executed', 'terminated', 'revoked', 'entered-in-error']) {
            assert.throws(() => transitionPolicy(f.store, contract.id, next, f.config), /terminal/);
        }
        provisionSystemPolicies(f.store, f.config, NOW + 1); reconcile(f);
        const retained = f.store.get('Contract', contract.id);
        assert.equal(retained.status, terminal); assert.deepEqual(retained.identifier, contract.identifier);
        assert.deepEqual(retained.applies, contract.applies);
        assert.equal(f.issue(scenario).status, 400);
        assert.equal(f.inspect(issued.body.access_token).body.active, false);
    });
    boundary(preset, scenario, 'source removal/readd fences old authority and catalog cannot restore removed membership', (f, contract, issued) => {
        const removed = structuredClone(contract), target = `Organization/${f.source.dataSourceOrganization.id}`;
        removed.term[0].asset = removed.term[0].asset.filter(asset => asset.context[0].reference.reference !== target);
        updatePolicy(f.store, removed, f.config);
        assert.equal(f.issue(scenario).status, 400);
        assert.equal(f.inspect(issued.body.access_token).body.active, false);
        provisionSystemPolicies(f.store, f.config, NOW + 1); reconcile(f);
        const retained = f.store.get('Contract', contract.id);
        assert.deepEqual(retained.term[0].asset, removed.term[0].asset);
        assert.deepEqual(retained.identifier, contract.identifier);
        updatePolicy(f.store, { ...retained, term: contract.term }, f.config);
        const fresh = f.issue(scenario); assert.equal(fresh.status, 200);
        assert.equal(f.inspect(fresh.body.access_token).body.active, true);
        assert.equal(f.inspect(issued.body.access_token).body.active, false);
        assert.deepEqual(fresh.body.authorization_details, issued.body.authorization_details);
    });
    boundary(preset, scenario, 'shortened validity preserves identity, rejects extension and separates inclusive Contract end from token expiry', (f, contract, issued) => {
        const shortened = { ...contract, applies: { ...contract.applies, end: new Date((NOW + 60) * 1000).toISOString() } };
        updatePolicy(f.store, shortened, f.config);
        assert.equal(f.inspect(issued.body.access_token).body.active, false);
        const current = f.issue(scenario); assert.equal(current.status, 200); assert.ok(current.body.expires_in <= 60);
        assert.deepEqual(current.body.authorization_details, issued.body.authorization_details);
        const retained = f.store.get('Contract', contract.id);
        for (const change of [value => { value.applies.end = new Date((NOW + 61) * 1000).toISOString(); },
            value => { value.identifier[0].value += '-replacement'; }, value => { value.applies.start = new Date((NOW - 1) * 1000).toISOString(); }]) {
            const invalid = structuredClone(retained); change(invalid); assert.throws(() => updatePolicy(f.store, invalid, f.config));
            assert.deepEqual(f.store.get('Contract', contract.id), retained);
        }
        reconcile(f); assert.deepEqual(f.store.get('Contract', contract.id).applies, shortened.applies);
        const key = { 'presence-check': 'presenceOrchestrator', 'patient-authentication': 'authenticationOrchestrator', 'dependent-discovery': 'discoveryOrchestrator' }[scenario];
        const policyInput = { store: f.store, config: f.config, identifier: contract.identifier[0], clientId: f.config.oauthClients[key].clientId, targetOrganizationId: f.source.dataSourceOrganization.id };
        assert.ok(evaluatePolicy({ ...policyInput, now: NOW + 60 }));
        assert.equal(evaluatePolicy({ ...policyInput, now: NOW + 60.001 }), null);
        f.setNow(NOW + 60); assert.equal(f.inspect(current.body.access_token).body.active, false);
        assert.equal(f.issue(scenario).status, 400);
    });
    boundary(preset, scenario, 'structural eligibility/trusted invocation is mandatory with unchanged disabled controls', (f, contract, issued) => {
        if (scenario === 'presence-check') {
            const eligible = f.config.systemAuthorization.presenceEligiblePatients;
            f.config.systemAuthorization.presenceEligiblePatients = [];
            assert.equal(f.issue(scenario).status, 400); assert.equal(f.inspect(issued.body.access_token).body.active, false);
            f.config.systemAuthorization.presenceEligiblePatients = eligible;
            assert.equal(f.issue(scenario).status, 200); assert.equal(f.inspect(issued.body.access_token).body.active, false);
        } else {
            const key = scenario === 'patient-authentication' ? 'authenticationOrchestrator' : 'discoveryOrchestrator';
            const scope = scenario === 'patient-authentication' ? 'patient/Patient.s' : 'system/Patient.s system/RelatedPerson.s';
            f.setInvocation(null);
            const result = f.service({ clientId: f.config.oauthClients[key].clientId, body: { ...f.body, scope,
                authorization_details: requested('Contract', contract.identifier[0].value, scenario === 'patient-authentication' ? [f.strongPatient] : []) } });
            assert.equal(result.status, 400); assert.equal(f.inspect(issued.body.access_token).body.active, false);
            assert.equal(f.issue(scenario).status, 200); assert.equal(f.inspect(issued.body.access_token).body.active, false);
        }
    });
}

test.after(() => {
    if (!process.env.PCM_CONTRACT_BOUNDARY_OUTPUT) return;
    const sources = ['src/pcm-core/src/fhir/system-policy.js', 'src/pcm-core/src/fhir/system-contract.js', 'src/pcm-core/src/catalog-bootstrap.js',
        'src/pcm-core/src/data-grant.js', 'src/pcm-core/src/grant-authority-state.js', 'src/pcm-core/src/token-service.js', 'src/pcm-core/src/introspection-service.js',
        'src/pcm-core/src/token-store.js', 'src/shared/pcm-contract.js', 'src/shared/conformance-policy.js', 'test-support/pcm-042-grants.js', 'test-support/data-grants.js', 'test-support/team-config.js'];
    const inputHashes = Object.fromEntries(sources.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
    fs.writeFileSync(process.env.PCM_CONTRACT_BOUNDARY_OUTPUT, JSON.stringify({ status: rows.length === expectedCases ? 'pass' : 'fail',
        kind: 'maintained-private-boundary-integration', node: process.version, expectedCases, passedCases: rows.length,
        authenticationFixture: 'grantHarness supplies registered actors; transport/assertion cryptography is independently covered by full protocol scenarios, not this test',
        noHttpMutationClaim: true, inputHashes, rows }, null, 2));
});
