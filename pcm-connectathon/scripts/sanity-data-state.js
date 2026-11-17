'use strict';

/** Select an explicit ordinary Doctor service owned by the selected identity; never use a sandbox exception. */
function doctorServiceId(config, identity) {
    if (!config.serviceCatalog) return config.service.id;
    const owner = { 'hospital-a': ['doctor', 'serviceProvider'], 'hospital-b': ['doctor-b', 'hospitalBServiceProvider'] }[identity];
    const bindings = config.serviceCatalog.bindings.filter(binding => owner && binding.application === owner[0]
        && binding.providerRole === owner[1] && binding.serviceKey === 'lab-follow-up');
    if (bindings.length !== 1) throw new Error('Sanity requires one owned ordinary Doctor catalog service');
    return bindings[0].instanceId;
}

/**
 * Copy the current enabled ordinary registration's opaque stamp from Doctor's rendered composer.
 * @param {string} html Current server-owned EJS response, using its double-quoted form attributes.
 * @param {object} config Selected team configuration with the explicit ordinary lab binding.
 * @param {string} identity Registered Doctor provider; diagnostic identities cannot borrow a form.
 * @returns {{serviceId: string, serviceStamp: string}} Exact submitted service fields.
 */
function doctorServiceSelection(html, config, identity) {
    if (!['hospital-a', 'hospital-b'].includes(identity)) throw new Error('Doctor selection requires an ordinary provider');
    const serviceId = doctorServiceId(config, identity);
    const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
        .map(match => match[0]).filter(form => /^<form\b[^>]*\saction="\/[^"]*\/create-consent"/.test(form)
            || /^<form\b[^>]*\saction="\/create-consent"/.test(form));
    if (forms.length !== 1) throw new Error('Expected one current Doctor composer');
    const owners = forms[0].match(/<input\b[^>]*\sname="identity"[^>]*>/g) || [];
    if (owners.length !== 1 || owners[0].match(/\svalue="([^"]*)"/)?.[1] !== identity) throw new Error('Doctor form belongs to another provider');
    const selectors = forms[0].match(/<select\b[^>]*\sname="serviceId"[^>]*>[\s\S]*?<\/select>/g) || [];
    if (selectors.length !== 1 || /\sdisabled(?:[\s=>])/.test(selectors[0].split('>')[0] + '>')) throw new Error('Doctor service selection is unavailable');
    const options = (selectors[0].match(/<option\b[^>]*>/g) || [])
        .filter(option => option.match(/\svalue="([^"]*)"/)?.[1] === serviceId);
    const serviceStamp = options[0]?.match(/\sdata-service-stamp="([0-9a-f]{64})"/)?.[1];
    if (options.length !== 1 || /\sdisabled(?:[\s=>])/.test(options[0]) || !serviceStamp) throw new Error('Expected one enabled owned registration with its current stamp');
    return { serviceId, serviceStamp };
}

/**
 * Copy enabled source/query inputs from the exact created Consent's current rendered form.
 * @param {string} html Doctor response after refreshing this Consent's status and sources.
 * @param {string} identity Selected ordinary provider.
 * @param {string} consentId Exact newly created Consent ID, independently read from PCM.
 * @returns {{endpointUrl: string, requestedScope: string}} Existing source and query selection.
 */
function doctorConsentQuery(html, identity, consentId) {
    const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0])
        .filter(form => (form.match(/<input\b[^>]*\sname="consentId"[^>]*>/g) || [])
            .some(input => input.match(/\svalue="([^"]*)"/)?.[1] === consentId));
    if (forms.length !== 1) throw new Error('Expected one current created-Consent form');
    const fields = {};
    for (const name of ['identity', 'consentId', 'endpointUrl', 'requestedScope']) {
        const inputs = (forms[0].match(/<input\b[^>]*>/g) || []).filter(input => input.includes(` name="${name}"`));
        const value = inputs[0]?.match(/\svalue="([^"]*)"/)?.[1];
        if (inputs.length !== 1 || /\sdisabled(?:[\s=>])/.test(inputs[0]) || !value) throw new Error(`Current Consent ${name} is unavailable`);
        // Decode only the five escapes emitted by EJS's attribute encoder, once.
        fields[name] = value.replace(/&amp;|&lt;|&gt;|&#34;|&#39;/g,
            entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#34;': '"', '&#39;': "'" })[entity]);
    }
    const fetch = (forms[0].match(/<button\b[^>]*>/g) || []).filter(button => /\sformaction="\/[^"]*fetch-data"/.test(button));
    if (fields.identity !== identity || fields.consentId !== consentId || fetch.length !== 1 || /\sdisabled(?:[\s=>])/.test(fetch[0])) throw new Error('Consent retrieval is unavailable for this provider');
    return { endpointUrl: fields.endpointUrl, requestedScope: fields.requestedScope };
}

/**
 * Recognize the current successful create feedback without accepting quoted errors or stale copy.
 * @param {object} response Doctor's redirected HTTP response.
 * @returns {boolean} Whether its one feedback alert records successful request creation.
 */
