'use strict';
/** Sandbox-test-only sampling policy uses normal Contract/OAuth authority, never a private credential. */
const { SCENARIO, sampleSources } = require('../../../shared/sandbox-patients');
const { loadServiceCatalog, definitionHash } = require('../../../shared/service-catalog');
const { SYSTEM_PROFILE } = require('./system-contract');
const { organizationIsOperational, organizationRole } = require('./participant-lifecycle');
const LOCAL_SYSTEM = 'urn:pcm:sandbox:patient-sampling';
const SCENARIO_SYSTEM = 'urn:pcm:sandbox:authorization-scenario';
const CLIENT_SYSTEM = 'urn:pcm:oauth-client-id';
const SOURCE_SYSTEM = 'urn:pcm:sandbox:managed-source';
const BASIS_SYSTEM = 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id';
const SERVICE_SYSTEM = 'http://pcm.fhir.health.gov.il/identifier/pcm-system-healthcareservice-id';
const testTag = resource => resource?.meta?.tag?.some(tag => tag.system === LOCAL_SYSTEM && tag.code === 'sandbox-test-only');
const isSamplingPolicy = resource => resource?.resourceType === 'Contract' && resource?.subType?.length === 1
    && resource.subType[0].coding?.length === 1 && resource.subType[0].coding[0].system === SCENARIO_SYSTEM && resource.subType[0].coding[0].code === SCENARIO;

/** Provision stable local policy/service identities; retained resources are never renewed automatically. */
function samplingResourceDrafts(config, now = Math.floor(Date.now() / 1000)) {
    if (!config.sandboxSampling) return [];
    const definition = loadServiceCatalog(config)?.sandboxSampling;
    if (!definition) throw new TypeError('Sampling requires the selected sandbox Contract/service catalog definition');
    const clients = Object.entries(config.systemAuthorization.clientEntitlements).filter(([, scenarios]) => scenarios.includes(SCENARIO)).map(([id]) => id).sort();
    const sourceIds = [...config.sandboxSampling.sourceIds].sort();
    const owner = `Organization/${config.organizations.pcm.id}`;
    const tag = [{ system: LOCAL_SYSTEM, code: 'sandbox-test-only', display: 'Only for sandbox tests' },
        { system: 'urn:pcm:sandbox:seed-definition', code: definitionHash({ definition, clients, sourceIds, owner }) }];
    const service = { resourceType: 'HealthcareService', id: definition.serviceId, active: true, meta: { tag },
        identifier: [{ use: 'official', system: SERVICE_SYSTEM, value: definition.serviceIdentifier }],
        providedBy: { reference: owner }, name: definition.name,
        description: 'Only for sandbox tests', extraDetails: `Only for sandbox tests. ${definition.purpose}`,
        type: [{ coding: [{ system: SCENARIO_SYSTEM, code: SCENARIO }] }],
        extension: [{ url: `${LOCAL_SYSTEM}:fixed-query`, valueString: require('../../../shared/sandbox-patients').URI }] };
    const contract = { resourceType: 'Contract', id: definition.policyId, status: 'policy', meta: { tag },
        identifier: [{ use: 'official', system: BASIS_SYSTEM, value: definition.policyIdentifier }],
        author: { reference: owner }, topicReference: { reference: `HealthcareService/${service.id}` },
        text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Only for sandbox tests. One fixed projected first-page search for HTEST sandbox GUID Patients.</div>' },
        type: { text: 'Sandbox-test-only data access authorization' }, subType: [{ coding: [{ system: SCENARIO_SYSTEM, code: SCENARIO }] }],
        issued: new Date(now * 1000).toISOString(), applies: { start: new Date(now * 1000).toISOString(), end: new Date((now + definition.validitySeconds) * 1000).toISOString() },
        term: [{ offer: { party: clients.map(value => ({ reference: [{ identifier: { system: CLIENT_SYSTEM, value } }], role: { text: 'Explicitly entitled registered application' } })) },
            asset: [{ scope: sourceIds.map(code => ({ coding: [{ system: SOURCE_SYSTEM, code }] })) }],
            action: [{ type: { text: 'Fixed current Patient search: identifier, name and birth date only, at most ten synthetic patients' }, intent: { coding: [{ system: SCENARIO_SYSTEM, code: SCENARIO }] } }] }] };
    return [service, contract];
}

