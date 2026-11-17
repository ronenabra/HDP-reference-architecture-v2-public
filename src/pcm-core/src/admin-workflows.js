'use strict';

/** Closed local workflow editor over the existing validated private team configuration. */
const FIELDS = Object.freeze([
    ['otp', 'expirySeconds', 'OTP expiry', 'seconds', 30, 600],
    ['otp', 'resendSeconds', 'OTP resend interval', 'seconds', 1, 300],
    ['otp', 'maxAttempts', 'OTP attempts per flow', 'attempts', 1, 10],
    ['otp', 'maxResends', 'OTP resends per flow', 'resends', 0, 10],
    ['otp', 'contactMaxAgeSeconds', 'Maximum contact evidence age', 'seconds', 1, 31536000],
    ['authentication', 'flowLifetimeSeconds', 'Sign-in flow lifetime', 'seconds', 30, 3600],
    ['authentication', 'authenticatedLifetimeSeconds', 'Authenticated session lifetime', 'seconds', 1, 3600],
    ['authentication', 'timeoutMilliseconds', 'Authentication request timeout', 'milliseconds', 100, 120000],
    ['discovery', 'timeoutMilliseconds', 'Discovery timeout per source', 'milliseconds', 100, 120000],
    ['discovery', 'maxPagesPerSource', 'Discovery pages per stream and source', 'pages', 1, 100],
    ['discovery', 'maxRetries', 'Discovery request retries', 'retries', 0, 3]
].map(([group, name, label, unit, min, max]) => Object.freeze({ group, name, key: `${group}.${name}`, label, unit, min, max })));

/** Return a validated candidate owning only the eleven bounded, non-secret fields.
 * @param {object} config Current configuration read inside the existing mutex.
 * @param {object} body Scalar submitted fields, including the reviewed saved revision.
 * @returns {object} Detached validated candidate. No publication happens here.
 */
function edit(config, body) {
    const fail = (message, statusCode = 400, field) => { throw Object.assign(new Error(message), { statusCode, field }); };
    if (String(body.expectedRevision) !== String(config.runtime.revision || 0)) fail('Workflow settings changed. Refresh the saved settings and review your draft.', 409);
    const allowed = ['expectedRevision', ...FIELDS.map(field => field.key)];
    if (Object.keys(body).some(key => !allowed.includes(key))) fail('Save only the bounded test workflow settings. Membership, entitlements and Contract policy are separately owned.');
    const next = structuredClone(config);
    for (const field of FIELDS) {
        const raw = body[field.key];
        if (!(typeof raw === 'number' && Number.isSafeInteger(raw) || typeof raw === 'string' && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)))
            || Number(raw) < field.min || Number(raw) > field.max) fail(`${field.label} must be an integer from ${field.min} to ${field.max} ${field.unit}.`, 400, field.key);
        next.systemAuthorization[field.group][field.name] = Number(raw);
    }
    if (next.systemAuthorization.otp.resendSeconds >= next.systemAuthorization.otp.expirySeconds) fail('OTP resend interval must be shorter than OTP expiry.', 400, 'otp.resendSeconds');
    require('../../shared/team-config-validator').assertValidTeamConfig(next, { env: process.env });
    return next;
}
module.exports = { FIELDS, edit };
