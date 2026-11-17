'use strict';

/** Owned native Patient/link and representative query cases, with independent explicit expected IDs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { maintenance } = require('./hapi-authorized-search-matrix');
const { native, matches } = require('./gateway-post-search');
const { claims } = require('./hapi-system-workflow-matrix');
const { discoveryScope } = require('./pcm-042-native-fixture');
const p = 'authorized-search-', target = p + 'patient', other = p + 'other';
const report = { status: 'running', cases: [] };

/** Compare complete native results to the authored oracle; retain no bearer credentials. */
async function check(name, path, scope, expected, body, context) {
    const result = await native(path, scope, body, context);
    if (Array.isArray(expected)) {
        assert.equal(result.status, 200, name + ': ' + result.text);
        assert.deepEqual(matches(result).sort(), [...expected].sort(), name);
    } else assert.equal(result.status, expected, name + ': ' + result.text);
    report.cases.push({ name, path, method: body === undefined ? 'GET' : 'POST', status: result.status,
        correlation: result.correlation, ids: result.body?.entry?.map(entry => entry.resource.id), total: result.body?.total });
    return result;
}

/** Exercise native indexed links, scope residuals, transport admission and the existing graph owner. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    try {
        const links = [];
        for (const [suffix, references] of [
            ['foreign', ['https://foreign.invalid/fhir/Patient/' + target]],
            ['mixed', ['Patient/' + other, 'https://foreign.invalid/fhir/Patient/' + target]],
            ['absolute', ['https://ho-a-hapi:8080/fhir/Patient/' + target]],
            ['versioned', ['https://foreign.invalid/fhir/Patient/' + target + '/_history/1']],
            ['unresolved-wrong', ['https://foreign.invalid/fhir/Patient/absent']],
            ['wrong', ['Patient/' + other]]
        ]) {
            const id = p + 'link-' + suffix;
            await maintenance('PUT', '/Patient/' + id, { resourceType: 'Patient', id,
                link: references.map(reference => ({ other: { reference }, type: 'seealso' })) });
            if (!['unresolved-wrong', 'wrong'].includes(suffix)) links.push(id);
        }
        const expected = [target, ...Array.from({ length: 14 }, (_, i) => p + 'link-' + String(i).padStart(2, '0')), ...links];
        for (const method of ['GET', 'POST']) {
            const query = '_count=100&_sort=_id';
            await check('self-and-local-absolute-foreign-mixed-versioned-links-' + method,
                '/Patient' + (method === 'GET' ? '?' + query : '/_search'), 'patient/Patient.s', expected,
                method === 'POST' ? query : undefined);
        }
        for (const alias of ['_count=0', '_summary=count']) {
            const result = await check('Patient-count-' + alias, '/Patient?' + alias, 'patient/Patient.s', []);
            assert.equal(result.body.total, expected.length);
        }
        const total = await check('Patient-accurate-total', '/Patient?_count=100&_total=accurate', 'patient/Patient.s', expected);
        assert.equal(total.body.total, expected.length);
        await check('Patient-read-only-search-refused', '/Patient', 'patient/Patient.r', 403);
        await check('Patient-contradictory-id', '/Patient?_id=' + other, 'patient/Patient.s', []);
        await check('Patient-repeated-id-intersection', '/Patient?_id=' + target + '&_id=' + other, 'patient/Patient.s', []);
        const families = [
            ['Encounter', { status: 'finished', class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' } }, 'subject', 'status=finished'],
            ['Condition', { code: { text: 'Owned condition' } }, 'subject', ''],
            ['MedicationRequest', { status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Owned medication' } }, 'subject', 'status=active'],
            ['RelatedPerson', { active: true }, 'patient', 'active=true'],
            ['DiagnosticReport', { status: 'final', code: { text: 'Owned report' }, result: [{ reference: 'Observation/' + p + '00' }] }, 'subject', 'status=final']
        ];
        for (const [type, fields, reference, filter] of families) {
            for (const [suffix, patient] of [['allowed', target], ['denied', other]]) {
                const id = p + type.toLowerCase() + '-' + suffix;
                await maintenance('PUT', '/' + type + '/' + id, { resourceType: type, id, ...fields, [reference]: { reference: 'Patient/' + patient } });
            }
            await check(type + '-native-compartment-filter', '/' + type + (filter ? '?' + filter : ''), 'patient/' + type + '.s', [p + type.toLowerCase() + '-allowed']);
            for (const suffix of ['allowed', 'denied']) await maintenance('DELETE', '/' + type + '/' + p + type.toLowerCase() + '-' + suffix);
        }
        for (const query of ['subject.identifier=x', 'patient.name=x', '_has:Observation:subject:code=x',
            '_filter=_id%20eq%20x', '_lastUpdated=ge2020-01-01', '_elements=identifier']) {
            for (const method of ['GET', 'POST']) {
                const result = await native('/Patient' + (method === 'POST' ? '/_search' : '?' + query), 'patient/Patient.s', method === 'POST' ? query : undefined);
                assert.ok([400, 403].includes(result.status), query + ' ' + result.text);
                report.cases.push({ name: 'unsupported-' + method, query, status: result.status, correlation: result.correlation });
            }
        }
        await check('split-URL-form-chain-refused', '/Patient/_search?patient.name=x', 'patient/Patient.s', 403, '_count=1');
        const graphScope = 'patient/Patient.s patient/Observation.s';
        for (const path of ['/Patient/' + target + '/$everything?_count=1', '/Patient/$everything?_type=Patient&_count=100']) {
            const r = await native(path, graphScope); assert.equal(r.status, 200, r.text);
            if (path.includes('_type=Patient')) assert.deepEqual(matches(r), [target]);
            else {
                assert.ok(r.body.link.some(link => link.relation === 'next'));
                const url = new URL(r.body.link.find(link => link.relation === 'next').url);
                await check('everything-fresh-continuation', url.pathname.replace(/^\/fhir/, '') + url.search, graphScope, 200);
            }
            report.cases.push({ name: 'everything-native-target', path, status: r.status });
        }
        await check('everything-wrong-target', '/Patient/' + other + '/$everything', graphScope, 403);
        await check('everything-POST-refused', '/Patient/' + target + '/$everything', graphScope, 403, '');
        for (const query of ['_summary=count', '_total=accurate', 'date=ge2020-01-01', '_count=0', '_filter=x']) {
            await check('everything-unsupported-control', '/Patient/$everything?' + query, graphScope, 400);
        }
        const representative = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '999999' };
        await check('everything-no-Patient-Contract-refused', '/Patient/$everything', discoveryScope(representative), 403,
            undefined, { ...claims('dependent-discovery'), representative_identifier: representative });
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
/** Measure a path containing many unrelated foreign URLs without projecting their source IDs. */
async function exceptionalCost() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    for (let offset = 0; offset < 1000; offset += 100) {
        await maintenance('POST', '', { resourceType: 'Bundle', type: 'transaction',
            entry: Array.from({ length: 100 }, (_, i) => {
                const id = 'patient-exception-cost-' + (offset + i);
                return { resource: { resourceType: 'Patient', id, link: [{ type: 'seealso',
                    other: { reference: 'https://foreign.invalid/fhir/Patient/unrelated-' + (offset + i) } }] },
                request: { method: 'PUT', url: 'Patient/' + id } };
            }) });
    }
    const expected = [target, ...Array.from({ length: 14 }, (_, i) => p + 'link-' + String(i).padStart(2, '0')),
        ...['local', 'foreign', 'absolute', 'mixed', 'versioned'].map(suffix => p + 'link-' + suffix)].sort();
    const { traverse } = require('./hapi-authorized-search-matrix');
    const result = await traverse('unrelated-exceptional-reference-cost', '/Patient?_count=10', 'patient/Patient.s', expected);
    assert.ok(result.pages[0].work.candidateIdVisits <= 128, JSON.stringify(result.pages[0]));
    assert.ok(result.pages[0].work.bodyVisits <= 128, JSON.stringify(result.pages[0]));
    fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify({ status: 'pass', unrelatedForeignLinks: 1000, ...result }, null, 2));
}
/** Exercise complete token/date grants and repeated AND/comma OR client filters on one owned body. */
async function filterCases() {
    const id = p + '00', original = await maintenance('GET', '/Observation/' + id);
    const tag = 'urn:patient-selection|allowed', category = 'http://terminology.hl7.org/CodeSystem/observation-category|laboratory';
    try {
        await maintenance('PUT', '/Observation/' + id, { ...original, meta: { ...original.meta,
            tag: [{ system: 'urn:patient-selection', code: 'allowed' }] },
            category: [{ coding: [{ system: category.split('|')[0], code: 'laboratory' }] }] });
        await check('client-complete-token-date-AND-OR', '/Observation?_id=' + id
            + '&status=final,preliminary&status=final&code=http://loinc.org|718-7&category=' + category
            + '&date=ge2025-01-01&_tag=' + tag + '&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests',
        'patient/Observation.s', [id]);
        await check('scope-complete-tag-category-date', '/Observation?_id=' + id,
            'patient/Observation.s?_tag=' + tag + '&category=' + category + '&date=ge2025-01-01', [id]);
        await check('scope-client-contradiction', '/Observation?_id=' + id + '&status=preliminary',
            'patient/Observation.s?status=final', []);
        await check('scope-security-not', '/Observation?_id=' + id,
            'patient/Observation.s?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V', [id]);
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { await maintenance('PUT', '/Observation/' + id, original);
        fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
module.exports = { main, exceptionalCost, filterCases };
