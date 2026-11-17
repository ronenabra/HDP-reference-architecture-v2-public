'use strict';
/** Consent summaries display exact chosen clauses without interpreting arbitrary filters. */
const test = require('node:test'), assert = require('node:assert/strict');
const { accessSummary } = require('../../shared/ui/approval-scopes');
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
const bucket = '_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests';

test('finite summary preserves per-clause actions, literal dates and independently scoped exclusions', () => {
    const value = `patient/Patient.rs?${V} patient/Observation.s?${bucket}&date=ge2024-01-05T12:00:00.000Z&${V}&_security:not=http://fhir.health.gov.il/cs/il-core-sensitivity-labels|genetics patient/Organization.r?${V}`;
    const result = accessSummary(value);
    assert.equal(result.limited, false); assert.equal(result.rows.length, 3);
    assert.equal(result.rows[0].dates, 'No date restriction');
    assert.equal(result.rows[1].dates, 'From 5 Jan 2024, 12:00:00 UTC');
    assert.equal(result.rows[1].actions, 'Search'); assert.match(result.rows[1].data, /Laboratory tests/);
    assert.match(result.rows[1].restrictions, /Very restricted \(V\), Genetics/);
    assert.doesNotMatch(result.rows[0].restrictions, /Genetics/);
    assert.equal(result.rows[2].actions, 'Read'); assert.equal(value.includes('Past 2 years'), false);
});

test('unknown expressions and invalid dates have an honest limited summary without invented restrictions', () => {
    for (const value of ['  suspect scope  ', '', 'patient/Observation.rs?_filter=anything',
        `patient/Observation.s?date=ge2024-02-31&${V}`, 'patient/Unknown.rs?date=rolling-two-years',
        'patient/Observation.rs?_security=urn:unknown|laboratoryTests',
        'patient/Observation.rs?_security=http://terminology.hl7.org/CodeSystem/v3-ActCode|genetics',
        'patient/Observation.rs?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|constructor',
        'patient/Observation.rs?_security:not=http://fhir.health.gov.il/cs/il-core-sensitivity-labels|__proto__']) {
        const result = accessSummary(value); assert.equal(result.limited, true, value);
        for (const row of result.rows) {
            assert.equal(row.dates, 'See exact permissions');
            assert.doesNotMatch(row.data, /Laboratory tests|function|Object/);
        }
    }
});

test('broad sandbox scope and positive sensitivity alternatives remain explicitly distinct', () => {
    const broad = accessSummary('patient/*.rs'); assert.equal(broad.limited, false);
    assert.match(broad.rows[0].restrictions, /Includes.*R.*V/);
    const exact = 'patient/Observation.rs?_security=http://fhir.health.gov.il/cs/il-core-sensitivity-labels|genetics,http://terminology.hl7.org/CodeSystem/v3-ActCode|HIV';
    const tagged = accessSummary(exact); assert.equal(tagged.limited, false);
    assert.equal(tagged.rows[0].restrictions, 'Requires a label: Genetics or HIV');
    assert.doesNotMatch(tagged.rows[0].restrictions, /Excluded/);
});


test('long finite sensitivity lists have one complete disclosure with clause-specific short labels', () => {
    const tags = require('../../shared/information-buckets').SENSITIVITY_LABELS;
    const exact = 'patient/Observation.s?' + tags.map(tag => `_security:not=${tag.system}|${tag.code}`).join('&');
    const result = accessSummary(exact);
    assert.equal(result.limited, false); assert.match(result.rows[0].restrictions, /12 listed sensitive categories/);
    assert.equal(result.sensitiveDetails.length, 1); assert.match(result.sensitiveDetails[0], /Genetics.*HIV.*Provider-controlled disclosure/);
    assert.equal(accessSummary('patient/Unknown.rs').limited, true);
});

test('optional summary data safely falls back for an older renderer while exact saved text stays available', () => {
    const path = require('node:path'), fs = require('node:fs'), ejs = require('ejs');
    const scope = '  patient/Unknown.rs?_filter=<literal>  ';
    const file = path.resolve(__dirname, '../src/views/consent.ejs');
    const html = ejs.render(fs.readFileSync(file, 'utf8'), { consent: { id: 'older-renderer', status: 'active', patient: { identifier: { value: '000000018' } } },
        teamId: 'owned-fixture', requesterName: 'Requester', serviceName: 'Service', selectedScope: scope,
        lifecycle: { code: 'service-provider-cancelled', label: 'Service Provider cancelled', periodExpired: true, description: 'Cancelled by the provider.', event: null },
        consentPresentation: require('../../shared/consent-presentation'), sourceView: { choices: [], canEdit: false } });
    assert.match(html, /Limited summary/); assert.match(html, /data-approved-scope>  patient\/Unknown.rs\?_filter=&lt;literal&gt;  <\/code>/);
    assert.doesNotMatch(html, /<literal>/); assert.match(html, /Consent details/);
    assert.match(html, /<strong data-help-key="pcm.status">Service Provider cancelled<\/strong>/);
});

test('finite added master direct reads have complete display rows without interpreting new predicates', () => {
    const scope = 'patient/PractitionerRole.r patient/Location.r';
    const summary = accessSummary(scope);
    assert.equal(summary.limited, false);
    assert.deepEqual(summary.rows.map(row => row.actions), ['Read', 'Read']);
    assert.equal(accessSummary(scope + '?unknown=literal').limited, true);
});
