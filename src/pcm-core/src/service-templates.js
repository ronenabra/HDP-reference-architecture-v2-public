'use strict';
/** Declarative Services templates validated through the existing ordinary form, mapping and grant compiler. */
const fs = require('node:fs'), path = require('node:path');
const { serviceDefinitionDraft: serviceDefinition, existingRegistration } = require('./service-definition-form');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { masterScopes, masterEnabled, TYPES: MASTER_TYPES, URL: MASTER_URL } = require('../../shared/service-master-data');
const { inspectScope, readServiceGrant } = require('../../shared/service-grant');
const { SYSTEM: CONFIDENTIALITY } = require('../../shared/service-confidentiality-policy');
const lifecycle = require('./fhir/healthcare-service-lifecycle');
const DEFAULT_FILE = fs.existsSync('/workspace/config/service-templates.json') ? '/workspace/config/service-templates.json' : path.resolve(__dirname, '../../../config/service-templates.json');
const fail = message => { throw Object.assign(new Error(`Service templates: ${message}`), { status: 400 }); };
/** Validate a bounded illustrative operation against its declared permission.
 * Patient identity and authorization dates belong to the saved grant/context,
 * so examples need no duplicate patient or history parameters.
 * @param {object} query Maintained type/query metadata.
 * @param {object} permission Declared resource and interaction letters.
 * @returns {void} Throws for unsupported, duplicate or unbounded operations.
 */
