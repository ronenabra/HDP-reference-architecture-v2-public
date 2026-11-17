package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** Exact current-search surface for authentication and dependent discovery grants. */
public final class PcmSystemSearchPolicy {
    private PcmSystemSearchPolicy() { }

    /** Check the identity predicate and bounded projection before native search execution. */
    public static void validate(PcmRequestContext context, String resource, Map<String, String[]> parameters) {
        boolean authentication = context.kind() == PcmRequestContext.Kind.PATIENT_AUTHENTICATION;
        if (!authentication && context.kind() != PcmRequestContext.Kind.DEPENDENT_DISCOVERY) throw denied();
        if (!"Patient".equals(resource) && (authentication || !"RelatedPerson".equals(resource))) throw denied();
        String predicate = !authentication && "Patient".equals(resource)
                ? "_has:RelatedPerson:patient:identifier" : "identifier";
        PcmPatientIdentifier identifier = authentication ? context.patientIdentifier() : context.representativeIdentifier();
        if (identifier == null || !identifier.token().equals(single(parameters, predicate))) throw denied();
        Set<String> projection = authentication ? Set.of("identifier", "name", "telecom", "birthDate")
                : "Patient".equals(resource) ? Set.of("identifier", "name")
                : Set.of("identifier", "patient", "active", "relationship");
        for (String name : parameters.keySet()) {
            String value = single(parameters, name);
            if (name.equals(predicate)) continue;
            if ("_elements".equals(name)) {
                String[] elements = value.split(",", -1);
                if (elements.length == 0 || new HashSet<>(Arrays.asList(elements)).size() != elements.length
                        || !projection.containsAll(Arrays.asList(elements))) throw denied();
            } else if ("_count".equals(name)) {
                if (!value.matches("[1-9][0-9]?|100")) throw denied();
            } else throw denied();
        }
    }

    /** Decode one relative batch URL without allowing repeated or encoded path components. */
    public static void validateUrl(PcmRequestContext context, String url) {
        ParsedUrl parsed = parseUrl(url);
        validate(context, parsed.resource(), parsed.parameters());
    }

    /** Validate only query shape in explicitly unfiltered synthetic mode, not identity assurance. */
    public static PcmPatientIdentifier validateUnfilteredDiscoveryUrl(String url) {
        ParsedUrl parsed = parseUrl(url);
        String predicate = "Patient".equals(parsed.resource()) ? "_has:RelatedPerson:patient:identifier" : "identifier";
        String[] parts = single(parsed.parameters(), predicate).split("\\|", -1);
        if (parts.length != 2 || parts[0].isBlank() || parts[1].isBlank()
                || parts[0].contains(",") || parts[1].contains(",")) throw denied();
        PcmPatientIdentifier requested = new PcmPatientIdentifier(parts[0], parts[1]);
        // This temporary value reuses the strict read-only shape validator. It
        // never replaces the verified request context or grants a workflow role.
        PcmRequestContext shape = new PcmRequestContext("synthetic", "synthetic-query-shape", java.util.List.of(),
                PcmRequestContext.Kind.DEPENDENT_DISCOVERY, null, java.util.List.of(), null, false, requested);
        validate(shape, parsed.resource(), parsed.parameters());
        return requested;
    }

    /** Decode one bounded relative search URL, rejecting duplicate parameters. */
    private static ParsedUrl parseUrl(String url) {
        if (url == null || url.length() > 8192) throw denied();
        int separator = url.indexOf('?');
        if (separator < 0 || url.indexOf('#') >= 0) throw denied();
        String resource = url.substring(0, separator);
        Map<String, String[]> parameters = new java.util.LinkedHashMap<>();
        for (String pair : url.substring(separator + 1).split("&", -1)) {
            int equals = pair.indexOf('=');
            if (equals < 1) throw denied();
            String name = java.net.URLDecoder.decode(pair.substring(0, equals), java.nio.charset.StandardCharsets.UTF_8);
            String value = java.net.URLDecoder.decode(pair.substring(equals + 1), java.nio.charset.StandardCharsets.UTF_8);
            if (parameters.putIfAbsent(name, new String[]{value}) != null) throw denied();
        }
        return new ParsedUrl(resource, parameters);
    }

    private record ParsedUrl(String resource, Map<String, String[]> parameters) { }

    private static String single(Map<String, String[]> parameters, String name) {
        String[] values = parameters.get(name);
        if (values == null || values.length != 1 || values[0] == null || values[0].isBlank()) throw denied();
        return values[0];
    }

    private static ForbiddenOperationException denied() {
        return new ForbiddenOperationException("PCM policy denied the request");
    }
}
