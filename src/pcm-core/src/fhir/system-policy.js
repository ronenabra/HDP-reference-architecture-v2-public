'use strict';

/** PCM-owned Contract lifecycle and current, fail-closed scenario evaluation. */
const { organizationIsOperational, organizationRole, participantEndpoint } = require('./participant-lifecycle');
const { BASIS_SYSTEMS } = require('../rar-request');
const BASE = 'http://pcm.fhir.health.gov.il';
const SCENARIO_SYSTEM = `${BASE}/cs/pcm-authorization-scenario`;
const VOCABULARY = `${BASE}/cs/pcm-authorization-vocabulary`;
const { validateSystemContract, validateSystemContractUpdate, SYSTEM_PROFILE } = require('./system-contract');
const { loadServiceCatalog, definitionHash } = require('../../../shared/service-catalog');
const TAG_SYSTEM = `${BASE}/cs/pcm-meta-tag`;
const SERVICE_SYSTEM = `${BASE}/identifier/pcm-system-healthcareservice-id`;
const SCENARIOS = Object.freeze({
    'presence-check': { suffix: 'presence', identifier: 'PRESENCE' },
    'patient-authentication': { suffix: 'patient-authentication', identifier: 'PATIENT-AUTHENTICATION' },
    'dependent-discovery': { suffix: 'dependent-discovery', identifier: 'DEPENDENT-DISCOVERY' }
});
const TERMINAL = new Set(['revoked', 'terminated', 'entered-in-error']);
const concept = (system, code) => ({ coding: [{ system, code }] });

/** Parse a full timezone-qualified FHIR timestamp, rejecting partial dates. */
function timestamp(value) {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59
        || Number(match[6] || 0) > 14 || Number(match[7] || 0) > 59
        || (Number(match[6]) === 14 && Number(match[7]) !== 0)
        || !Number.isFinite(Date.parse(value))) throw new TypeError('Policy requires full issued/applies timestamps');
    if (new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) throw new TypeError('Invalid calendar date');
    // Date.parse truncates beyond milliseconds; retain fractional seconds for
    // inclusive Contract comparisons (OAuth integer exp remains a separate rule).
    const fraction = /\.(\d+)/.exec(value);
    return Date.parse(value.replace(/\.\d+/, '')) / 1000 + (fraction ? Number(`0.${fraction[1]}`) : 0);
}

/** Resolve a business identifier uniquely; logical IDs never stand in for it. */
function resolveIdentifier(store, type, identifier) {
    if (typeof identifier?.system !== 'string' || typeof identifier?.value !== 'string' || !identifier.value) return null;
    const matches = store.getAll(type).filter(resource => resource.identifier?.some(item =>
        item.system === identifier.system && item.value === identifier.value));
    return matches.length === 1 ? matches[0] : null;
}

/** Identify a system scenario only when the Contract declares exactly one. */
function scenarioOf(contract) {
    if (require('./sampling-policy').isSamplingPolicy(contract)) return 'sandbox-patient-sample';
    const values = contract?.subType;
    const coding = values?.length === 1 && values[0].coding?.length === 1 && values[0].coding[0];
    return coding?.system === SCENARIO_SYSTEM && Object.hasOwn(SCENARIOS, coding.code) ? coding.code : null;
}

/** Return whether a service carries precisely the authoritative PCM system tag. */
function isSystemService(service) {
    if (service?.type?.some(type => type.coding?.some(code => code.system === require('./sampling-policy').SCENARIO_SYSTEM && code.code === 'sandbox-patient-sample'))) return true;
    const tags = (service?.meta?.tag || []).filter(tag => tag.system === TAG_SYSTEM);
    return tags.length === 1 && tags[0].code === 'system-service';
}

/** Validate normative grant or labelled local pair invariants without requiring the policy to be active. */
function validatePolicy(store, contract, pcmOrganizationId) {
    if (require('./sampling-policy').isSamplingPolicy(contract)) return require('./sampling-policy').validateSamplingPolicy(store, contract, pcmOrganizationId);
    return validateSystemContract(store, contract, pcmOrganizationId);
}

