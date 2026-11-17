'use strict';
/** Validated display-only preferences and recorded identifier access for Logs. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PCM_LOG_COLUMNS = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
    const key = 'unifiedLogColumns';
    const columns = Object.freeze([
        { id: 'time', label: 'Time', width: 85, default: true },
        { id: 'component', label: 'Component', width: 165, default: true },
        { id: 'correlationId', label: 'Correlation ID', width: 130, default: true },
        { id: 'flowId', label: 'Flow ID', width: 130, default: false },
        { id: 'traceId', label: 'Trace ID', width: 130, default: false },
        { id: 'kind', label: 'Type', width: 55, default: true },
        { id: 'level', label: 'Level', width: 65, default: true },
        { id: 'class', label: 'Class', width: 90, default: true },
        { id: 'message', label: 'Message (required)', width: 280, default: true }
    ].map(Object.freeze));
    /** Reject unknown versions/shapes; known boolean fields survive added columns. */
    function validate(value) {
        const valid = value && value.version === 1 && value.visible && typeof value.visible === 'object' && !Array.isArray(value.visible);
        return Object.fromEntries(columns.map(column => [column.id, column.id === 'message' ? true :
            valid && Object.hasOwn(value.visible, column.id) && typeof value.visible[column.id] === 'boolean' ? value.visible[column.id] : column.default]));
    }
    /** Access storage lazily because browsers can deny even its property getter. */
    function load(getStorage) {
        try { return validate(JSON.parse(getStorage().getItem(key))); }
        catch (_) { return validate(null); }
    }
    /** Persist a strict allowlist of booleans, never event IDs or payloads. */
    function save(getStorage, visible) {
        try { getStorage().setItem(key, JSON.stringify({ version: 1, visible: validate({ version: 1, visible }) })); return true; }
        catch (_) { return false; }
    }
    /** Keep the same normalized then legacy fallbacks as metadata/inspection. */
    function identifier(log, field) {
        if (!['correlationId', 'flowId', 'traceId'].includes(field)) return '';
        return log.event?.correlation?.[field] || log.details?.[field] || (field === 'correlationId' ? log.details?.requestId : '') || '';
    }
    /** Compact presentation never changes the exact recorded value. */
    function compact(value) { const text = String(value); return text.length > 16 ? text.slice(0, 8) + '…' + text.slice(-6) : text; }
    const kinds = [
        { label: 'Request', icon: '↗', events: ['REQUEST', 'OUTGOING_REQUEST', 'GATEWAY_REQUEST', 'HAPI_REQUEST', 'SYSTEM_WORKFLOW_REQUEST'] },
        { label: 'Response', icon: '↩', events: ['RESPONSE', 'OUTGOING_RESPONSE', 'GATEWAY_RESPONSE', 'HAPI_RESPONSE', 'SYSTEM_WORKFLOW_RESPONSE'] },
        { label: 'Processing', icon: '⚙', events: ['TOKEN_ISSUED', 'TOKEN_MINTED', 'TOKEN_AUTHORIZATION_DENIED', 'TOKEN_VALIDATION',
            'INTROSPECTION_DECISION', 'INTROSPECTION_PROCESSED', 'INTROSPECTION_TOKEN_REFRESH', 'IDENTITY_MAPPED',
            'DS_AUTHORIZATION_DECISION', 'HAPI_ADMISSION', 'HAPI_RESOURCE_DECISION', 'HAPI_RESULT_FILTER_SUMMARY', 'HAPI_NATIVE_WORK_FINISHED'] }
    ];
    /** Classify exact recorded names; ambiguous errors and unfamiliar names remain unknown.
     * @param {object} log Existing row summary, including normalized or legacy event type.
     * @returns {{label: string, icon: string}} Accessible label and display icon.
     */
    function kind(log) {
        const name = log.event?.eventName || log.details?.type;
        const match = kinds.find(item => item.events.includes(name));
        return match ? { label: match.label, icon: match.icon } : { label: 'Other/unknown', icon: '?' };
    }
    return { key, columns, validate, load, save, identifier, compact, kind };
});
