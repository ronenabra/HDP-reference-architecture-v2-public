/**
 * In-memory client and token storage for the POC.
 */

/**
 * Registered OAuth2 clients and their certificate bindings.
 * @type {Array<{clientId: string, name: string, redirectUri?: string, scopes: string[], certPath: string, organizationId: string}>}
 */
const clients = [
    {
        clientId: 'http://pcm.fhir.health.gov.il/Organization/org-sp', // Canonical URL ID
        name: 'Doctor Portal',
        redirectUri: 'http://localhost:3000/callback',
        scopes: ['fhir/Consent.write', 'fhir/Patient.read', 'fhir/Observation.read', 'system/*.cruds', 'patient/Observation.rs'],
        certPath: '/app/certs/sp-client.crt',
        organizationId: 'org-sp' // Mapped Organization
    },
    {
        clientId: 'http://pcm.fhir.health.gov.il/Organization/org-vaccine-repo',
        name: 'Data Source Auth Adapter',
        scopes: ['introspection'],
        certPath: '/app/certs/ds-gateway.crt',
        organizationId: 'org-vaccine-repo' // Mapped Organization
    },
    {
        clientId: 'hospital-b-sp',
        name: 'Hospital B Doctor Portal',
        scopes: ['fhir/Consent.write', 'fhir/Patient.read', 'fhir/Observation.read'],
        certPath: '/app/certs/hospital-b-sp.crt',
        organizationId: 'org-hospital-b-sp'
    },
    {
        clientId: 'pcm-core',
        name: 'Patient Consent Manager',
        scopes: ['system/*.cruds'],
        certPath: '/app/certs/pcm-core.crt',
        organizationId: 'org-pcm-system'
    }
];

/**
 * Opaque token storage (token -> token claims).
 * @type {Map<string, object>}
 */
const tokens = new Map();

module.exports = {
    clients,
    tokens
};