/** Make deterministic sandbox-owned resources without copying sample validity dates. */
function buildSystemPolicyDrafts(config, now = Math.floor(Date.now() / 1000)) {
    const resources = [];
    const templates = loadServiceCatalog(config)?.systemPolicies;
    const owner = `Organization/${config.organizations.pcm.id}`;
    for (const [scenario, definition] of Object.entries(SCENARIOS)) {
        const template = templates?.find(item => item.scenario === scenario);
        const policyId = template?.policyId || `policy-${definition.suffix}`;
        const sources = require('../data-sources').getConfiguredDataSources(config)
            .filter(source => scenario === 'presence-check' || source.institutionType === 'hmo');
        const contract = {
            resourceType: 'Contract', id: policyId,
            meta: { profile: [SYSTEM_PROFILE] },
            identifier: [{ use: 'official', system: BASIS_SYSTEMS.Contract, value: template?.policyIdentifier || `PCM-POLICY-${definition.identifier}-001` }],
            status: 'executed', issued: new Date(now * 1000).toISOString(),
            applies: { start: new Date(now * 1000).toISOString(), end: new Date((now + (template?.validitySeconds || 31536000)) * 1000).toISOString() },
            author: { reference: owner }, title: template?.name || `PCM ${scenario}`,
            extension: (template?.queries || ['GET [FHIR BASE]/Patient?identifier=[SYSTEM]|[VALUE]']).map(valueString => ({ url: `${BASE}/StructureDefinition/ext-example-query`, valueString })),
            type: concept(VOCABULARY, 'data-access-authorization'), subType: [concept(SCENARIO_SYSTEM, scenario)],
            term: [{ text: template?.purpose || `PCM-owned ${scenario} workflow; prescribed queries and projections only.`, offer: { party: [{ reference: [{ reference: owner }], role: concept(VOCABULARY, 'grantee') }] },
                asset: sources.map(source => ({ context: [{ reference: { reference: `Organization/${source.id}` } }] })) }]
        };
        contract.meta.lastUpdated = new Date(now * 1000).toISOString();
        if (template) contract.meta.tag = [{ system: 'urn:pcm:sandbox:seed-definition', code: definitionHash({ template, owner, model: 'self-contained-0.4.2' }) }];
        resources.push(contract);
    }
    return resources;
}

/** Provision an independently validated graph without renewing retained validity or terminal state. */
function provisionSystemPolicies(store, config, now = Math.floor(Date.now() / 1000)) {
    const resources = buildSystemPolicyDrafts(config, now);
    const { FHIRStore } = require('./store');
    const candidate = new FHIRStore();
    for (const type of ['Organization', 'Endpoint']) for (const resource of store.getAll(type)) candidate.add(resource);
    for (const resource of resources) require('../public-fhir').publishNewResource(candidate, resource);
    for (const resource of resources.filter(item => item.resourceType === 'Contract')) validatePolicy(candidate, resource, config.organizations.pcm.id);
    return store.transaction(() => {
        for (const resource of resources) if (!store.get(resource.resourceType, resource.id)) require('../public-fhir').publishNewResource(store, resource);
    });
}

/** Visibility is independent of active validity and never grants token issuance. */
function canReadPolicy(store, config, contract, caller) {
    const scenario = scenarioOf(contract);
    if (!scenario) return false;
    if (scenario === 'sandbox-patient-sample') return require('../../../shared/identity-mapping').sandboxIdentityOptions(config).allowSandboxGuid && (caller?.organization_id === config.organizations.pcm.id || config.systemAuthorization.clientEntitlements[caller?.client_id]?.includes(scenario) === true);
    if (caller?.organization_id === config.organizations.pcm.id) return true;
    if (config.systemAuthorization.clientEntitlements[caller?.client_id]?.includes(scenario)) return true;
    const source = require('../data-sources').getConfiguredDataSources(config).find(source => source.id === caller?.organization_id);
    return Boolean(source && (scenario === 'presence-check' || source.institutionType === 'hmo'));
}

