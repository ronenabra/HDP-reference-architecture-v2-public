'use strict';

/** Classify an admitted raw gateway binding without changing its signed bytes. */
function classifyRequestBinding({ method, uri } = {}) {
    const invalid = () => { throw new Error('Protected FHIR request binding is invalid'); };
    if (typeof uri !== 'string' || uri.includes('..') || uri.includes('#')) return invalid();
    const separator = uri.indexOf('?');
    const path = separator < 0 ? uri : uri.slice(0, separator);
    const query = new URLSearchParams(separator < 0 ? '' : uri.slice(separator + 1));
    let decodedPath;
    try { decodedPath = decodeURIComponent(path); } catch (_error) { return invalid(); }
    const batchRoot = method === 'POST' && ['/fhir', '/fhir/'].includes(uri);
    if (batchRoot) return Object.freeze({ route: 'batch-root', clinicalTarget: false });
    // Type membership and .s authority are owned by the same native GET policy.
    // This transport grammar admits no instance/system operation or resource write.
    if (method === 'POST' && /^\/fhir\/[A-Z][A-Za-z0-9]{0,63}\/_search$/.test(path)
        && /^\/fhir\/[A-Za-z0-9_./?=&:%|,+-]*$/.test(uri)) {
        return Object.freeze({ route: 'type-search', clinicalTarget: true });
    }
    if (!['GET', 'HEAD'].includes(method)) return invalid();

    // An encoded operation name, Patient segment or trailing operation slash
    // must not fall through the ordinary path grammar and select cached authority.
    const everything = /^\/fhir\/Patient\/(?:[A-Za-z0-9.-]{1,64}\/)?\$everything$/.test(path);
    if (decodedPath.includes('$')) {
        if (!everything || method !== 'GET'
            || separator >= 0 && !/^[A-Za-z0-9_=&:%,+-]*$/.test(uri.slice(separator + 1))) return invalid();
        return Object.freeze({ route: 'patient-everything', clinicalTarget: true });
    }
    const clinicalPath = /^\/fhir\/[A-Za-z0-9_./?=&:%|,+-]*$/.test(uri);
    const root = ['/fhir', '/fhir/'].includes(path);
    const continuation = query.has('_getpages');
    if (!(clinicalPath || root && continuation && /^\/fhir\/?\?[A-Za-z0-9_=&:%|,+.-]*$/.test(uri))) return invalid();
    if (continuation) {
        // Decode names before selecting policy. Query order and encoded key
        // spellings must receive the same freshness and mandatory controls.
        const cursors = query.getAll('_getpages');
        if (cursors.length !== 1 || !/^[A-Za-z0-9_.-]+$/.test(cursors[0])) return invalid();
        return Object.freeze({ route: 'continuation', clinicalTarget: true });
    }
    const masterTarget = /^\/fhir\/(Organization|Practitioner|PractitionerRole|Location)(?:\/|$)/.test(decodedPath);
    return Object.freeze({ route: 'clinical', clinicalTarget: masterTarget, ...(masterTarget ? { masterTarget: true } : {}) });
}

module.exports = { classifyRequestBinding };
