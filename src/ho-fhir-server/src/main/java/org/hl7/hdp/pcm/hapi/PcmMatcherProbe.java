package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.searchparam.matcher.AuthorizationSearchParamMatcher;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher;
import org.hl7.fhir.r4.model.Observation;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.Reference;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/** Runs the startup-time compatibility probe against HAPI's native matcher. */
public final class PcmMatcherProbe {
    private PcmMatcherProbe() {
    }

    /**
     * Probe exact scope forms needed by the sandbox. Startup fails if a form
     * expected to be supported is not matched, or a deferred form is accepted.
     */
    public static Map<String, IAuthorizationSearchParamMatcher.Match> probe(
            AuthorizationSearchParamMatcher matcher) {
        Patient patient = new Patient();
        patient.setId("Patient/p1");
        patient.addIdentifier().setSystem("http://example.test/mrn").setValue("123");

        Observation observation = new Observation();
        observation.setId("Observation/o1");
        observation.setStatus(Observation.ObservationStatus.FINAL);
        observation.addIdentifier().setSystem("http://example.test/lab").setValue("A");
        observation.setSubject(new Reference("Patient/p1"));
        observation.setEffective(new org.hl7.fhir.r4.model.DateTimeType(Instant.parse("2026-01-02T00:00:00Z").toString()));
        observation.getMeta().addSecurity("http://example.test/security", "normal", null);

        Map<String, IAuthorizationSearchParamMatcher.Match> results = new LinkedHashMap<>();
        results.put("_security", match(matcher, "Observation?_security=http://example.test/security|normal", observation));
        results.put("_security:not", match(matcher, "Observation?_security:not=http://example.test/security|restricted", observation));
        results.put("identifier", match(matcher, "Patient?identifier=http://example.test/mrn|123", patient));
        results.put("status", match(matcher, "Observation?status=final", observation));
        results.put("reference", match(matcher, "Observation?subject=Patient/p1", observation));
        results.put("date-prefix", match(matcher, "Observation?date=ge2026-01-01", observation));
        results.put("chained", match(matcher, "Observation?subject.identifier=123", observation));
        results.put("_has", match(matcher, "Observation?_has:Provenance:target:agent=Practitioner/1", observation));
        results.put("_filter", match(matcher, "Observation?_filter=status eq final", observation));
        results.put("_lastUpdated", match(matcher, "Observation?_lastUpdated=ge2026-01-01", observation));
        results.put("composite", match(matcher, "Observation?code-value-quantity=http://loinc.org|718-7$5|mg", observation));
        results.put("modifier", match(matcher, "Observation?status:missing=false", observation));

        for (String supported : new String[]{"_security", "_security:not", "identifier", "status", "reference", "date-prefix"}) {
            if (results.get(supported) != IAuthorizationSearchParamMatcher.Match.MATCH) {
                throw new IllegalStateException("Pinned HAPI matcher failed required probe: " + supported);
            }
        }
        for (String deferred : new String[]{"chained", "_has", "_filter", "_lastUpdated", "composite", "modifier"}) {
            if (results.get(deferred) == IAuthorizationSearchParamMatcher.Match.MATCH) {
                throw new IllegalStateException("Deferred matcher expression unexpectedly matched: " + deferred);
            }
        }
        return Map.copyOf(results);
    }

    private static IAuthorizationSearchParamMatcher.Match match(
            AuthorizationSearchParamMatcher matcher, String expression,
            org.hl7.fhir.instance.model.api.IBaseResource resource) {
        try {
            return matcher.match(expression, resource).match;
        } catch (RuntimeException unsupportedSyntax) {
            // Some syntactically invalid deferred forms are rejected before
            // AuthorizationSearchParamMatcher can adapt them to UNSUPPORTED.
            return IAuthorizationSearchParamMatcher.Match.UNSUPPORTED;
        }
    }
}
