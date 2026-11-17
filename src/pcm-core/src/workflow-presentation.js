'use strict';

/** Small, private browser form projections; no patient inventory lookup or authorization inference. */
const { parseBusinessIdentifier, normalizePatientIdentifier, DEFAULT_PATIENT_ID_SYSTEM, PALESTINIAN_NATIONAL_ID_SYSTEM, PASSPORT_ID_SYSTEMS, isPatientLoginEligible } = require('../../shared/identity-mapping');
const { readableDate } = require('../../shared/consent-presentation');

/** Preserve pasted values for explicit validation; normalize identifier whitespace with Doctor's parser. */
function formInput(body = {}) {
    const string = key => typeof body[key] === 'string' ? body[key].trim() : '';
    const input = { system: string('system') || DEFAULT_PATIENT_ID_SYSTEM, identifier: string('identifier'), birthDate: string('birthDate'), homeHmoId: string('homeHmoId') };
    const parsed = parseBusinessIdentifier(input.identifier, input.system);
    if (parsed) { input.system = parsed.system; input.identifier = parsed.value; }
    return input;
}

/** Validate syntax before contacting a source; source matching/contact/OTP remain separate checks. */
function validateForm(input) {
    if (input.system.length > 256 || input.identifier.length > 160 || input.homeHmoId.length > 64) return { field: 'identifier', message: 'Enter a supported patient identifier and select a registered HMO.' };
    try { normalizePatientIdentifier({ system: input.system, value: input.identifier }); }
    catch (_) { return { field: 'identifier', message: 'Enter a supported patient identifier. Israeli national IDs need nine digits and a valid check digit; keep leading zeros.' }; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate) || !Number.isFinite(Date.parse(input.birthDate))
        || new Date(input.birthDate).toISOString().slice(0, 10) !== input.birthDate) return { field: 'birthDate', message: 'Enter the complete date of birth recorded at the selected HMO.' };
    return null;
}

/** Readable identifier types, with exact raw systems retained only as values/technical details. */
function identifierTypes() {
    return [{ value: DEFAULT_PATIENT_ID_SYSTEM, label: 'Israeli national ID', helpKey: 'workflow.type-national' },
        { value: PALESTINIAN_NATIONAL_ID_SYSTEM, label: 'Palestinian national ID', helpKey: 'workflow.type-national' },
        ...[...PASSPORT_ID_SYSTEMS].filter(system => !system.endsWith('-ISR')).sort().map(value => ({ value, label: `Foreign passport (${value.split('-').at(-1)})`, helpKey: 'workflow.type-passport' }))];
}

/** Configuration-only editable test choices, without names or source demographics before verification. */
function configuredChoices(config) {
    return (config.patients || []).flatMap(patient => {
        const identifier = { system: patient.idSystem, value: patient.idValue };
        const facts = config.systemAuthorization.memberships.find(member => member.identifier.system === identifier.system && member.identifier.value === identifier.value)?.loginEligibility;
        if (!isPatientLoginEligible(identifier, facts)) return [];
        const type = identifierTypes().find(type => type.value === identifier.system);
        return type ? [{ ...identifier, label: `${type.label} — ${identifier.value}` }] : [];
    });
}

/** Format actual recorded instants with an explicit timezone. */
function time(seconds) { return Number.isFinite(seconds) ? readableDate(new Date(seconds * 1000).toISOString()) : 'Not recorded'; }

/** Authored stage-specific feedback avoids exposing source demographics or raw exceptions. */
function failure(action, flow, config, now, fieldError) {
    if (fieldError) return fieldError;
    if (action === 'start') return { message: 'Could not verify this patient at the selected HMO. Check the identifier, date of birth and current verification-code contact. Admin can review source readiness, HTTPS trust and workflow policy.' };
    if (!flow || flow.expiresAt <= now) return { message: 'This test sign-in expired or was cleared. Choose a patient and start again.' };
    if (action === 'verify') return { field: 'code', message: flow.attempts >= config.systemAuthorization.otp.maxAttempts
        ? 'Too many incorrect codes. Start the test sign-in again.' : flow.otpExpiresAt <= now
            ? 'This code expired. Request a new code or start again.' : 'The code is not correct. Check the current local code and try again.' };
    if (action === 'local-code') return { message: 'No current code is available. Request a new code or start again.' };
    if (action === 'resend') return { message: flow.resends >= config.systemAuthorization.otp.maxResends
        ? 'No more codes can be requested in this sign-in. Start again.' : 'A new code is not available yet. Check the wait time, or restart this sign-in.' };
    if (action === 'select') return { message: 'The relationship could not be confirmed again. Review the refreshed results and choose an eligible dependent.' };
    if (action.startsWith('presence')) return { message: 'Record locations could not be checked. Retry after reviewing source readiness and independent source-list eligibility.' };
    return { message: 'Dependent checks could not finish. Retry discovery or start this test sign-in again. Unknown HMOs do not mean no dependents exist.' };
}
module.exports = { formInput, validateForm, identifierTypes, configuredChoices, time, failure };
