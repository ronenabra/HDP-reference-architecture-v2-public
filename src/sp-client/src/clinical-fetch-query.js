'use strict';
/** Bounded clinical queries; Patient lookup uses its authoritative business identity rather than inventory scanning. */
const { normalizePatientIdentifier } = require('../../shared/identity-mapping');
/** Build one first-page resource query, requiring an exact typed identity for Patient. */
function clinicalFetchQuery(type, patient, identityOptions = {}) {
    if (!/^[A-Z][A-Za-z]+$/.test(type)) throw new TypeError('Invalid clinical resource type');
    const params = new URLSearchParams({ _count: '10' });
    if (type === 'Patient') {
        const identifier = normalizePatientIdentifier(patient, identityOptions);
        params.set('identifier', `${identifier.system}|${identifier.value}`);
    }
    return `${type}?${params}`;
}
/** Select only search-authorized ceilings; read-only scopes need an explicit known-ID client. */
function searchableScopeTypes(scope) {
    const types = [...new Set(String(scope).split(' ').map(value => /^patient\/([A-Z][A-Za-z]+)\.(s|rs)$/.exec(value)?.[1]).filter(Boolean))];
    if (!types.length) throw new Error('These permissions allow individual record reads only. Supply a known logical ID through a direct read client; this preview requires search permission.');
    if (types.length > 15) throw new Error('Explicit supported patient resource ceilings are required');
    return types;
}
/** Validate an optional exact GET suffix without rewriting user path/query bytes.
 * @param {string} value Slash-prefixed path/query, or empty for generated searches.
 * @returns {string} Unchanged suffix; malformed or URL-normalized paths throw.
 */
function validateGetRequestOverride(value = '') {
    if (value === '') return value;
    if (typeof value !== 'string' || !/^\/(?!\/)[^\s#\\]*$/.test(value)
        || new URL(`https://override.invalid/fhir${value}`).href !== `https://override.invalid/fhir${value}`) {
        throw new Error('FHIR GET request override must start with / and contain an exact URL-encoded path/query, without fragments, spaces or relative dot segments.');
    }
    return value;
}
module.exports = { clinicalFetchQuery, searchableScopeTypes, validateGetRequestOverride };
