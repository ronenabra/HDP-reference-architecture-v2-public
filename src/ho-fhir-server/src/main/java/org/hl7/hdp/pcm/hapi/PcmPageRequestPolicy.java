package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import java.util.Map;

/** Closed ordinary-search page controls; zero remains the separate exact-count path. */
final class PcmPageRequestPolicy {
    static final int DEFAULT_COUNT = 20;
    static final int MAX_COUNT = 100;
    private PcmPageRequestPolicy() { }

    /** Totals are explicit: estimates, unknown modes and duplicate controls fail closed. */
    static boolean accurate(Map<String, String[]> parameters) {
        String[] values = parameters.get("_total");
        if (values == null) return false;
        if (values.length != 1 || values[0] == null || !java.util.Set.of("none", "accurate").contains(values[0])) {
            throw new InvalidRequestException("PCM total mode is invalid");
        }
        return "accurate".equals(values[0]);
    }

    /** Validate before normalization and cap positive requests without integer overflow. */
    static int count(Map<String, String[]> parameters) {
        String[] values = parameters.get("_count");
        if (values == null) return DEFAULT_COUNT;
        if (values.length != 1 || values[0] == null || !values[0].matches("[1-9][0-9]{0,8}")) {
            throw new InvalidRequestException("PCM page controls are invalid");
        }
        return Math.min(MAX_COUNT, Integer.parseInt(values[0]));
    }
}
