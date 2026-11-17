'use strict';
/** Read-only legacy extraction. Disagreements are recovery findings, never selected winners. */
const { emptyState, publicBinding, validateState, validateOptions } = require('./private-records');
const { EXTENSIONS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const approval = require('../../shared/consent-scope-snapshot');
const grant = require('../../shared/service-grant');
const prefix = 'urn:pcm:sandbox:';
const serviceUrls = [grant.URL, `${prefix}approval-scope-option`, `${prefix}service-confidentiality-policy`, `${prefix}service-master-data`];
const privateUrls = new Set([...serviceUrls, approval.URL, SANDBOX_EXTENSIONS.approvedTokenScope, SANDBOX_EXTENSIONS.approvedTokenScopeOrigin,
    `${prefix}patient-sampling:fixed-query`, `${EXTENSIONS.dataSourceServerTrust || 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-data-source-server-trust'}`]);
const privateTags = new Set(['source-change', 'consent-cancellation', 'service-disabled', 'seed-definition', 'full-clinical-access', 'patient-sampler'].map(name => prefix + name));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Compare all copies, including original JSON order/text, before producing a reviewable candidate. */
function extractLegacy(resources) {
    const candidate = structuredClone(resources), state = emptyState(1), inventory = [], disagreements = [];
    state.authority = { epoch: require('node:crypto').randomUUID(), generations: {}, configuration: {} };
    const report = (identity, message) => disagreements.push({ identity, message, recovery: 'Keep original state; review matching public/private provenance before conversion' });
    const insertDefinition = (identity, version, value) => {
        const record = state.services[identity] ||= { currentVersion: version, versions: {} };
        if (Number(version) > Number(record.currentVersion)) record.currentVersion = version;
        if (record.versions[version] && !same(record.versions[version].grant, value.grant)) report(identity, `Conflicting definition copies for version ${version}`);
        else record.versions[version] ||= value;
    };
    for (const [type, rows] of Object.entries(resources)) {
        if (!Array.isArray(rows)) { report(type, 'Expected resource array'); continue; }
        for (const resource of rows) {
            const identity = `${type}/${resource.id}`;
            try {
                if (resource.resourceType !== type || !resource.meta?.versionId) throw new Error('Missing exact resource version');
                const extensions = resource.extension || [], tags = resource.meta?.tag || [];
                const unique = new Set();
                for (const item of extensions.filter(value => privateUrls.has(value.url) && value.url !== `${prefix}approval-scope-option`)) {
                    if (unique.has(item.url)) throw new Error(`Duplicate private extension ${item.url}`);
                    unique.add(item.url);
                }
                if (type === 'HealthcareService') {
                    validateOptions(extensions.filter(item => item.url === `${prefix}approval-scope-option`));
                    const value = grant.readServiceGrant(resource);
                    if (value) insertDefinition(identity, resource.meta.versionId, { recordRevision: 1, definitionId: resource.id, definitionVersion: resource.meta.versionId, grant: value,
                        options: structuredClone(extensions.filter(item => item.url === `${prefix}approval-scope-option`)),
                        confidentialityPolicy: require('../../shared/service-confidentiality-policy').readPolicy(resource), includeMasterData: require('../../shared/service-master-data').masterEnabled(resource) });
                    const seed = tags.filter(item => item.system === `${prefix}seed-definition`);
                    if (seed.length > 1) throw new Error('Duplicate seed provenance');
                    if (seed[0]?.display) {
                        const original = JSON.parse(seed[0].display);
                        const oldPrivate = (original.extension || []).filter(item => serviceUrls.includes(item.url));
                        if (!same(oldPrivate, extensions.filter(item => serviceUrls.includes(item.url)))) throw new Error('Seed display disagrees with private definition copies');
                    }
                }
                if (type === 'Consent') {
                    const value = approval.readApprovalSnapshot(resource);
                    if (!value && !['proposed', 'draft', 'rejected'].includes(resource.status)) throw new Error('Missing legacy approval authority; active/terminal state cannot infer a decision');
                    if (value) {
                        const sources = (resource.provision?.actor || []).filter(item => item.role?.coding?.some(code => code.code === 'CST')).map(item => item.reference?.reference).filter(Boolean);
                        state.lifecycle[identity] = { state: { sources, exactSourceMembership: sources.length === 0 }, events: [] };
                        state.approvals[identity] = { decisionVersion: '1', publicVersionAtDecision: resource.meta.versionId, publicBinding: publicBinding(resource), snapshot: value };
                        if (value.service.grant) insertDefinition(`HealthcareService/${value.service.definitionId}`, value.service.definitionVersion, {
                            recordRevision: 1, definitionId: value.service.definitionId, definitionVersion: value.service.definitionVersion,
                            grant: value.service.grant, options: [], confidentialityPolicy: value.service.grant.authoring?.confidentialityPolicy || null,
                            includeMasterData: value.service.grant.authoring?.includeMasterData || false });
                    }
                }
                const ownedTags = tags.filter(item => privateTags.has(item.system));
                const bookkeeping = extensions.filter(item => item.url === `${prefix}patient-sampling:fixed-query`
                    || !state.approvals[identity] && [SANDBOX_EXTENSIONS.approvedTokenScope, SANDBOX_EXTENSIONS.approvedTokenScopeOrigin].includes(item.url));
                if (ownedTags.some(item => ![`${prefix}source-change`, `${prefix}consent-cancellation`].includes(item.system)) || bookkeeping.length) {
                    state.provisioning[identity] = { legacyTags: structuredClone(ownedTags.filter(item => ![`${prefix}source-change`, `${prefix}consent-cancellation`].includes(item.system))), legacyExtensions: structuredClone(bookkeeping) };
                }
                const lifecycleTags = ownedTags.filter(item => [`${prefix}source-change`, `${prefix}consent-cancellation`].includes(item.system));
                if (lifecycleTags.length || tags.some(item => item.system === `${prefix}service-disabled`)) {
                    const events = [];
                    for (const tag of lifecycleTags) {
                        let event;
                        try { event = JSON.parse(tag.display); } catch { /* Preserve malformed audit as unrecorded, never fabricate it. */ }
                        if (event?.consentId === resource.id && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))) events.push({ ...event, eventId: `1:${identity}:${events.length + 1}`, revision: 1 });
                        else inventory.push({ identity, finding: 'Unrecorded malformed legacy audit', tag: structuredClone(tag) });
                    }
                    state.lifecycle[identity] = { state: { ...state.lifecycle[identity]?.state, exactSourceMembership: lifecycleTags.some(item => item.system === `${prefix}source-change`) || state.lifecycle[identity]?.state.exactSourceMembership === true,
                        restoreEligible: tags.some(item => item.system === `${prefix}service-disabled` && item.code === 'active') }, events };
                }
                inventory.push({ identity, privateExtensions: extensions.filter(item => privateUrls.has(item.url)).map(item => item.url), privateTags: ownedTags.map(item => item.system),
                    ...(type === 'Endpoint' ? { legacyConnectionConfig: structuredClone(extensions.filter(item => item.url === EXTENSIONS.dataSourceServerTrust)) } : {}) });
            } catch (error) { report(identity, error.message); }
        }
    }
    // Canonical records own new decisions; inherited copies may only agree, never compete.
    for (const resource of resources.HealthcareService || []) {
        const basedOn = resource.extension?.find(item => item.url === EXTENSIONS.basedOnCanonicalHealthcareService)?.valueReference?.reference;
        if (!basedOn) continue;
        const record = state.services[`HealthcareService/${resource.id}`], canonical = state.services[basedOn];
        const policy = value => value && [value.grant, value.options, value.confidentialityPolicy, value.includeMasterData];
        if (record && (!canonical || !same(policy(record.versions[record.currentVersion]), policy(canonical.versions[canonical.currentVersion])))) report(`HealthcareService/${resource.id}`, 'Registration/canonical private grant disagreement');
        delete state.services[`HealthcareService/${resource.id}`];
    }
    for (const rows of Object.values(candidate)) if (Array.isArray(rows)) for (const resource of rows) {
        resource.extension = (resource.extension || []).filter(item => !privateUrls.has(item.url));
        if (!resource.extension.length) delete resource.extension;
        if (resource.meta?.tag) resource.meta.tag = resource.meta.tag.filter(item => !privateTags.has(item.system));
    }
    try { validateState(state, candidate); } catch (error) { report('private-state', error.message); }
    return { schema: 'pcm-public-metadata-extraction/1', valid: disagreements.length === 0, privateState: state, publicCandidate: candidate, inventory, disagreements };
}
module.exports = { extractLegacy };
