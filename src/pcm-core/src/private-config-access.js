'use strict';
/** Typed reads of the existing validated config owner; secrets are never copied into FHIRStore. */
const { assertValidTeamConfig } = require('../../shared/team-config-validator');
const { getConfiguredDataSources } = require('./data-sources');
const { PrivateRecordError } = require('./private-records');

/** Detached effective configuration with the existing runtime revision and exact origin. */
function createConfigAccess({ getConfig = require('./team-config').loadTeamConfig } = {}) {
    const read = () => structuredClone(assertValidTeamConfig(getConfig(), { env: process.env }));
    const result = (config, value) => ({ status: 'ok', revision: config.runtime.revision, origin: 'validated-team-config', value: structuredClone(value) });
    const source = id => {
        const config = read(), value = getConfiguredDataSources(config).find(item => item.id === id);
        if (!value || value.enabled === false) throw new PrivateRecordError('Unknown/disabled source', 'missing');
        return { config, value };
    };
    return {
        connections: { get(id) { const { config, value } = source(id); return result(config, value); } },
        registrations: { get(clientId) {
            const config = read(), entries = Object.entries(config.organizations || {}).filter(([, value]) => value.clientId === clientId && value.enabled !== false);
            const sources = getConfiguredDataSources(config).filter(value => value.clientId === clientId && value.enabled !== false);
            const values = sources.length ? sources : entries.filter(([role]) => !['referenceDataSource', 'dataSources'].includes(role)).map(([role, value]) => ({ role, ...value }));
            if (values.length !== 1) throw new PrivateRecordError('Unknown/ambiguous/disabled client', 'missing');
            return result(config, values[0]);
        } },
        workflowConfig: { get(id) { const { config, value } = source(id); return result(config, { source: value, systemAuthorization: config.systemAuthorization }); } }
    };
}
module.exports = { createConfigAccess };
