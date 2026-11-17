'use strict';
/** Controlled UI help vocabulary. Runtime values never become executable markup or catalog keys. */
(function expose(root) {
    const choose = (values, value, fallback) => Object.prototype.hasOwnProperty.call(values, value) ? values[value] : fallback;
    const roles = { pcm: 'logs.role-pcm', doctor: 'logs.role-doctor', gateway: 'logs.role-gateway',
        adapter: 'logs.role-adapter', hapi: 'logs.role-hapi-runtime', 'hapi-import': 'logs.role-hapi', fhir: 'logs.role-fhir' };
    const levels = { INFO: 'logs.level-info', WARN: 'logs.level-warn', ERROR: 'logs.level-error',
        DEBUG: 'logs.level-debug', TRACE: 'logs.level-trace', FATAL: 'logs.level-fatal', UNKNOWN: 'logs.level-unknown' };
    const categories = { system: 'logs.class-system', security: 'logs.class-security', harness: 'logs.class-harness',
        lifecycle: 'logs.class-lifecycle', admin: 'logs.class-admin', noise: 'logs.class-noise', uncategorized: 'logs.class-uncategorized' };
    // Supported metadata labels are deliberately finite; arbitrary payload keys
    // belong to the generic field explorer, not invented explanations.
    const metadata = {
        'Timestamp': 'logs.time', 'Level': 'logs.level', 'Event ID': 'logs.id',
        'Schema version': 'logs.schema', 'Classification': 'logs.class', 'Event name': 'logs.event-name',
        'Source identity': 'logs.source-identity', 'Source component ID': 'logs.source-component',
        'Source file': 'logs.source-file', 'Source byte offset': 'logs.source-offset',
        'Provenance': 'logs.provenance', 'Derived from': 'logs.derived-from',
        'Flow ID': 'logs.flow-id', 'Correlation / request ID': 'logs.correlation',
        'Trace ID': 'logs.trace-id', 'Span ID': 'logs.span-id', 'Parent span ID': 'logs.parent-span-id',
        'Parse status': 'logs.parse-status', 'Provenance note': 'logs.provenance-note'
    };
    const values = {
        metadata: label => choose(metadata, label, null),
        component: role => choose(roles, role, 'logs.component'),
        level: level => choose(levels, String(level).toUpperCase(), 'logs.level-unknown'),
        category: category => choose(categories, category, 'logs.class'),
        identity: id => choose({ 'hospital-a': 'doctor.identity-primary', 'hospital-b': 'doctor.identity-secondary',
            untrusted: 'doctor.identity-untrusted', 'untrusted-assertion': 'doctor.identity-untrusted-assertion' }, id, 'doctor.identity-registered')
    };
    if (typeof module !== 'undefined') module.exports = values;
    else root.PCM_HELP_VALUES = values;
})(typeof window !== 'undefined' ? window : globalThis);
