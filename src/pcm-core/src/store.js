/**
 * In-memory client and token storage for the POC.
 */
const { getConfiguredDataSources } = require('./data-sources');
const { loadTeamConfig, certPath, dataSourceClientCertPath } = require('./team-config');
const { SCOPES } = require('../../shared/pcm-contract');
const { FileTokenStore } = require('./token-store');
const { certToX5tS256 } = require('./crypto');
const fs = require('fs');
const path = require('path');

function certificateThumbprint(certFile) {
    try {
        return certToX5tS256(fs.readFileSync(certFile));
    } catch (_error) {
        return null;
    }
}

function assertionKeyPaths(config, organization, es256Path) {
    const certsDir = process.env.CERTS_DIR || config.runtime?.certsDir || '/app/certs';
    const configured = organization?.assertionCertificates
        || organization?.pcmClientAuth?.assertionCertificates
        || {};
    let defaultAlgorithm = 'ES256';
    try { defaultAlgorithm = require('../../shared/assertion-keys').signingAlgorithm(fs.readFileSync(es256Path)); }
    catch (_) { /* Missing demo material remains a verification failure at assertion use. */ }
    const keys = { [defaultAlgorithm]: es256Path };
    for (const algorithm of ['ES256', 'RS256', 'ES384']) {
        if (configured[algorithm]) {
            const resolve = value => path.isAbsolute(value) ? value : path.join(certsDir, value);
            keys[algorithm] = Array.isArray(configured[algorithm]) ? configured[algorithm].map(resolve) : resolve(configured[algorithm]);
        }
    }
    return keys;
}

function registeredRedirectUris(organization) {
    const values = Array.isArray(organization?.redirectUris)
        ? organization.redirectUris
        : (organization?.redirectUri ? [organization.redirectUri] : []);
    return [...new Set(values.filter(value => typeof value === 'string' && value))];
}

function registeredSmartScopes(organization) {
    const configured = organization?.smartScopes
        || organization?.scopes?.filter(scope => String(scope).startsWith('patient/'))
        || [];
    return [...new Set(configured)];
}

/**
 * Build registered OAuth2 clients from team config, preserving demo defaults.
 * @returns {Array<{clientId: string, name: string, redirectUri?: string, scopes: string[], certPath: string, assertionKeyPaths: object, organizationId: string, role: string}>}
 */
