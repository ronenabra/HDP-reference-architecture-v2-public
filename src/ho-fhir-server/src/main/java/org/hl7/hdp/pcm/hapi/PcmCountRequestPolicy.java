package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Validates explicit exact-count controls without changing client search conjunctions. */
public final class PcmCountRequestPolicy {
    private static final Set<String> OMIT = Set.of("_summary", "_count", "_total", "_include", "_revinclude", "_sort", "_format", "_pretty");

    private PcmCountRequestPolicy() { }

    /** Return whether either count spelling is present; ambiguous controls fail closed. */
    static boolean isCount(Map<String, String[]> parameters) {
        String summary = control(parameters, "_summary");
        String count = control(parameters, "_count");
        String total = control(parameters, "_total");
        if (count != null && !count.matches("0|[1-9][0-9]{0,8}")) throw invalid();
        if (summary != null && !Set.of("count", "true", "false", "text", "data").contains(summary)) throw invalid();
        boolean result = "count".equals(summary) || "0".equals(count);
        if (result && (total != null && !"accurate".equals(total)
                || "0".equals(count) && summary != null && !"count".equals(summary))) throw invalid();
        return result;
    }

    /** Preserve repeated search values as separate AND terms for HAPI's native parser. */
    static Map<String, List<String>> predicates(Map<String, String[]> parameters) {
        Map<String, List<String>> result = new LinkedHashMap<>();
        parameters.forEach((name, values) -> {
            if (!OMIT.contains(name)) result.put(name, List.of(values));
        });
        return result;
    }

    /** Read exactly one nonempty control value, rejecting duplicate spellings. */
    private static String control(Map<String, String[]> parameters, String name) {
        String[] values = parameters.get(name);
        if (values == null) return null;
        if (values.length != 1 || values[0] == null || values[0].isBlank()) throw invalid();
        return values[0];
    }

    /** Produce an identifier-free 400 outcome for ambiguous count semantics. */
    private static InvalidRequestException invalid() {
        return new InvalidRequestException("PCM exact count controls are invalid");
    }
}
