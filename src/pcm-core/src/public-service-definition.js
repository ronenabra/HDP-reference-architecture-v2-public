'use strict';
/** Freeze the server's ordinary public-definition defaults once at registration.
 * Public callers supply public service facts; private scope/policy overrides are
 * accepted only by the existing authenticated owner authoring command.
 */
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { MODEL, COMPILER, inspectScope } = require('../../shared/service-grant');
const { policyExtension } = require('../../shared/service-confidentiality-policy');
const { compileConsentScope, BUCKET_RESOURCES } = require('./grant-compiler');

/** Create a definition from public buckets and safe server-owned policy defaults. */
function definitionFromPublic(resource, now = new Date()) {
    const buckets = resource.extension.filter(item => item.url === EXTENSIONS.informationBucket).map(require('../../shared/information-buckets').parseInformationBucket);
    const types = ['Patient', ...new Set(buckets.flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.coding.code] || {})))];
    const coarse = types.map(type => `patient/${type}.rs`).join(' ');
    const canonical = { ...resource, extension: [...resource.extension, policyExtension({ allowRestricted: false })] };
    const scope = compileConsentScope({ store: { get: () => canonical }, service: { extension: [{ url: EXTENSIONS.basedOnCanonicalHealthcareService,
        valueReference: { reference: 'HealthcareService/creation' } }] }, scope: coarse, approved: coarse, now: Math.floor(now.getTime() / 1000), reusable: true });
    const one = url => resource.extension.find(item => item.url === url);
    const authoring = { name: resource.name, purpose: resource.extraDetails,
        category: resource.category?.[0]?.coding?.[0]?.code, accessMode: one(EXTENSIONS.accessMode).valueCode,
        duration: one(EXTENSIONS.accessDuration).valueDuration.value, durationUnit: one(EXTENSIONS.accessDuration).valueDuration.code,
        allowChanges: one(EXTENSIONS.allowPatientBucketChange).valueBoolean,
        buckets: buckets.map(bucket => ({ code: bucket.coding.code, history: bucket.history.value, historyUnit: bucket.history.code,
            sensitivity: bucket.taggedDetails.map(coding => `${coding.system}|${coding.code}`) })),
        permissions: types.map(type => ({ type, actions: 'rs' })), scopeOrigin: 'generated',
        confidentialityPolicy: { allowRestricted: false }, includeMasterData: false };
    return { grant: { model: MODEL, compiler: COMPILER, origin: 'generated', scope, anchor: new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(),
        historyMode: 'creation-fixed', authoring, diagnostics: inspectScope(scope).diagnostics },
        options: [], confidentialityPolicy: { allowRestricted: false }, includeMasterData: false };
}
module.exports = { definitionFromPublic };
