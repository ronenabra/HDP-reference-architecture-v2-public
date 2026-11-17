package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import java.util.Set;
import java.util.TreeSet;

/** Closed single-patient operation admission, separate from per-resource Consent authority. */
final class PcmEverythingPolicy {
    static final String ATTRIBUTE = PcmEverythingPolicy.class.getName();
    record Target(String patient, Set<String> types) { }
    private PcmEverythingPolicy() { }

    /** Admit exactly the two authored GET routes, never a generic dollar-operation allowance. */
    static boolean isPath(String path) {
        return path != null && path.matches("Patient/(?:[A-Za-z0-9.-]{1,64}/)?\\$everything");
    }

    /** Continuation metadata is server-authored and remains bound to the complete original query. */
    static boolean retained(String query) {
        return query != null && query.split("\\?", 2)[0].endsWith("/$everything");
    }

    /** Normalize only after the original signature/request binding has been checked. */
    static Target prepare(RequestDetails request, PcmRequestContext context, String originalQuery) {
        if (context.kind() != PcmRequestContext.Kind.DATA_SOURCE_ACCESS) throw denied();
        String patient = context.targetPatientId();
        if (patient == null || !patient.matches("[A-Za-z0-9.-]{1,64}")) throw denied();
        String path = java.net.URI.create(originalQuery).getPath().replaceFirst("^.*/fhir/", "");
        if (!isPath(path)) throw denied();
        String[] segments = path.split("/");
        if (segments.length == 3 && !segments[1].equals(patient)) throw denied();
        var types = new TreeSet<String>();
        context.readGrants().stream().filter(grant -> grant.interactions().contains('s'))
                .map(PcmReadGrant::resourceType).forEach(types::add);
        types.retainAll(PcmSmartScopeParser.declaredResourceTypes());
        String raw = java.net.URI.create(originalQuery).getRawQuery();
        java.util.Map<String, String> controls = new java.util.HashMap<>();
        if (raw != null) for (String control : raw.split("&", -1)) {
            String[] pair = control.split("=", 2);
            String name = java.net.URLDecoder.decode(pair[0], java.nio.charset.StandardCharsets.UTF_8);
            if (!Set.of("_type", "_count").contains(name) || pair.length != 2 || controls.containsKey(name)) throw invalid();
            controls.put(name, java.net.URLDecoder.decode(pair[1], java.nio.charset.StandardCharsets.UTF_8));
        }
        String requested = controls.get("_type");
        if (requested != null) {
            if (!requested.matches("[A-Z][A-Za-z0-9]*(,[A-Z][A-Za-z0-9]*)*")) throw invalid();
            types.retainAll(new java.util.HashSet<>(java.util.Arrays.asList(requested.split(","))));
        }
        if (types.isEmpty()) throw denied();
        Target target = new Target(patient, Set.copyOf(types));
        request.getUserData().put(ATTRIBUTE, target);
        return target;
    }

    /** True only after verified target/type admission has installed the private marker. */
    static Target target(RequestDetails request) {
        return request.getUserData().get(ATTRIBUTE) instanceof Target value ? value : null;
    }
    private static ForbiddenOperationException denied() { return new ForbiddenOperationException("PCM Patient operation denied"); }
    private static InvalidRequestException invalid() { return new InvalidRequestException("PCM Patient operation parameters are invalid"); }
}