/** Validate a uniquely resolved labelled pair and its bounded operation/eligibility declarations. */
function validateSamplingPolicy(store, contract, pcmOrganizationId) {
    const { resolveIdentifier, timestamp } = require('./system-policy');
    const owner = `Organization/${pcmOrganizationId}`;
    const ids = (contract?.identifier || []).filter(id => id.system === BASIS_SYSTEM);
    const reference = /^HealthcareService\/([A-Za-z0-9.-]+)$/.exec(contract?.topicReference?.reference || '');
    const service = reference && store.get('HealthcareService', reference[1]);
    const services = (service?.identifier || []).filter(id => id.system === SERVICE_SYSTEM);
    if (!isSamplingPolicy(contract) || (contract.meta?.profile || []).some(profile =>
        [SYSTEM_PROFILE, 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-data-access-authorization-contract'].includes(profile)) || ids.length !== 1 || ids[0].use !== 'official' || !ids[0].value
        || !['policy', 'draft', 'revoked', 'terminated', 'entered-in-error'].includes(contract.status) || contract.author?.reference !== owner
        || services.length !== 1 || services[0].use !== 'official' || !services[0].value
        || resolveIdentifier(store, 'HealthcareService', services[0])?.id !== service.id || service.providedBy?.reference !== owner
        || service.type?.length !== 1 || service.type[0].coding?.length !== 1 || service.type[0].coding[0].system !== SCENARIO_SYSTEM || service.type[0].coding[0].code !== SCENARIO
        || store.privateRecords.provisioning.get('HealthcareService', service?.id)?.bookkeeping?.[0]?.valueString !== require('../../../shared/sandbox-patients').URI
        || contract.term?.length !== 1 || contract.term[0].asset?.length !== 1 || contract.term[0].action?.length !== 1
        || contract.term[0].action[0].intent?.coding?.length !== 1 || contract.term[0].action[0].intent.coding[0].system !== SCENARIO_SYSTEM || contract.term[0].action[0].intent.coding[0].code !== SCENARIO) throw new TypeError('Invalid sandbox sampling policy/service');
    const start = timestamp(contract.applies?.start), end = timestamp(contract.applies?.end), issued = timestamp(contract.issued);
    if (start >= end || issued > end) throw new TypeError('Invalid sampling policy validity');
    const parties = contract.term[0].offer?.party;
    const scopes = contract.term[0].asset[0].scope;
    if (!Array.isArray(parties) || !Array.isArray(scopes)) throw new TypeError('Explicit sampling clients and targets required');
    const clients = parties.map(party => {
        const id = party.reference?.length === 1 && party.reference[0].identifier;
        if (id?.system !== CLIENT_SYSTEM || typeof id.value !== 'string' || !id.value) throw new TypeError('Invalid sampling client entitlement');
        return id.value;
    });
    const sources = scopes.map(scope => {
        const coding = scope.coding?.length === 1 && scope.coding[0];
        if (coding?.system !== SOURCE_SYSTEM || typeof coding.code !== 'string' || !coding.code) throw new TypeError('Invalid sampling target');
        return coding.code;
    });
    if (new Set(clients).size !== clients.length || new Set(sources).size !== sources.length) throw new TypeError('Ambiguous sampling entitlement');
    return { scenario: SCENARIO, service, identifier: ids[0], clients, sources, start, end, issued };
}

/** Reevaluate ordinary client entitlement and current source/service/Contract state at each OAuth decision. */
function evaluateSamplingPolicy({ store, config, contract, clientId, targetOrganizationId, now }) {
    if (!require('../../../shared/identity-mapping').sandboxIdentityOptions(config).allowSandboxGuid) return null;
    let validated; try { validated = validateSamplingPolicy(store, contract, config.organizations.pcm.id); } catch { return null; }
    const provider = Object.values(config.organizations).find(org => org?.clientId === clientId);
    const source = sampleSources(config).find(ho => ho.dataSourceOrganization.id === targetOrganizationId);
    if (!provider || organizationRole(store.get('Organization', provider.id)) !== 'service-provider' || !organizationIsOperational(store, store.get('Organization', provider.id))
        || !config.systemAuthorization.clientEntitlements[clientId]?.includes(SCENARIO) || !validated.clients.includes(clientId)
        || !source || !validated.sources.includes(source.id) || !organizationIsOperational(store, store.get('Organization', targetOrganizationId))
        || contract.status !== 'policy' || validated.service.active !== true || now < validated.start || now < validated.issued || now >= validated.end) return null;
    return { contract, ...validated };
}
/** Public custom authorization declarations remain ordinary FHIR resources. */
function samplingResources(...args) { return samplingResourceDrafts(...args).map(item => require('../public-fhir').splitProduced(item).resource); }
module.exports = { samplingResourceDrafts, LOCAL_SYSTEM, SCENARIO_SYSTEM, samplingResources, isSamplingPolicy, validateSamplingPolicy, evaluateSamplingPolicy, testTag };
