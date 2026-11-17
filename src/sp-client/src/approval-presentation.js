'use strict';
/** Public Consent/service facts and explicitly attributed OAuth observations. */
const { servicePermissions, permissionSummary, planQueries } = require('./permission-plan');
const { EXTENSIONS, CODE_SYSTEMS } = require('../../shared/pcm-contract');

/** Build card state without issuing requests or inspecting a bearer credential.
 * @param {object} consent Public Consent facts.
 * @param {object} service Public service projection.
 * @param {object} record Local card query/token/status state.
 * @param {number} now Current time in milliseconds for local expiry.
 * @returns {object} Attributed public facts, intent and applicable token observations.
 */
function approvalPresentation(consent, service = {}, record = {}, now = Date.now()) {
    const intent = service.permissions || servicePermissions(service.definition);
    const grant = record.tokenGrant;
    const expired = grant && grant.expiresAt <= now;
    const usable = consent?.status === 'active' && !record.authorityBlocked;
    const queryScope = record.querySelection || intent.ceiling;
    let plan;
    try { plan = planQueries(grant && !expired ? permissionSummary(grant.scope) : intent, queryScope); } catch (_) { /* A malformed deliberate override stays visible for correction. */ }
    const mode = consent?.category?.flatMap(value => value.coding || []).find(value => value.system === CODE_SYSTEMS.consentAccessMode && ['continuous', 'one-time'].includes(value.code))?.code;
    return { available: true, usable, intent, queryScope, plan, grant: expired ? null : grant, expired,
        accessMode: mode || 'Unavailable', businessStatus: consent?.extension?.find(value => value.url === EXTENSIONS.consentBusinessStatus && value.valueCoding?.system === CODE_SYSTEMS.consentBusinessStatus)?.valueCoding?.code || 'Unavailable',
        message: grant && !expired ? 'Retrieval selection validated against the token-response grant.' : 'Intended retrieval selection. Granted permissions not yet obtained.',
        tokenStatus: expired ? { state: 'expired', message: 'Token expired locally; fetch again to request a new token.' } : record.tokenStatus || { state: 'unchecked', message: 'Token status not checked' } };
}
module.exports = { approvalPresentation };