function validateExample(query, permission) {
    const prefix = `GET [FHIR BASE]/${permission.type}`;
    if (permission.actions.includes('r') && new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:\\[record-id\\]|[A-Za-z0-9.-]{1,64})$`).test(query)) return;
    if (!permission.actions.includes('s') || !query.startsWith(prefix + '?')) fail(`${permission.type}: example operation exceeds its read/search permission.`);
    const raw = query.slice(prefix.length + 1);
    if (!raw || /[\s#[\]%]/.test(raw) || raw.split('&').some(part => !/^[^=&]+=[^=&]+$/.test(part))) fail(`${permission.type}: use literal maintained parameters without Patient/date placeholders.`);
    const params = new URLSearchParams(raw), names = [...params.keys()];
    if (names.length !== new Set(names).size || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(params.get('_count') || '')) fail(`${permission.type}: search examples require one bounded _count (1–100), without duplicate parameters.`);
    // Reuse the authoring parser's qualified resource-specific token/date subset.
    // _count bounds the client query; it is never added to an OAuth scope.
    const filters = [...params].filter(([name]) => name !== '_count');
    const inspected = inspectScope(`patient/Patient.rs?_security:not=${CONFIDENTIALITY}|V patient/${permission.type}.s?${[...filters.map(([name, value]) => `${name}=${value}`), `_security:not=${CONFIDENTIALITY}|V`].join('&')}`);
    const { syntax, applicability, capability } = inspected.diagnostics;
    if (filters.some(([name]) => name.startsWith('_') || ['patient', 'subject', 'identifier'].includes(name)) || syntax !== 'valid' || applicability !== 'valid' || capability !== 'supported') fail(`${permission.type}: example uses an unsupported resource search parameter or value.`);
}
/** Validate a complete declarative object and return resolved ordinary create bodies.
 * @param {object} value Parsed maintained config.
 * @returns {object[]} Validated metadata, form values, scopes and FHIR requests.
 */
function validateTemplates(value) {
    if (!value || Object.keys(value).some(key => !['schemaVersion', 'templates'].includes(key)) || value.schemaVersion !== 'pcm-service-templates/1' || !Array.isArray(value.templates) || !value.templates.length || value.templates.length > 50) fail('expected version pcm-service-templates/1 and 1–50 definitions.');
    const keys = new Set(), names = new Set();
    return value.templates.map(entry => {
        if (!entry || Object.keys(entry).some(key => !['key', 'summary', 'dataDescription', 'definition', 'exampleQueries'].includes(key)) || !/^[a-z][a-z0-9-]{1,63}$/.test(entry.key || '')) fail('use a stable unique lowercase template key.');
        if (keys.has(entry.key)) fail(`duplicate key ${entry.key}.`); keys.add(entry.key);
        for (const key of ['summary', 'dataDescription']) if (typeof entry[key] !== 'string' || !entry[key].trim() || entry[key].length > 2000) fail(`${entry.key}: ${key} requires readable text (up to 2000 characters).`);
        let request;
        try { request = serviceDefinition(entry.definition); } catch (error) { fail(`${entry.key}: ${error.message}`); }
        const name = request.name.toLowerCase(); if (names.has(name)) fail(`duplicate service name ${request.name}.`); names.add(name);
        const permissions = entry.definition.permissions;
        if (!Array.isArray(entry.exampleQueries) || entry.exampleQueries.length !== permissions.length || new Set(entry.exampleQueries.map(query => query?.type)).size !== permissions.length) fail(`${entry.key}: provide one complete query for every permission type.`);
        for (const query of entry.exampleQueries) {
            if (!query || Object.keys(query).some(key => !['type', 'query'].includes(key)) || !permissions.some(item => item.type === query.type)) fail(`${entry.key}: query types require matching supported read/search permissions.`);
            const permission = permissions.find(item => item.type === query.type);
            if (typeof query.query !== 'string' || query.query.length > 2000 || /[\x00-\x1f\x7f]/.test(query.query)) fail(`${entry.key}: query requires readable operation text (up to 2000 characters).`);
            validateExample(query.query, permission);
        }
        const grant = readServiceGrant(request), parsed = inspectScope(grant.scope);
        if (parsed.diagnostics.syntax !== 'valid' || parsed.diagnostics.applicability !== 'valid' || parsed.diagnostics.capability !== 'supported') fail(`${entry.key}: maintained templates require a usable final scope, not experimental text.`);
        const allowRestricted = entry.definition.confidentialityPolicy?.allowRestricted === true;
        if (parsed.clauses.some(clause => clause.filters.includes(`_security:not=${CONFIDENTIALITY}|R`) === allowRestricted)) fail(`${entry.key}: final R policy must agree with the declared confidentiality policy on every alternative.`);
        if (!allowRestricted && parsed.clauses.some(clause => clause.filters.some(filter => filter.startsWith('_security=') && filter.slice(10).split(',').includes(`${CONFIDENTIALITY}|R`)))) fail(`${entry.key}: a final alternative cannot both request and exclude R.`);
        for (const permission of permissions) if (![...permission.actions].every(action => parsed.clauses.some(clause => clause.type === permission.type && clause.actions.includes(action)))) fail(`${entry.key}: declared example permissions must exist in the final scope.`);
        for (const type of MASTER_TYPES) if (parsed.clauses.some(clause => clause.type === type) !== masterEnabled(request)) fail(`${entry.key}: final master reads must agree with the declared master examples.`);
        request = serviceDefinition(entry.definition, { exampleQueries: entry.exampleQueries });
        const privateCommand = require('./public-fhir').splitProduced(request);
        return { ...structuredClone(entry), request: privateCommand.resource, privateDefinition: privateCommand.definition, scope: entry.definition.scopeOrigin === 'custom' ? entry.definition.approvalScope : [...permissions.map(item => `patient/${item.type}.${item.actions}`), ...masterScopes(request)].join(' ') };
    });
}
/** Read the maintained installation config without changing stored services.
 * @param {string} file Installation path; callers never take it from browser input.
 * @returns {object[]} Fully validated templates.
 */
function loadTemplates(file = DEFAULT_FILE) {
    if (fs.statSync(file).size > 256 * 1024) fail('config file exceeds 256 KiB.');
    return validateTemplates(JSON.parse(fs.readFileSync(file, 'utf8')));
}
/** Compare authored fields without treating state, owner or PCM identifiers as template content.
 * @param {object} service Ordinary API resource or visible canonical definition.
 * @param {object} request Validated ordinary template create body.
 * @returns {boolean} Whether the stored definition is exactly compatible.
 */
function sameDefinition(service, request) {
    if (masterEnabled(service) !== masterEnabled(request)) return false;
    const urls = new Set(request.extension.map(item => item.url));
    // Omitted legacy metadata and explicit false both mean master access off.
    urls.delete(MASTER_URL);
    // Explicit generated origin and omitted legacy origin have identical authority.
    // Custom text/origin remain intentional and must compare exactly.
    const grant = require('../../shared/service-grant');
    // Reusing an unchanged generated definition keeps its original literal dates.
    // Authoring semantics are compared through the ordinary definition fields and
    // selected option below, never by regenerating the retained grant.
    const normalize = extension => {
        if (extension.url === grant.URL) {
            const value = grant.readServiceGrant({ extension: [extension] });
            return { url: grant.URL, model: value.model, compiler: value.compiler, origin: value.origin,
                ...(value.origin === 'custom' ? { scope: value.scope } : {}) };
        }
        return extension.url !== require('../../shared/pcm-contract').SANDBOX_EXTENSIONS.approvalScopeOption ? extension :
            { ...extension, extension: extension.extension.filter(child => !(child.url === 'origin' && child.valueString === 'generated')) };
    };
    const select = value => ({ name: value.name, extraDetails: value.extraDetails, category: value.category, type: value.type,
        extension: (value.extension || []).filter(item => urls.has(item.url)).map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
    return JSON.stringify(select(service)) === JSON.stringify(select(request));
}
/** Inspect ordinary visible pages, returning an existing registration or performing ordinary registration.
 * @param {object} client The selected provider's authenticated server-only client.
 * @param {object} template Validated current template.
 * @param {string} providerId Selected provider Organization ID.
 * @param {object} [owner] Protected PCM definition reader/registration command for private authoring.
 * @returns {Promise<object>} Actual service resource and whether it was already added.
 */
async function addTemplate(client, template, providerId, owner) {
    if (template.privateDefinition && !owner) fail('private definition requires the authenticated PCM service owner command.');
    const compatible = service => {
        if (!sameDefinition(service, template.request)) return false;
        if (!template.privateDefinition) return true;
        const saved = owner.getDefinition(service.id);
        if (saved.status !== 'ok') return false;
        const select = value => ({ origin: value.grant.origin, authoring: value.grant.authoring,
            ...(value.grant.origin === 'custom' ? { scope: value.grant.scope } : {}), options: value.options,
            confidentialityPolicy: value.confidentialityPolicy, includeMasterData: value.includeMasterData });
        return JSON.stringify(select(saved)) === JSON.stringify(select(template.privateDefinition));
    };
    const seen = new Set(), matches = []; let page;
    for (let count = 0; ; count++) {
        if (count >= 1000 || seen.has(page)) fail('service pagination could not be completed. Refresh and inspect the current catalog before adding.');
        seen.add(page);
        const bundle = await client.search(page);
        if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'searchset') fail('regular service API returned an unexpected search result.');
        for (const entry of bundle.entry || []) if (entry.resource?.resourceType === 'HealthcareService' && entry.resource.name?.trim().toLowerCase() === template.request.name.toLowerCase()) matches.push(entry.resource);
        const next = bundle.link?.find(link => link.relation === 'next')?.url;
        if (!next) break;
        const parsed = new URL(next);
        if (!parsed.pathname.endsWith('/HealthcareService') || !parsed.searchParams.has('_page')) fail('regular service API returned an unsupported next page.');
        page = parsed.searchParams.get('_page');
    }
    const owned = matches.find(service => lifecycle.serviceKind(service) === 'instance' && lifecycle.ownerId(service) === providerId && lifecycle.businessStatus(service) !== 'cancelled');
    if (owned) {
        let definition = owned;
        const canonicalId = lifecycle.basedOnId(owned);
        if (canonicalId) { try { definition = await client.read(canonicalId); } catch (error) { if (error.status !== 404) throw error; } }
        if (!compatible(definition)) throw Object.assign(new Error('A service with this name has a different definition. Review it or create a manually named service; no stored service was changed.'), { status: 409 });
        return { service: owned, alreadyAdded: true };
    }
    const catalog = matches.find(service => lifecycle.serviceKind(service) === 'catalog');
    if (catalog && !compatible(catalog)) throw Object.assign(new Error('The visible shared service with this name differs from this template. Review it or use a new manual name; no service was overwritten.'), { status: 409 });
    if (catalog && (catalog.active !== true || lifecycle.businessStatus(catalog) !== 'active')) throw Object.assign(new Error('The matching shared service is waiting for activation. Use its separate explicit activation workflow before assignment.'), { status: 409 });
    return { service: catalog ? await client.register(existingRegistration(catalog.id))
        : template.privateDefinition ? await owner.register(template.request, template.privateDefinition) : await client.register(template.request), alreadyAdded: false };
}
module.exports = { DEFAULT_FILE, validateTemplates, loadTemplates, sameDefinition, addTemplate };
