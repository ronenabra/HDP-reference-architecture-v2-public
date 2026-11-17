'use strict';
/** Remaining changed PAGE boundaries: disjoint alternatives, reverse includes, finite master reads and refill failure. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { maintenance, protectedRead, equivalence } = require('./hapi-authorized-search-matrix');
const p = 'authorized-search-', scope = 'patient/Observation.s';
const report = { status: 'running', cases: [] };
/** Require ordinary success while retaining its authoritative current body. */
async function success(query, grant = scope) { const r = await protectedRead(query, grant); assert.equal(r.status, 200, r.text); return r.body; }
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    const configPath = process.env.TEAM_CONFIG_PATH, originalConfig = fs.readFileSync(configPath);
    const first = await maintenance('GET', '/Observation/' + p + '00');
    const second = await maintenance('GET', '/Observation/' + p + '01');
    try {
        await maintenance('PUT', '/Observation/' + first.id, { ...first, status: 'preliminary' });
        const universe = [...Array.from({ length: 25 }, (_, i) => p + String(i).padStart(2, '0')), p + 'performer', p + 'repeated', p + 'foreign', p + 'mixed', p + 'absolute', p + 'unauthorized', p + 'foreign-wrong'];
        for (const [name, grant] of [
            ['disjoint-complete-grants', 'patient/Observation.s?status=final patient/Observation.s?status=preliminary'],
            ['read-only-grant-cannot-broaden-primary-search', 'patient/Observation.s?status=preliminary patient/Observation.r']
        ]) {
            const value = await equivalence(name, grant, '', universe);
            report.cases.push({ name, ids: value.ids });
        }
        const localIds = universe.filter(id => ![p + 'foreign', p + 'mixed', p + 'absolute', p + 'foreign-wrong'].includes(id));
        const referenceScope = 'patient/Observation.s?subject=Patient/' + p + 'patient';
        const residual = await equivalence('unproven-reference-scope-local-residual', referenceScope, '_id=' + localIds.join(','), localIds);
        report.cases.push({ name: 'unproven-reference-scope-local-residual', ids: residual.ids });
        const inherited = await protectedRead('/Observation?_id=' + p + 'foreign&_count=10', referenceScope);
        assert.equal(inherited.status, 500, inherited.text);
        report.cases.push({ name: 'inherited-unproven-reference-filter-foreign-error-preserved', status: inherited.status,
            limitation: 'Pinned ordinary reference-scope matcher throws HAPI-2223 on this foreign reference; no successful set or efficiency claim.' });
        const patientIds = [p + 'patient'];
        for (const [suffix, references] of [['local', ['Patient/' + p + 'patient']],
            ['foreign', ['https://foreign.invalid/fhir/Patient/' + p + 'patient']],
            ['mixed', ['Patient/' + p + 'other', 'https://foreign.invalid/fhir/Patient/' + p + 'patient']]]) {
            const id = p + 'link-' + suffix; patientIds.push(id);
            await maintenance('PUT', '/Patient/' + id, { resourceType: 'Patient', id,
                link: references.map(reference => ({ other: { reference }, type: 'seealso' })) });
        }
        const patients = await success('/Patient?_id=' + patientIds.join(',') + '&_count=10', 'patient/Patient.s');
        assert.deepEqual(patients.entry.map(entry => entry.resource.id).sort(), patientIds.sort());
        report.cases.push({ name: 'Patient-self-id-and-local-foreign-repeated-link-residual', ids: patientIds });
        await maintenance('PUT', '/Observation/' + first.id, first);
        for (const [id, patient] of [['allowed', 'patient'], ['denied', 'other']]) await maintenance('PUT', '/DiagnosticReport/' + p + id, {
            resourceType: 'DiagnosticReport', id: p + id, status: 'final', code: { text: 'Owned reverse include' }, subject: { reference: 'Patient/' + p + patient }, result: [{ reference: 'Observation/' + first.id }] });
        const reverse = await success('/Observation?_id=' + first.id + '&_count=10&_revinclude=DiagnosticReport:result', scope + ' patient/DiagnosticReport.r');
        assert.deepEqual(reverse.entry.filter(entry => entry.search.mode === 'include').map(entry => entry.resource.id), [p + 'allowed']);
        report.cases.push({ name: 'reverse-include-independent-authorization', included: p + 'allowed' });
        for (const type of ['Organization', 'Practitioner', 'PractitionerRole', 'Location']) {
            const id = p + type.toLowerCase(); await maintenance('PUT', '/' + type + '/' + id, { resourceType: type, id });
            assert.equal((await protectedRead('/' + type + '/' + id, 'patient/' + type + '.r')).status, 200);
            assert.equal((await protectedRead('/' + type, 'patient/' + type + '.r')).status, 403);
            report.cases.push({ name: 'finite-master-direct-read-only', type });
        }
        const query = '/Observation?_count=1&_id=' + [0, 1, 2, 3].map(i => p + '0' + i).join(',');
        const initial = await success(query); const next = new URL(initial.link.find(link => link.relation === 'next').url);
        await maintenance('PUT', '/Observation/' + second.id, { ...second, subject: { reference: 'Patient/' + p + 'other' } });
        const config = JSON.parse(originalConfig); config.clinicalQuery = { sources: { 'ho-a': { maxPageRefills: 1 } } }; fs.writeFileSync(configPath, JSON.stringify(config));
        const failed = await protectedRead(next.pathname.replace(/^\/fhir/, '') + next.search, scope);
        assert.equal(failed.status, 503, failed.text);
        fs.writeFileSync(configPath, originalConfig); await maintenance('PUT', '/Observation/' + second.id, second); await success(query);
        report.cases.push({ name: 'refill-exhaustion-and-recovery', status: failed.status });
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(configPath, originalConfig); await maintenance('PUT', '/Observation/' + first.id, first); await maintenance('PUT', '/Observation/' + second.id, second);
        fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
