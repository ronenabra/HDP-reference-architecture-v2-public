'use strict';
/** Reviewed tiny list fixture: five ordinary definitions and two configured providers. */
const lifecycle = require('../src/pcm-core/src/fhir/healthcare-service-lifecycle');
const { loadTemplates } = require('../src/pcm-core/src/service-templates');
const { existingRegistration } = require('../src/pcm-core/src/service-definition-form');
const { EXTENSIONS } = require('../src/shared/pcm-contract');

/** Replace only an owned fixture's services, returning exact IDs and a restoration callback. */
function installServicesListFixture(fixture) {
    const { store, config } = fixture;
    const checkpoint = require('../src/pcm-core/src/migration-checkpoint');
    const previous = checkpoint.snapshot(store, { privateState: true });
    for (const item of store.getAll('HealthcareService').sort((a, b) => Number(Boolean(lifecycle.basedOnId(b))) - Number(Boolean(lifecycle.basedOnId(a))))) store.remove('HealthcareService', item.id);
    const ownerA = store.get('Organization', config.organizations.serviceProvider.id);
    const ownerB = store.get('Organization', config.organizations.hospitalBServiceProvider.id);
    const definitions = [], registrationsA = [], registrationsB = [];
    /** Fixture-only state setup; UI tests make no lifecycle request. */
    function active(resource) {
        return store.update({ ...resource, active: true, extension: resource.extension.map(item => item.url === EXTENSIONS.serviceBusinessStatus ? lifecycle.statusExtension('active') : item) });
    }
    const templates = loadTemplates();
    for (let index = 0; index < 5; index++) {
        const template = templates[index % templates.length];
        const request = structuredClone(template.request), privateDefinition = structuredClone(template.privateDefinition);
        request.name = `List fixture ${index}: ${request.name}`; privateDefinition.grant.authoring.name = request.name;
        const result = lifecycle.registerHealthcareService({ store, callerOrganization: ownerA, request, privateDefinition });
        definitions.push(active(result.canonical)); registrationsA.push(active(result.instance));
    }
    // Public illustrative guidance exercises long-value wrapping without rewriting immutable private permissions.
    const longDefinition = structuredClone(definitions[0]);
    longDefinition.extension.push({ url: EXTENSIONS.exampleQuery, valueString: `GET [FHIR BASE]/Observation?code=${'long-example-'.repeat(80)}` });
    definitions[0] = store.update(longDefinition);
    for (let index = 0; index < 2; index++) {
        const result = lifecycle.registerHealthcareService({ store, callerOrganization: ownerB, request: existingRegistration(definitions[index].id) });
        registrationsB.push(index === 0 ? active(result.instance) : result.instance);
    }
    return { definitions, registrationsA, registrationsB, restore() {
        checkpoint.hydrate(store, previous, { rollback: true });
    } };
}
module.exports = { installServicesListFixture };
