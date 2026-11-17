package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import java.util.LinkedHashMap;
import java.util.Map;

/** Decorate the existing verifier without parsing unverified JWTs or changing its result/exception. */
final class PcmObservedVerifier implements SignedRequestContextVerifier {
    private final SignedRequestContextVerifier delegate;
    private final PcmRuntimeObservability observations;
    private static final String OBSERVED = PcmObservedVerifier.class.getName();
    PcmObservedVerifier(SignedRequestContextVerifier delegate, PcmRuntimeObservability observations) { this.delegate = delegate; this.observations = observations; }
    @Override public PcmRequestContext verify(RequestDetails request) {
        try {
            PcmRequestContext context = delegate.verify(request);
            if (request.getUserData().putIfAbsent(OBSERVED, true) == null) {
                Map<String, Object> facts = new LinkedHashMap<>(); facts.put("kind", context.kind().name()); facts.put("subject", context.subject());
                facts.put("healthOrganizationId", context.healthOrganization()); facts.put("policyFingerprint", request.getUserData().get(LocalJwtRequestContextVerifier.POLICY_ATTRIBUTE));
                facts.put("verifiedBindings", request.getUserData().get(LocalJwtRequestContextVerifier.OBSERVABILITY_ATTRIBUTE));
                facts.put("scopeEnforcement", "evaluated-pass");
                Map<String,Object> checks = new LinkedHashMap<>(); checks.put("localContext", "evaluated-pass");
                Object bindings = request.getUserData().get(LocalJwtRequestContextVerifier.OBSERVABILITY_ATTRIBUTE);
                if (bindings instanceof Map<?,?> verified && verified.get("authentication") instanceof Map<?,?> authentication) {
                    var skipped = authentication.get("simulation") instanceof Map<?,?> simulation && simulation.get("skipped") instanceof java.util.List<?> list ? list : java.util.List.of();
                    checks.put("pcmTokenEndpointMtlsAttestation", skipped.contains("token-endpoint-mtls") ? "bypassed" : "evaluated-pass");
                    checks.put("pcmClientAssertionSignatureAttestation", skipped.contains("client-assertion-signature") ? "bypassed" : "evaluated-pass");
                } else checks.put("authenticationAttestation", "unavailable");
                checks.put("nativeClientCertificateCorrelation", "not-evaluated"); facts.put("checks", checks);
                facts.put("patientIdentifier", context.patientIdentifier() == null ? null : Map.of("system", context.patientIdentifier().system(), "value", context.patientIdentifier().value()));
                facts.put("targetPatientId", context.targetPatientId()); facts.put("importAccess", context.importAccess());
                facts.put("grantCount", context.readGrants().size()); facts.put("grants", context.readGrants().stream().limit(100).map(grant -> {
                    Map<String, Object> value = new LinkedHashMap<>(); value.put("resourceType", grant.resourceType()); value.put("patientId", grant.patientId());
                    value.put("filter", grant.filter()); value.put("interactions", grant.interactions().stream().sorted().map(String::valueOf).toList()); return value;
                }).toList()); facts.put("omittedGrants", Math.max(0, context.readGrants().size() - 100));
                observations.decision(request, "HAPI_CONTEXT_VALIDATION", "pass", "CONTEXT_VALIDATED", facts);
            }
            return context;
        } catch (RuntimeException rejected) {
            if (request.getUserData().putIfAbsent(OBSERVED, true) == null) observations.decision(request, "HAPI_CONTEXT_VALIDATION", "fail", reason(rejected), Map.of("validatedIdentity", false, "checks", Map.of("localContext", "evaluated-fail", "admission", "not-evaluated", "resultFilter", "not-evaluated")));
            throw rejected;
        }
    }
    static String reason(RuntimeException rejected) {
        if (rejected instanceof PcmContextException reason) return reason.reasonCode;
        String message = String.valueOf(rejected.getMessage());
        if (message.contains("Missing adapter")) return "CONTEXT_MISSING";
        if (message.contains("scope") && (message.contains("Unsupported") || message.contains("unsupported"))) return "UNSUPPORTED_SCOPE";
        if (message.contains("signature")) return "CONTEXT_SIGNATURE_INVALID";
        if (message.contains("schema")) return "CONTEXT_SCHEMA_INVALID";
        if (message.contains("stale")) return "CONTEXT_STALE";
        if (message.contains("binding")) return "CONTEXT_BINDING_INVALID";
        if (message.contains("ambiguous")) return "PATIENT_AMBIGUOUS";
        if (message.contains("Patient") && message.contains("mapped")) return "PATIENT_UNMAPPED";
        return "CONTEXT_INVALID";
    }
}
