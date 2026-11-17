'use strict';

/**
 * Replaceable identity boundary for the sandbox authorization approval page.
 *
 * This provider deliberately models only configured synthetic/test patients;
 * it does not imply a national identity-provider contract.
 */

class ConfiguredTestIdentityProvider {
    constructor(patients = []) {
        this.patients = patients
            .filter(patient => patient?.idSystem && patient?.idValue)
            .map((patient, index) => ({
                subject: `configured-patient-${index + 1}`,
                display: patient.display || `Configured test patient ${index + 1}`,
                patient: { system: patient.idSystem, value: patient.idValue }
            }));
    }

    /** Return display-safe choices without exposing patient identifiers. */
    listChoices() {
        return this.patients.map(({ subject, display }) => ({ subject, display }));
    }

    /** Resolve one opaque UI choice to the bound patient identifier. */
    resolve(subject) {
        const match = this.patients.find(candidate => candidate.subject === subject);
        return match ? { ...match.patient } : null;
    }
}

module.exports = { ConfiguredTestIdentityProvider };

/** Add browser-bound verified self identity without accepting browser-supplied Patient identifiers. */
class BrowserAuthenticatedIdentityProvider {
    constructor(patients, flows) {
        // Person identities require a verified OTP or provider-owned SSO flow.
        this.synthetic = new ConfiguredTestIdentityProvider(patients.filter(patient => patient.idSystem === 'http://fhir.health.gov.il/identifier/il-hdp-test-id'));
        this.flows = flows;
    }

    /** Advertise verified self only while the owning browser's authentication is current. */
    listChoices(req) {
        const current = require('./system-browser-session').authenticatedFlow(req, this.flows);
        const flow = current?.syntheticFixture ? null : current;
        return [...this.synthetic.listChoices(), ...(flow ? [{ subject: 'authenticated-self', display: `Verified test self — ${flow.identifier.value}` }] : [])];
    }

    /** Resolve verified self from private state; dependent selection does not grant Consent approval. */
    resolve(subject, req) {
        if (subject !== 'authenticated-self') return this.synthetic.resolve(subject);
        const current = require('./system-browser-session').authenticatedFlow(req, this.flows);
        const flow = current?.syntheticFixture ? null : current;
        return flow ? structuredClone(flow.identifier) : null;
    }
}
module.exports.BrowserAuthenticatedIdentityProvider = BrowserAuthenticatedIdentityProvider;

/**
 * Explicit local GovID-like simulation. Only configured server facts produce a
 * one-use result; the result object is a private capability and cannot be supplied
 * as JSON or a browser handle. This is never national identity assurance.
 */
class LocalTrustedSsoProvider {
    constructor(config, { clock = () => Date.now() / 1000 } = {}) {
        this.config = config;
        this.clock = clock;
        this.results = new WeakMap();
    }

    /** Return opaque configured choices for the explicitly labelled simulation. */
    listChoices() {
        return (this.config.systemAuthorization.memberships || []).flatMap((member, index) =>
            member.localSso ? [{ subject: `local-sso-${index}`, display: member.localSso.display || 'Configured fabricated SSO identity' }] : []);
    }

    /** Issue a short-lived, browser/client-bound result from trusted local fixture facts. */
    issue(subject, browserBinding, clientId) {
        const choice = this.listChoices().find(value => value.subject === subject);
        const member = choice && this.config.systemAuthorization.memberships[Number(subject.slice('local-sso-'.length))];
        if (!member || !require('../../shared/identity-mapping').isPatientLoginEligible(member.identifier, member.loginEligibility)
            || clientId !== this.config.oauthClients.discoveryOrchestrator.clientId || typeof browserBinding !== 'string' || browserBinding.length < 32) {
            throw new Error('Local SSO result unavailable');
        }
        const result = Object.freeze({});
        this.results.set(result, { identifier: structuredClone(member.identifier), birthDate: member.localSso.birthDate,
            name: structuredClone(member.localSso.name || []), homeHmoId: member.homeHmoId, browserBinding, clientId, issuedAt: this.clock(), expiresAt: this.clock() + 60 });
        return result;
    }

    /** Consume once; stale, fabricated, cross-browser or cross-client results fail closed. */
    consume(result, browserBinding, clientId) {
        const evidence = this.results.get(result);
        this.results.delete(result);
        if (!evidence || evidence.browserBinding !== browserBinding || evidence.clientId !== clientId
            || evidence.issuedAt > this.clock() || evidence.expiresAt <= this.clock()) throw new Error('Local SSO result unavailable');
        return evidence;
    }
}
module.exports.LocalTrustedSsoProvider = LocalTrustedSsoProvider;
