'use strict';

/** Coordinated private scope boundary; an artifact attestation is not source qualification. */
const VERSIONS = Object.freeze({ wildcard: 'pcm-patient-wildcard/1', service: 'pcm-service-grant/1', compiler: 'pcm-service-scope/1',
    approval: 'pcm-consent-scope/1', token: 'pcm-data-grant/6', firstUse: 'pcm-clinical-first-use/2',
    config: 'pcm-team-config/5', policy: 'pcm-sandbox-policy/4', context: 'pcm-ds-authorization-context/4', localToken: 'pcm-ds-local-token/5' });

/** Require the complete exact boundary; partial/mixed consumers cannot resume a checkpoint. */
function assertScopeVersions(value) {
    if (JSON.stringify(Object.keys(value || {}).sort()) !== JSON.stringify(Object.keys(VERSIONS).sort())
        || Object.keys(VERSIONS).some(key => value[key] !== VERSIONS[key])) throw new Error('Mixed scope versions: deploy the reviewed PCM/Doctor/adapter/HAPI/config boundary together.');
}
module.exports = { VERSIONS, assertScopeVersions };
