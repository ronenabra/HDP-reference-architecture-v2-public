'use strict';
/** Canonical JSON hashing for private, independently reviewed migration evidence. */
const crypto = require('crypto');
/** Encode recursively sorted object keys while retaining meaningful array order. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
/** Hash a canonical JSON value for provenance and exact decision comparisons. */
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
module.exports = { canonical, hash };