function buildClients() {
    const config = loadTeamConfig();
    const orgs = config.organizations;

    const serviceProviderCert = certPath(config, 'serviceProvider', 'cert', 'assertion');
    const serviceProviderMtlsCert = certPath(config, 'serviceProvider', 'cert', 'mtls');
    const referenceDataSourceCert = certPath(config, 'referenceDataSource', 'cert', 'assertion');
    const referenceDataSourceMtlsCert = certPath(config, 'referenceDataSource', 'cert', 'mtls');
    const hospitalBCert = certPath(config, 'hospitalBServiceProvider', 'cert', 'assertion');
    const hospitalBMtlsCert = certPath(config, 'hospitalBServiceProvider', 'cert', 'mtls');
    const pcmCert = certPath(config, 'pcm', 'cert', 'server');
    const presenceAssertionCert = certPath(config, 'presenceOrchestrator', 'cert', 'assertion');
    const presenceMtlsCert = certPath(config, 'presenceOrchestrator', 'cert', 'mtls');
    const serviceProviderRedirectUris = registeredRedirectUris(orgs.serviceProvider);
    const hospitalBRedirectUris = registeredRedirectUris(orgs.hospitalBServiceProvider);
    const serviceProviderSmartScopes = registeredSmartScopes(orgs.serviceProvider);
    const hospitalBSmartScopes = registeredSmartScopes(orgs.hospitalBServiceProvider);
    const clients = [
        {
            clientId: orgs.serviceProvider.clientId,
            name: orgs.serviceProvider.name,
            redirectUri: orgs.serviceProvider.redirectUri,
            redirectUris: serviceProviderRedirectUris,
            smartScopes: serviceProviderSmartScopes,
            authorizationCodeGrant: serviceProviderRedirectUris.length > 0 && serviceProviderSmartScopes.length > 0,
            scopes: orgs.serviceProvider.scopes || ['fhir/Consent.write', 'fhir/Patient.read', 'fhir/Observation.read', SCOPES.management, 'patient/Observation.rs'],
            certPath: serviceProviderCert,
            mtlsThumbprint: certificateThumbprint(serviceProviderMtlsCert),
            assertionThumbprint: certificateThumbprint(serviceProviderCert),
            assertionKeyPaths: assertionKeyPaths(config, orgs.serviceProvider, serviceProviderCert),
            organizationId: orgs.serviceProvider.id,
            role: 'service-provider'
        },
        ...(Array.isArray(config.healthOrganizations) ? [] : [{
            clientId: orgs.referenceDataSource.clientId,
            name: orgs.referenceDataSource.name,
            redirectUris: [],
            smartScopes: [],
            authorizationCodeGrant: false,
            scopes: orgs.referenceDataSource.scopes || ['introspection'],
            certPath: referenceDataSourceCert,
            mtlsThumbprint: certificateThumbprint(referenceDataSourceMtlsCert),
            assertionThumbprint: certificateThumbprint(referenceDataSourceCert),
            assertionKeyPaths: assertionKeyPaths(config, orgs.referenceDataSource, referenceDataSourceCert),
            organizationId: orgs.referenceDataSource.id,
            role: 'data-source'
        }]),
        {
            clientId: orgs.hospitalBServiceProvider?.clientId || 'pcm-sp-local-0002',
            name: orgs.hospitalBServiceProvider?.name || 'Hospital B Doctor Portal',
            redirectUris: hospitalBRedirectUris,
            smartScopes: hospitalBSmartScopes,
            authorizationCodeGrant: hospitalBRedirectUris.length > 0 && hospitalBSmartScopes.length > 0,
            scopes: [...new Set([
                ...(orgs.hospitalBServiceProvider?.scopes || ['fhir/Consent.write', 'fhir/Patient.read', 'fhir/Observation.read']),
                SCOPES.management
            ])],
            certPath: hospitalBCert,
            mtlsThumbprint: certificateThumbprint(hospitalBMtlsCert),
            assertionThumbprint: certificateThumbprint(hospitalBCert),
            assertionKeyPaths: assertionKeyPaths(config, orgs.hospitalBServiceProvider, hospitalBCert),
            organizationId: orgs.hospitalBServiceProvider?.id || 'org-hospital-b-sp',
            role: 'service-provider'
        },
        {
            clientId: orgs.pcm.clientId,
            name: orgs.pcm.name,
            redirectUris: [],
            smartScopes: [],
            authorizationCodeGrant: false,
            scopes: [SCOPES.management],
            certPath: pcmCert,
            mtlsThumbprint: certificateThumbprint(pcmCert),
            assertionThumbprint: certificateThumbprint(pcmCert),
            assertionKeyPaths: assertionKeyPaths(config, orgs.pcm, pcmCert),
            organizationId: orgs.pcm.id,
            role: 'pcm'
        },
        {
            clientId: config.oauthClients.presenceOrchestrator.clientId,
            name: config.oauthClients.presenceOrchestrator.name,
            redirectUris: [],
            smartScopes: [],
            authorizationCodeGrant: false,
            scopes: [],
            certPath: presenceAssertionCert,
            mtlsThumbprint: certificateThumbprint(presenceMtlsCert),
            assertionThumbprint: certificateThumbprint(presenceAssertionCert),
            assertionKeyPaths: assertionKeyPaths(config, config.oauthClients.presenceOrchestrator, presenceAssertionCert),
            organizationId: orgs.pcm.id,
            role: 'presence-orchestrator'
        }
    ];

    for (const [key, role] of [['authenticationOrchestrator', 'authentication-orchestrator'], ['discoveryOrchestrator', 'discovery-orchestrator']]) {
        const assertionCert = certPath(config, key, 'cert', 'assertion');
        const mtlsCert = certPath(config, key, 'cert', 'mtls');
        clients.push({
            clientId: config.oauthClients[key].clientId, name: config.oauthClients[key].name,
            redirectUris: [], smartScopes: [], authorizationCodeGrant: false, scopes: [],
            certPath: assertionCert, mtlsThumbprint: certificateThumbprint(mtlsCert),
            assertionThumbprint: certificateThumbprint(assertionCert),
            assertionKeyPaths: assertionKeyPaths(config, config.oauthClients[key], assertionCert), organizationId: orgs.pcm.id, role
        });
    }

    if (orgs.teamDataSource?.enabled && orgs.teamDataSource.clientId) {
        clients.push({
            clientId: orgs.teamDataSource.clientId,
            name: orgs.teamDataSource.name,
            redirectUris: [],
            smartScopes: [],
            authorizationCodeGrant: false,
            scopes: orgs.teamDataSource.scopes || ['introspection'],
            certPath: referenceDataSourceCert,
            mtlsThumbprint: certificateThumbprint(referenceDataSourceMtlsCert),
            assertionThumbprint: certificateThumbprint(referenceDataSourceCert),
            assertionKeyPaths: assertionKeyPaths(config, orgs.teamDataSource, referenceDataSourceCert),
            organizationId: orgs.teamDataSource.id,
            role: 'data-source'
        });
    }

    const configuredSources = getConfiguredDataSources(config).filter(source =>
        Array.isArray(config.healthOrganizations) || !source.builtIn);
    for (const source of configuredSources) {
        if (source.id === orgs.teamDataSource?.id) continue;
        const cert = dataSourceClientCertPath(config, source, 'cert');
        if (!source.clientId || !cert) continue;
        clients.push({
            clientId: source.clientId,
            name: source.name,
            redirectUris: [],
            smartScopes: [],
            authorizationCodeGrant: false,
            scopes: source.scopes || ['introspection'],
            certPath: cert,
            // Registration follows the role's actual material, never a stale
            // inventory/display thumbprint or the separate server-trust role.
            mtlsThumbprint: certificateThumbprint(dataSourceClientCertPath(config, {
                    ...source,
                    pcmClientAuth: { ...source.pcmClientAuth, cert: source.pcmClientAuth?.mtlsCert || source.pcmClientAuth?.cert }
                }, 'cert')),
            assertionThumbprint: certificateThumbprint(cert),
            assertionKeyPaths: assertionKeyPaths(config, source, cert),
            organizationId: source.id,
            role: 'data-source'
        });
    }

    return clients;
}

function findClientById(clientId) {
    return buildClients().find(client => client.clientId === clientId);
}

/**
 * Registered OAuth2 clients and their certificate bindings.
 * @type {Array<{clientId: string, name: string, redirectUri?: string, scopes: string[], certPath: string, assertionKeyPaths: object, organizationId: string, role: string}>}
 */
const clients = buildClients();

const config = loadTeamConfig();
const tokenStateDir = process.env.STATE_DIR || config.runtime?.stateDir;
if (!tokenStateDir) throw new Error('STATE_DIR or runtime.stateDir is required for access-token state');
const tokenStore = new FileTokenStore(path.join(tokenStateDir, 'access-tokens'));

module.exports = {
    clients,
    tokenStore,
    tokens: tokenStore,
    buildClients,
    findClientById
};
