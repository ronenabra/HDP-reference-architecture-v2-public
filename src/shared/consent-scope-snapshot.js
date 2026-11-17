'use strict';

/** Exact private approval decisions. Reading never consults a service or compiler. */
const URL = 'urn:pcm:sandbox:consent-scope-snapshot';
const MODEL = 'pcm-consent-scope/1';
const { SANDBOX_EXTENSIONS, EXTENSIONS } = require('./pcm-contract');
const { inspectScope } = require('./service-grant');

/** Retain advisory text while rejecting only an unsafe/unbounded storage envelope. */
function approvalDiagnostics(scope) {
    if (typeof scope !== 'string' || scope.length > 16384) {
        throw Object.assign(new TypeError('Approval scope must be text, at most 16384 characters.'), { status: 400 });
    }
    if (!scope.trim()) return { syntax: 'invalid', applicability: 'invalid', capability: 'unsupported', issues: ['Empty approval cannot authorize data.'] };
    return inspectScope(scope).diagnostics;
}

/** Read one closed serialized decision without repairing legacy/malformed approvals. */
function readApprovalSnapshot(consent) {
    const values = (consent?.extension || []).filter(item => item.url === URL);
    if (!values.length) return null;
    if (values.length !== 1 || Object.keys(values[0]).sort().join(',') !== 'url,valueString') throw new TypeError('Invalid approval snapshot extension.');
    let saved;
    try { saved = JSON.parse(values[0].valueString); } catch { throw new TypeError('Invalid approval snapshot JSON.'); }
    if (!saved || Object.keys(saved).sort().join(',') !== 'actor,anchor,approvedAt,choice,diagnostics,generator,historyMode,model,origin,scope,service,usable,validity'
        || saved.model !== MODEL || !['service-provided', 'auto-resources', 'auto-buckets', 'custom'].includes(saved.choice)
        || typeof saved.origin !== 'string' || !saved.actor || typeof saved.actor.id !== 'string' || typeof saved.actor.simulation !== 'boolean'
        || !saved.service || Object.keys(saved.service).sort().join(',') !== 'definitionId,definitionVersion,grant,id,version'
        || typeof saved.service.id !== 'string' || typeof saved.service.version !== 'string'
        || typeof saved.service.definitionId !== 'string' || typeof saved.service.definitionVersion !== 'string'
        || Object.keys(saved.actor).sort().join(',') !== 'id,simulation'
        || !['creation-fixed', 'approval-fixed', 'manual-literal', 'missing'].includes(saved.historyMode)
        || !(saved.generator === null || saved.generator === require('./service-grant').COMPILER)
        || !Number.isFinite(Date.parse(saved.approvedAt)) || !Number.isFinite(Date.parse(saved.anchor))
        || !saved.validity || !['continuous', 'one-time'].includes(saved.validity.mode)
        || saved.validity.start !== saved.approvedAt || !Number.isFinite(Date.parse(saved.validity.end))
        || Date.parse(saved.validity.end) <= Date.parse(saved.validity.start)
        || JSON.stringify(saved.diagnostics) !== JSON.stringify(approvalDiagnostics(saved.scope))
        || saved.usable !== Object.entries(saved.diagnostics).every(([axis, value]) => axis === 'issues' || ['valid', 'supported'].includes(value))) {
        throw new TypeError('Invalid approval snapshot version, provenance or diagnostics.');
    }
    const extension = url => (consent.extension || []).find(item => item.url === url);
    if (extension(SANDBOX_EXTENSIONS.approvedTokenScope)?.valueString !== saved.scope
        || extension(SANDBOX_EXTENSIONS.approvedTokenScopeOrigin)?.valueString !== `${saved.origin}: ${saved.choice}`
        || extension(EXTENSIONS.pcmService)?.valueReference?.reference !== `HealthcareService/${saved.service.id}`
        || !consent.category?.some(category => category.coding?.some(code => code.system === require('./pcm-contract').CODE_SYSTEMS.consentAccessMode && code.code === saved.validity.mode))
        || JSON.stringify(consent.provision?.period) !== JSON.stringify({ start: saved.validity.start, end: saved.validity.end })) throw new TypeError('Approval snapshot differs from its Consent binding.');
    return saved;
}

/** Compare permission-bearing fields on every store replacement of a decided Consent. */
function assertImmutableApproval(current, candidate) {
    if (!current || current.resourceType !== 'Consent') return;
    if (candidate.meta?.versionId !== current.meta?.versionId) throw Object.assign(new Error('Consent changed; refresh the current version.'), { status: 409 });
    const currentSnapshot = readApprovalSnapshot(current);
    if (!currentSnapshot && ['proposed', 'draft'].includes(current.status)) return;
    const protectedUrls = new Set([URL, SANDBOX_EXTENSIONS.approvedTokenScope, SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, EXTENSIONS.pcmService]);
    const permission = resource => ({
        extension: (resource.extension || []).filter(item => protectedUrls.has(item.url)),
        patient: resource.patient, identifier: resource.identifier, dateTime: resource.dateTime,
        category: resource.category, scope: resource.scope, period: resource.provision?.period,
        actors: (resource.provision?.actor || []).filter(item => !item.role?.coding?.some(code => code.code === 'CST')),
        purpose: resource.provision?.purpose, type: resource.provision?.type
    });
    if (JSON.stringify(permission(current)) !== JSON.stringify(permission(candidate))) {
        throw Object.assign(new Error('Approved permissions, service, identity, period and access mode are read-only. Create a new Consent for changed permissions.'), { status: 409 });
    }
}
module.exports = { URL, MODEL, approvalDiagnostics, readApprovalSnapshot, assertImmutableApproval };
