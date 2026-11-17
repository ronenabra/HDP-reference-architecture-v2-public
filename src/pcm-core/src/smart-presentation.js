'use strict';
/** Describe exact SMART request permissions without claiming a clinical service or Consent ceiling. */
const { parsePatientScope } = require('./authorize-service');
const actions = { c: 'create', r: 'read', u: 'update', d: 'delete', s: 'search' };
/** Return faithful labels; retain unfamiliar or filtered scope text as technical protocol data. */
function describeScopes(scopes) {
    return scopes.map(scope => {
        const parsed = parsePatientScope(scope)?.[0];
        if (!parsed) return { scope, label: `Protocol permission: ${scope}` };
        return { scope, label: `${[...parsed.permissions].map(action => actions[action]).join(' and ')} ${parsed.resource === '*' ? 'all FHIR resource types' : parsed.resource} for the selected patient${parsed.query ? ' with additional exact constraints shown in Protocol testing' : ''}.` };
    });
}
module.exports = { describeScopes };
