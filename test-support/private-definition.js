'use strict';
/** Explicit new definition versions for disposable fixtures; historical decisions remain frozen. */
function replaceDefinition(store, current, input, options) {
    const command = require('../src/pcm-core/src/service-definition-form').serviceDefinitionCommand(input, options);
    const { EXTENSIONS } = require('../src/shared/pcm-contract');
    return store.transaction(() => {
        const resource = store.update({ ...current, name: command.resource.name, extraDetails: command.resource.extraDetails,
            extension: [...command.resource.extension, ...current.extension.filter(item => [EXTENSIONS.serviceBusinessStatus, EXTENSIONS.approvalWindow].includes(item.url))] });
        store.privateRecords.services.createDefinition({ serviceId: resource.id, ...command.definition,
            expectedRevision: store.privateState.revision, expectedVersions: { [`HealthcareService/${resource.id}`]: resource.meta.versionId } });
        return resource;
    });
}
module.exports = { replaceDefinition };