/** Resolve entitlement and active grant and current target state at a supplied time. */
function evaluatePolicy({ store, config, identifier, clientId, targetOrganizationId, now }) {
    const contract = resolveIdentifier(store, 'Contract', identifier);
    if (!contract) return null;
    if (require('./sampling-policy').isSamplingPolicy(contract)) return require('./sampling-policy').evaluateSamplingPolicy({ store, config, contract, clientId, targetOrganizationId, now });
    let validated;
    try { validated = validatePolicy(store, contract, config.organizations.pcm.id); } catch (_) { return null; }
    const { scenario, sources, start, end, issued } = validated;
    if (!config.systemAuthorization.clientEntitlements[clientId]?.includes(scenario)
        || contract.status !== 'executed' || !Number.isFinite(now) || now < start || now < issued || now > end
        || !sources.includes(targetOrganizationId) || !organizationIsOperational(store, store.get('Organization', targetOrganizationId))) return null;
    const source = require('../hmo-sources').hmoSources(config, store).find(source => source.id === targetOrganizationId);
    if (organizationRole(store.get('Organization', targetOrganizationId)) !== 'source'
        || !participantEndpoint(store, store.get('Organization', targetOrganizationId), { requireActive: true })) return null;
    if (scenario !== 'presence-check' && !source) return null;
    return { contract, ...validated };
}

/** Private state transition; terminal policies require replacement under a new identifier. */
function transitionPolicy(store, id, status, config) {
    const current = store.get('Contract', id);
    if (!current || TERMINAL.has(current.status)) throw new TypeError('Policy is missing or terminal');
    const updated = { ...current, status };
    if (require('./sampling-policy').isSamplingPolicy(current)) {
        validatePolicy(store, updated, config.organizations.pcm.id);
        return commitPolicyState(store, current, updated);
    }
    return updatePolicy(store, updated, config);
}

/** Maintain membership/shorten validity privately, preserving the immutable grant. */
function updatePolicy(store, updated, config) {
    const current = store.get('Contract', updated.id);
    validateSystemContractUpdate(store, current, updated, config.organizations.pcm.id);
    return commitPolicyState(store, current, updated);
}

/** Keep workflow lifecycle events private while the Contract status remains public. */
function commitPolicyState(store, current, updated) {
    return store.privateRecords.lifecycle.command({ type: 'Contract', id: current.id, resource: updated,
        event: { kind: 'workflow-policy-change', previousStatus: current.status, status: updated.status, at: store.clock().toISOString() },
        expectedRevision: store.privateState.revision, expectedVersions: { [`Contract/${current.id}`]: current.meta.versionId } }).resource;
}

/** Retire a workflow without relying on any HealthcareService resource. */
function revokeWorkflow(store, scenario, config) {
    if (!Object.hasOwn(SCENARIOS, scenario)) throw new TypeError('Unknown system workflow');
    return store.transaction(() => store.getAll('Contract')
        .filter(contract => scenarioOf(contract) === scenario && !TERMINAL.has(contract.status))
        .map(contract => transitionPolicy(store, contract.id, 'revoked', config)));
}

/** Public system examples preserve policy declarations but omit seed bookkeeping. */
function buildSystemPolicies(...args) { return buildSystemPolicyDrafts(...args).map(item => require('../public-fhir').splitProduced(item).resource); }
module.exports = { buildSystemPolicyDrafts, SCENARIOS, SERVICE_SYSTEM, TAG_SYSTEM, canReadPolicy, evaluatePolicy, isSystemService,
    buildSystemPolicies, provisionSystemPolicies, resolveIdentifier, scenarioOf, timestamp, transitionPolicy, updatePolicy, revokeWorkflow, validatePolicy };
