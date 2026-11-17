'use strict';
/** Existing disposable Admin server with explicit classification and long custom fixtures. */
async function startAdminSourcesFixture() {
    const { buildTeamConfig } = require('./team-config');
    const config = buildTeamConfig();
    config.healthOrganizations.forEach((source, index) => { source.institutionType = index === 0 ? 'hmo' : 'hospital'; });
    const { toConfigDataSource } = require('../src/pcm-core/src/data-sources');
    config.organizations.dataSources = [
        toConfigDataSource({ id: 'source-fourth-long', name: 'Fourth registered source with a very long clinical institution name <owned> & partners '.repeat(2), institutionType: 'hospital', endpoint: 'http://127.0.0.1:9/fhir', clientId: 'pcm-ds-source-fourth-long' }),
        toConfigDataSource({ id: 'source-disabled', name: 'Disabled HMO external source', institutionType: 'hmo', endpoint: 'https://disabled.example.test/fhir', enabled: false })
    ];
    for (const source of config.organizations.dataSources) source.pcmClientAuth.certThumbprint = 'A'.repeat(43);
    config.identityMapping = { businessIdOverrides: {
        'http://fhir.health.gov.il/identifier/il-national-id|000000018': 'Patient/local-000000018',
        ['https://long.example.test/naming-system/' + 'namespace'.repeat(12) + '|000000002']: 'Local<exact>&000000002'
    } };
    return require('./admin-shell-fixture').startAdminShellFixture({ healthOrganizations: config.healthOrganizations, organizations: config.organizations, identityMapping: config.identityMapping });
}
module.exports = { startAdminSourcesFixture };
