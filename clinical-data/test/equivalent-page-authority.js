'use strict';
/** Find two genuinely distinct opaque credentials with identical returned authority, despite rolling history bounds. */
const assert = require('node:assert/strict');
/** Canonicalize object keys while retaining meaningful array order. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
/** Credential lifetime is checked separately on every request; only effective authority belongs in this key. */
function authorityKey(json) {
    return JSON.stringify(canonical({ scope: json.scope, authorization_details: json.authorization_details,
        resource: json.resource, patient: json.patient }));
}
/** At most four normal issuance calls; never relax changed authority to make a cursor pass. */
async function equivalentTokens(issue) {
    const seen = new Map();
    for (let attempt = 0; attempt < 4; attempt++) {
        const issued = await issue();
        assert.equal(issued.status, 200, `ordinary PCM token issuance HTTP${issued.status}`);
        assert.equal(typeof issued.json.access_token, 'string');
        const key = authorityKey(issued.json), previous = seen.get(key);
        if (previous && previous.json.access_token !== issued.json.access_token) return [previous, issued];
        seen.set(key, issued);
    }
    throw new Error('No distinct equivalent PCM authority pair within four issuance calls');
}
module.exports = { equivalentTokens, authorityKey };
