'use strict';

/** Shared browser/server advice. This helper never authorizes or rejects approval. */
(function (root) {
    /** Return readable warnings for a supplied scope and the service's known types. */
    function scopeWarnings(scope, resourceTypes = []) {
        const warnings = new Set();
        if (!scope || scope.trim() !== scope || /\s{2,}|[\t\r\n]/.test(scope)) warnings.add('Enter at least one scope. Separate scopes with a single space.');
        for (const token of scope.split(' ')) {
            const match = /^patient\/([A-Z][A-Za-z]+)\.(r|s|rs)(?:\?(.+))?$/.exec(token);
            if (!match) { warnings.add('Use a scope such as patient/Observation.rs. r allows reading an individual record; s allows searching.'); continue; }
            if (!resourceTypes.includes(match[1])) warnings.add(`${match[1]} is not among this service's known data types. The scope can be saved, but may fail when used.`);
            if (match[3]) for (const filter of match[3].split('&')) {
                if (!/^(?:status|category|code|_security(?::not)?|date|authoredon|effective|effective-time|whenhandedover|recorded-date)=[^\s&=]+$/.test(filter)) {
                    warnings.add('A filter may have invalid syntax or may not be supported. Saving the scope does not validate the filter.');
                }
            }
        }
        return [...warnings];
    }

    /** Project only the finite forms used by this UI; never validate or manufacture authority.
     * Unknown/custom predicates retain an explicitly limited summary and exact text.
     * @param {string} scope Exact selected or saved text, unchanged by this projection.
     * @returns {{rows: object[], sensitiveDetails: string[], limited: boolean}} Readable facts only.
     */
    function accessSummary(scope) {
        const categories = { laboratoryTests: 'Laboratory tests', medications: 'Medications', procedures: 'Procedures',
            diagnoses: 'Diagnoses', allergiesAndIntolerances: 'Allergies and intolerances', encounterInformation: 'Encounters', immunizations: 'Immunizations' };
        const sensitivity = { genetics: 'Genetics', 'mental-health': 'Mental health', gynecology: 'Gynecology', fertility: 'Fertility',
            'adoption-surrogacy': 'Adoption/surrogacy', 'domestic-violence': 'Domestic violence', 'sexual-violence': 'Sexual violence',
            'social-work': 'Social work', HIV: 'HIV', PHY: 'Physician-requested sensitivity', PRS: 'Patient-requested sensitivity', NOPAT: 'Provider-controlled disclosure' };
        const confidentiality = 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality';
        const bucketSystems = ['http://fhir.health.gov.il/cs/il-hdp-information-buckets', 'http://pcm.fhir.health.gov.il/cs/pcm-information-buckets'];
        // A familiar code under a different code system remains an unknown expression.
        const sensitivityLabel = (system, code) => {
            const actCode = ['HIV', 'PHY', 'PRS', 'NOPAT'].includes(code);
            return system === (actCode ? 'http://terminology.hl7.org/CodeSystem/v3-ActCode' : 'http://fhir.health.gov.il/cs/il-core-sensitivity-labels') && Object.hasOwn(sensitivity, code) ? sensitivity[code] : undefined;
        };
        if (scope === 'patient/*.rs') return { rows: [{ data: 'All supported patient data', actions: 'Read and search', dates: 'No date restriction', restrictions: 'Includes restricted (R), very restricted (V) and sensitive categories' }], sensitiveDetails: [], limited: false };
        const rows = [], sensitiveDetails = [];
        let limited = !scope || scope.trim() !== scope || /\s{2,}|[\t\r\n]/.test(scope);
        for (const token of scope.split(' ').filter(Boolean)) {
            const match = /^patient\/([A-Z][A-Za-z]+)\.(r|s|rs)(?:\?(.+))?$/.exec(token);
            if (!match) { limited = true; continue; }
            if (!['Patient', 'Observation', 'DiagnosticReport', 'MedicationRequest', 'MedicationStatement', 'MedicationAdministration', 'MedicationDispense', 'Procedure', 'Condition', 'AllergyIntolerance', 'Encounter', 'Immunization', 'Organization', 'Practitioner', 'PractitionerRole', 'Location'].includes(match[1])) limited = true;
            const row = { data: match[1] === 'Patient' ? 'Patient records' : match[1], actions: { r: 'Read', s: 'Search', rs: 'Read and search' }[match[2]], dates: 'No date restriction', restrictions: 'No sensitive-data exclusion in this clause' };
            const labels = [], excluded = [], excludedSensitive = [], required = [], dates = [];
            let unknown = false;
            for (const part of (match[3] || '').split('&').filter(Boolean)) {
                const equal = part.indexOf('='), key = part.slice(0, equal), value = part.slice(equal + 1);
                const [system, code, extra] = value.split('|');
                if (equal < 1) { unknown = true; continue; }
                if (key === '_security' && bucketSystems.includes(system) && Object.hasOwn(categories, code) && !extra) labels.push(categories[code]);
                else if (key === '_security' && value.split(',').every(tag => { const [sys, code, extra] = tag.split('|'); return sensitivityLabel(sys, code) && !extra; })) required.push(...value.split(',').map(tag => sensitivityLabel(...tag.split('|'))));
                else if (key === '_security:not' && system === confidentiality && ['R', 'V'].includes(code) && !extra) excluded.push(code === 'R' ? 'Restricted (R)' : 'Very restricted (V)');
                else if (key === '_security:not' && sensitivityLabel(system, code) && !extra) excludedSensitive.push(sensitivityLabel(system, code));
                else if (['date', 'authoredon', 'effective', 'effective-time', 'whenhandedover', 'recorded-date'].includes(key)
                    && /^ge\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value.slice(2))) && new Date(value.slice(2)).toISOString().startsWith(value.slice(2, 12))) dates.push('From ' + new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', ...(value.includes('T') ? { timeStyle: 'long' } : {}), timeZone: 'UTC' }).format(new Date(value.slice(2))));
                else unknown = true;
            }
            if (labels.length) row.data += ' · ' + [...new Set(labels)].join(', ');
            if (dates.length) row.dates = dates.join('; ');
            const uniqueSensitive = [...new Set(excludedSensitive)];
            if (uniqueSensitive.length > 3) {
                excluded.push(uniqueSensitive.length + ' listed sensitive categories');
                sensitiveDetails.push(row.data + ': ' + uniqueSensitive.join(', '));
            } else excluded.push(...uniqueSensitive);
            if (excluded.length) row.restrictions = 'Excluded: ' + [...new Set(excluded)].join(', ');
            if (required.length) row.restrictions = (excluded.length ? row.restrictions + '. ' : '') + 'Requires a label: ' + [...new Set(required)].join(' or ');
            if (unknown) {
                limited = true;
                if (!dates.length) row.dates = 'See exact permissions';
                if (!excluded.length && !required.length) row.restrictions = 'See exact permissions';
            }
            rows.push(row);
        }
        return { rows, sensitiveDetails, limited };
    }

    /** Refresh the local preview without submitting, fetching, or changing submitted bytes. */
    function install(document) {
        const form = document.querySelector('[data-scope-approval]');
        if (form) {
            const input = form.querySelector('[name="customScope"]');
            const choice = form.querySelector('#scope-custom');
            const output = form.querySelector('[data-scope-warnings]');
            const update = () => {
                const selected = form.querySelector('[name="scopeChoice"]:checked');
                const scope = selected?.value === 'custom' ? input.value : selected?.dataset.scopeValue || '';
                const warnings = scopeWarnings(input.value, JSON.parse(form.dataset.scopeTypes));
                output.textContent = choice.checked && warnings.length ? `Advisory warnings: ${warnings.join(' ')}` : '';
                form.querySelector('[data-custom-fields]').hidden = !choice.checked;
                form.querySelector('[data-choice-advice]').textContent = selected?.dataset.scopeAdvice || '';
                const summary = accessSummary(scope), body = form.querySelector('[data-access-rows]');
                body.replaceChildren();
                for (const row of summary.rows) {
                    const tr = document.createElement('tr');
                    for (const [key, label] of [['data', 'Data'], ['actions', 'Actions'], ['dates', 'Record dates'], ['restrictions', 'Sensitive data']]) {
                        const td = document.createElement('td'); td.dataset.label = label; td.textContent = row[key]; tr.append(td);
                    }
                    body.append(tr);
                }
                const details = form.querySelector('[data-sensitive-details]');
                details.hidden = !summary.sensitiveDetails.length;
                details.querySelector('p').textContent = summary.sensitiveDetails.join('; ');
                form.querySelector('[data-access-limited]').hidden = !summary.limited;
                form.querySelector('[data-exact-scope]').textContent = scope;
                form.querySelector('[data-copy-result]').textContent = '';
            };
            input.addEventListener('input', () => { choice.checked = true; update(); });
            form.addEventListener('change', update);
            update();
        }
        document.querySelectorAll('[data-consent-copy]').forEach(button => button.addEventListener('click', async () => {
            const value = document.getElementById(button.dataset.consentCopy), result = document.querySelector('[data-copy-result]');
            const text = value.textContent;
            try {
                await root.navigator.clipboard.writeText(text);
                // A choice may change while clipboard permission is pending.
                if (value.textContent === text) result.textContent = 'Copied.';
            } catch (_) { if (value.textContent === text) result.textContent = 'Copy unavailable. Select the complete value and copy it manually.'; }
        }));
    }
    if (typeof module === 'object' && module.exports) module.exports = { scopeWarnings, accessSummary };
    else { root.scopeWarnings = scopeWarnings; install(root.document); }
})(typeof window === 'undefined' ? globalThis : window);
