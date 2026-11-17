/**
 * Resolve simulated SP client identities for the Doctor Portal.
 */
const { identity: identityHelp } = require('../../shared/ui/help-values');
const { loadTeamConfig: readTeamConfig } = require('./team-config');

const DEFAULT_IDENTITIES = [
    { id: 'hospital-a', label: 'Hospital A SP (demo)' },
    { id: 'hospital-b', label: 'Hospital B SP (demo)' },
    { id: 'untrusted', label: 'Untrusted client (negative test)' }
];

/**
 * Return simulated client identities available in the SP UI.
 *
 * These are local test clients, not data sources discovered from PCM.
 * PCM discovery happens later when checking an approved consent.
 *
 * @returns {{id: string, label: string}[]}
 */
function getIdentities(config = readTeamConfig()) {
    const serviceProvider = config?.organizations?.serviceProvider;
    if (!serviceProvider) return DEFAULT_IDENTITIES.map(item => ({ ...item, helpKey: identityHelp(item.id) }));

    const identities = [
        {
            id: 'hospital-a',
            label: `${serviceProvider.name || 'Team Service Provider'}`
        }
    ];

    if (config.organizations?.hospitalBServiceProvider) {
        identities.push({ id: 'hospital-b', label: config.organizations.hospitalBServiceProvider.name || 'Hospital B SP (demo)' });
    }
    if (config.organizations?.untrustedClient) {
        identities.push({ id: 'untrusted', label: 'Untrusted transport (negative test)' });
        identities.push({ id: 'untrusted-assertion', label: 'Unregistered assertion key (negative test)' });
    }

    return identities.map(item => ({ ...item, helpKey: identityHelp(item.id) }));
}

function getIdentityIds() {
    return getIdentities().map(identity => identity.id);
}

function getDefaultIdentity() {
    return getIdentityIds()[0] || 'hospital-a';
}

module.exports = {
    getIdentities,
    getIdentityIds,
    getDefaultIdentity
};
