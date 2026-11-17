package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Exact count-only Patient query parser shared by online and batch presence. */
public final class PcmPresenceRequestPolicy {
    private static final Set<String> EXACT_PARAMETERS = Set.of("identifier", "_summary", "_count");

    private PcmPresenceRequestPolicy() {
    }

    /** Validate a parsed online HAPI request and return its exact identifier. */
    public static PcmPatientIdentifier online(RequestDetails requestDetails) {
        if (!"Patient".equals(requestDetails.getResourceName())) {
            throw new SecurityException("Presence request resource is invalid");
        }
        Map<String, String[]> parameters = requestDetails.getParameters();
        if (!parameters.keySet().equals(EXACT_PARAMETERS)) {
            throw new SecurityException("Presence query shape is invalid");
        }
        return identifier(single(parameters, "identifier"), single(parameters, "_summary"), single(parameters, "_count"));
    }

    /** Validate an entry-relative URL and return its exact identifier. */
    public static PcmPatientIdentifier batchEntry(String value) {
        try {
            URI uri = new URI(value);
            if (uri.isAbsolute() || uri.getFragment() != null || !"Patient".equals(uri.getPath())
                    || uri.getRawQuery() == null) {
                throw new SecurityException("Batch entry URL is invalid");
            }
            Map<String, String> parameters = new LinkedHashMap<>();
            for (String part : uri.getRawQuery().split("&", -1)) {
                int separator = part.indexOf('=');
                if (separator <= 0) throw new SecurityException("Batch entry query is invalid");
                String name = decode(part.substring(0, separator));
                String parameter = decode(part.substring(separator + 1));
                if (parameters.putIfAbsent(name, parameter) != null) {
                    throw new SecurityException("Batch entry query contains duplicates");
                }
            }
            if (!parameters.keySet().equals(EXACT_PARAMETERS)) {
                throw new SecurityException("Batch entry query shape is invalid");
            }
            return identifier(parameters.get("identifier"), parameters.get("_summary"), parameters.get("_count"));
        } catch (SecurityException rejected) {
            throw rejected;
        } catch (Exception rejected) {
            throw new SecurityException("Batch entry URL is invalid", rejected);
        }
    }

    private static String decode(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static String single(Map<String, String[]> parameters, String name) {
        String[] values = parameters.get(name);
        if (values == null || values.length != 1) throw new SecurityException("Presence query shape is invalid");
        return values[0];
    }

    private static PcmPatientIdentifier identifier(String token, String summary, String count) {
        if (!"count".equals(summary) || !"0".equals(count) || token == null) {
            throw new SecurityException("Presence query shape is invalid");
        }
        int separator = token.indexOf('|');
        if (separator <= 0 || separator != token.lastIndexOf('|') || separator == token.length() - 1) {
            throw new SecurityException("Presence identifier is invalid");
        }
        return new PcmPatientIdentifier(token.substring(0, separator), token.substring(separator + 1));
    }
}
