'use strict';

/** Bounded forms over the existing config5/policy4 security owner; no new policy store. */
const { SIMULATION_CONTROLS, PRESETS, POLICY_VERSION, presetSimulationDefaults } = require('../../shared/conformance-policy');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');
const { getConfiguredDataSources } = require('./data-sources');
const LABELS = Object.freeze({ publicClientMtls: 'Require public client mTLS', serverCertificateVerification: 'Verify HTTPS server certificate',
    clientAssertionSignature: 'Verify assertion signature', clientAssertionAudience: 'Check assertion audience',
    clientAssertionReplay: 'Prevent assertion replay', clientAssertionExpiry: 'Check assertion expiry' });

/** Project exact registered display identities onto their existing simulation identity.
 * @param {object} config Current validated team configuration.
 * @returns {object[]} Registry rows with their server-resolved policy identity.
 */
function sources(config) {
    return getConfiguredDataSources(config, { includeDisabled: true }).map(source => ({ ...source, policyId: source.healthOrganizationId || source.id }));
}

/** Validate a current, closed form and return a candidate owning only its named fields.
 * @param {object} config Current validated configuration read inside publication mutex.
 * @param {object} body Scalar form fields. Source IDs are registered IDs, never names.
 * @returns {object} Independent fully validated candidate; invalid edits throw before publication.
 */
function edit(config, body) {
    const fail = (message, statusCode = 400, field) => { throw Object.assign(new Error(message), { statusCode, field }); };
    if (String(body.expectedRevision) !== String(config.runtime.revision || 0)) fail('Security settings changed. Refresh the saved settings and review your draft before saving.', 409);
    const next = structuredClone(config);
    const common = ['adminForm', 'expectedRevision'];
    const allowed = body.adminForm === 'simulation' ? [...common, 'preset', 'sourceId', 'resetDefaults', ...SIMULATION_CONTROLS.map(name => `control.${name}`)]
        : body.adminForm === 'token-duration' ? [...common, 'accessTokenExpiresInSeconds']
            : body.adminForm === 'own-token-capability' ? [...common, 'allowServiceProviderOwnTokenIntrospection'] : [];
    if (!allowed.length || Object.keys(body).some(key => !allowed.includes(key))) fail('Only this security form’s fields may be saved. Retired bypass controls are not allowed.');
    if (body.adminForm === 'token-duration') {
        const value = body.accessTokenExpiresInSeconds;
        if (!((typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
            || (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))))) fail('PCM access token duration must be a positive integer number of seconds.', 400, 'accessTokenExpiresInSeconds');
        next.security.pcmApi.accessTokenExpiresInSeconds = Number(value);
    } else if (body.adminForm === 'own-token-capability') {
        const value = body.allowServiceProviderOwnTokenIntrospection;
        if (!['default', 'true', 'false'].includes(value)) fail('Choose preset default, enabled or disabled.');
        if (value === 'default') delete next.security.pcmApi.allowServiceProviderOwnTokenIntrospection;
        else next.security.pcmApi.allowServiceProviderOwnTokenIntrospection = value === 'true';
    } else {
        if (typeof body.sourceId !== 'string') fail('Choose Global controls or an exact registered source ID.');
        const preset = body.preset;
        if (!PRESETS.includes(preset)) fail('Unknown security simulation preset.');
        const mode = preset === 'strict' ? 'strict' : 'connectathon';
        if (mode !== config.conformance.mode) fail('Changing strict/connectathon mode requires controlled local deployment recreation. No saved settings changed. Use reconfigure-local-team.js with this team and the selected preset.', 409);
        if (!['false', 'true'].includes(body.resetDefaults)) fail('Choose whether reviewed preset defaults replace saved overrides.');
        const selected = body.sourceId ? sources(config).find(source => source.id === body.sourceId) : null;
        if (body.sourceId && !selected) fail('Registered data source not found. Refresh Security before editing.', 404);
        if (selected && preset !== config.conformance.preset) fail('Source controls cannot change the team preset.');
        if (preset !== config.conformance.preset && body.resetDefaults !== 'true') fail('Preview and use the selected preset defaults before changing preset.');
        if (selected && body.resetDefaults !== 'false') fail('Restore preset defaults from Global controls.');
        if (body.resetDefaults === 'true') next.securitySimulation = { global: presetSimulationDefaults(preset), perSource: {}, awsCredentialIsolation: true };
        next.securitySimulation ||= { global: {}, perSource: {}, awsCredentialIsolation: true };
        const values = {};
        for (const name of SIMULATION_CONTROLS) {
            const value = body[`control.${name}`];
            if (selected) {
                if (!['inherit', 'true', 'false'].includes(value)) fail(`${LABELS[name]}: choose Inherit, On or Off.`, 400, `control.${name}`);
                if (value !== 'inherit') values[name] = value === 'true';
            } else {
                if (value !== undefined && value !== 'true' && value !== 'false') fail(`${LABELS[name]}: choose On or Off.`, 400, `control.${name}`);
                values[name] = preset === 'strict' && value === undefined ? true : value === 'true';
            }
        }
        if (selected) {
            if (Object.keys(values).length) Object.defineProperty(next.securitySimulation.perSource, selected.policyId, { value: values, enumerable: true, writable: true, configurable: true });
            else delete next.securitySimulation.perSource[selected.policyId];
        } else {
            next.securitySimulation.global = values;
            next.conformance = { ...next.conformance, preset, mode, policyVersion: POLICY_VERSION };
            const full = preset === 'strict' || preset === 'connectathon-mtls';
            next.security.pcmApi.clientAuth = full ? 'mtls' : 'tls';
            next.security.dataSourceGateway.clientAuth = full ? 'mtls' : 'tls';
            next.security.serviceProviderToDataSource.verifyServerCertificate = values.serverCertificateVerification;
            next.security.dsGatewayToFhirServer.verifyServerCertificate = values.serverCertificateVerification;
        }
    }
    try { assertValidTeamConfig(next, { env: process.env }); } catch (error) {
        if (body.adminForm === 'token-duration') error.field = 'accessTokenExpiresInSeconds';
        throw error;
    }
    return next;
}
module.exports = { LABELS, sources, edit };