function doctorConsentCreated(response) {
    if (response?.statusCode !== 200 || response.error || typeof response.body !== 'string') return false;
    const feedback = [...response.body.matchAll(/<div\b(?=[^>]*\sdata-help-key="common.feedback")[^>]*>([\s\S]*?)<\/div>/g)];
    return feedback.length === 1 && /\sclass="[^"]*\balert-success\b[^"]*"/.test(feedback[0][0].split('>')[0])
        && feedback[0][1].trim() === 'Consent request created. Check its recorded PCM status; creation does not fetch data or prove a patient decision.';
}

/** Select an evidence-backed presence expectation, without treating unverified data as empty. */
function presencePrerequisite(verifiedPatient, response) {
    if (verifiedPatient) return { state: 'populated-verified', expectedTotal: 1,
        identifier: `${verifiedPatient.idSystem}|${verifiedPatient.idValue}` };
    if (response?.statusCode !== 200 || !Number.isSafeInteger(response.json?.actualCounts?.Patient)
        || response.json.actualCounts.Patient < 0) {
        return { state: 'unavailable', reason: 'Exact private Patient counts are unavailable; presence cannot be qualified.' };
    }
    if (response.json.actualCounts.Patient > 0) {
        return { state: 'populated-unverified', reason: 'Patient data exists without a verified selected fixture; no absence or patient-presence expectation is established.' };
    }
    return { state: response.json.actualResourceCount === 0 ? 'empty' : 'populated-without-patients', expectedTotal: 0,
        identifier: 'http://fhir.health.gov.il/identifier/il-hdp-test-id|1' };
}
/** Require a concrete clinical Observation; a successful empty Bundle is not clinical evidence. */
function hasPositiveObservation(data) {
    const observations = data?.resourceType === 'Observation' ? [data]
        : data?.resourceType === 'Bundle' && Array.isArray(data.entry)
            ? data.entry.map(entry => entry?.resource) : [];
    return observations.some(resource => resource?.resourceType === 'Observation'
        && typeof resource.id === 'string' && resource.id.length > 0
        && typeof resource.status === 'string' && resource.status.length > 0
        && (typeof resource.subject?.reference === 'string' && resource.subject.reference.length > 0
            || typeof resource.subject?.identifier?.system === 'string'
                && typeof resource.subject?.identifier?.value === 'string'));
}
/** Build the closed Contract/Patient RAR from an explicitly selected typed identity. */
function presenceAuthorizationDetails(identifier) {
    const parts = String(identifier).split('|');
    if (parts.length !== 2 || parts.some(value => !value)) throw new Error('Presence requires an exact system|value identifier');
    // Admin executes this script with shared modules mounted at /shared;
    // the PCM checkout path is not present inside that container.
    const { sharedModuleRoot } = require('./lib');
    const { TYPE, ROLE: ROLE_BASE } = require(require('node:path').join(sharedModuleRoot(), 'data-authorization-details'));
    return [{ type: TYPE, fhirContext: [
        { type: 'Contract', role: `${ROLE_BASE}authorization-basis`, identifier: {
            system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001'
        } },
        { type: 'Patient', role: `${ROLE_BASE}authorization-patient`, identifier: { system: parts[0], value: parts[1] } }
    ] }];
}
/** Determine whether the selected typed identity is explicitly eligible, without inferring a grant. */
function presenceIsConfigured(config, identifier) {
    const requested = presenceAuthorizationDetails(identifier)[0].fhirContext[1].identifier;
    return config.systemAuthorization.presenceEligiblePatients.some(patient => patient.system === requested.system && patient.value === requested.value);
}
/** Confirm absence only after reaching the closed FHIR boundary, never from an auth failure. */
function jwksIsAbsent(response) {
    const code = response?.statusCode === 405 ? 'not-supported' : response?.statusCode === 404 ? 'not-found' : null;
    return Boolean(code && response.json?.resourceType === 'OperationOutcome'
        && response.json.issue?.some(issue => issue.code === code) && !Object.hasOwn(response.json, 'keys'));
}
/** Match a run's selected patient and owning provider without selecting another provider's Consent. */
function consentMatchesOwner(consent, patient, owner) {
    const identifier = Array.isArray(consent.patient?.identifier) ? consent.patient.identifier[0] : consent.patient?.identifier;
    const requesting = (consent.provision?.actor || []).filter(actor => actor.role?.coding?.some(coding => coding.code === 'IRCP'
        && coding.system === 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType'));
    return requesting.length === 1 && requesting[0].reference?.reference === `Organization/${owner}`
        && identifier?.value === patient?.idValue && identifier?.system === patient?.idSystem;
}
module.exports = { consentMatchesOwner, doctorServiceId, doctorServiceSelection, doctorConsentQuery, doctorConsentCreated, hasPositiveObservation, presencePrerequisite, presenceAuthorizationDetails, presenceIsConfigured, jwksIsAbsent };
