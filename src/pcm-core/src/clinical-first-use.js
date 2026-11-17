'use strict';

/** Stable versioned clinical usage keys; never infer ownership of legacy windows. */
const VERSION = 'pcm-clinical-first-use/2';

/** Bind usage independently of token, URL or certificate.
 * @param {string} serviceId Stable workspace service registration id.
 * @param {string} consentId Stable workspace Consent id.
 * @param {string} clientId Authenticated application's registered OAuth id.
 * @param {string} sourceId Authoritative Data Source Organization id.
 * @returns {string} Unambiguous versioned composite repository key.
 */
function firstUseKey(serviceId, consentId, clientId, sourceId) {
    const identities = [serviceId, consentId, clientId, sourceId];
    if (identities.some(value => typeof value !== 'string' || !value)) throw new TypeError('Complete clinical first-use identity is required');
    return JSON.stringify([VERSION, ...identities]);
}

/** Read usage without assigning an old Consent/source record to a new client.
 * @param {object} store Existing first-use repository with a read-only get method.
 * @param {string} serviceId Stable service registration id.
 * @param {string} consentId Stable Consent id.
 * @param {string} clientId Authenticated registered application id.
 * @param {string} sourceId Authoritative Data Source Organization id.
 * @returns {object|null} Existing record, explicit unresolved failure, or unused null.
 */
function readFirstUse(store, serviceId, consentId, clientId, sourceId) {
    if (store.get(`${consentId}\u0000${sourceId}`)) return { ok: false, legacy: true };
    const record = store.get(firstUseKey(serviceId, consentId, clientId, sourceId));
    // The general repository reader accepts arbitrary positive intervals. Clinical
    // reads must enforce the one-hour contract before issuance can use a deadline.
    if (record !== null && (!record || record.ok !== true
        || !Number.isSafeInteger(record.startedAt) || !Number.isSafeInteger(record.expiresAt)
        || record.expiresAt !== record.startedAt + 60 * 60)) return { ok: false };
    return record;
}

module.exports = { VERSION, firstUseKey, readFirstUse };
