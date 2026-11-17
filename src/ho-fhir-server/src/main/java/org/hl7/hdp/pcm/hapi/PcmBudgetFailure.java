package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import java.util.Map;

/** Exact bounded operational cause, captured before diagnostic logging at its measuring owner. */
record PcmBudgetFailure(String setting, long threshold, long observed, String unit) {
    static final String REASON = "QUERY_BUDGET_EXCEEDED";
    static final String WARNING = "PCM query budget exceeded: {}";
    private static final String ATTRIBUTE = PcmBudgetFailure.class.getName();
    private static final Map<String, String> UNITS = Map.ofEntries(
            Map.entry("maxAllocatedBytes", "bytes"), Map.entry("timeoutMilliseconds", "milliseconds"),
            Map.entry("maxConcurrentQueries", "active queries"), Map.entry("maxPageIdVisits", "visits"),
            Map.entry("maxPageBodyVisits", "visits"), Map.entry("maxPageRefills", "refills"),
            Map.entry("maxPageIncludes", "entries"), Map.entry("maxPagePayloadBytes", "bytes"),
            Map.entry("maxCountCandidates", "candidates"), Map.entry("maxCountNativeIdVisits", "visits"),
            Map.entry("maxQueryUriCharacters", "characters"));

    PcmBudgetFailure {
        if (!UNITS.containsKey(setting) || !UNITS.get(setting).equals(unit) || threshold < 1 || observed < 0)
            throw new IllegalArgumentException("Invalid finite budget cause");
    }

    /** Canonical units cannot be supplied by a caller, exception message or log argument. */
    static PcmBudgetFailure of(String setting, long threshold, long observed) {
        return new PcmBudgetFailure(setting, threshold, observed, UNITS.get(setting));
    }

    /** One formatter supplies both native warning and terminal event messages without sensitive inputs. */
    String message() { return setting + " limit=" + threshold + " " + unit + " observed=" + observed + " " + unit; }

    @Override public String toString() { return message(); }

    /** Keep long values numeric through the bounded JSON encoder. */
    Map<String, Object> fields() { return Map.of("setting", setting, "threshold", threshold, "observed", observed, "unit", unit); }

    /** Resolve explicit request ownership before work is submitted; servlet state survives async completion. */
    static Capture capture(RequestDetails request) {
        if (request == null) return null;
        var state = PcmRuntimeObservability.state(request);
        if (state != null) return state.budget;
        var data = request.getUserData();
        synchronized (data) { return (Capture) data.computeIfAbsent(ATTRIBUTE, key -> new Capture()); }
    }

    /** A single synchronized publication/closure boundary retains the first cause and rejects late timers. */
    static final class Capture {
        private PcmBudgetFailure first;
        private boolean closed;
        private String stage;
        synchronized void retain(PcmBudgetFailure cause, String owner) {
            if (!closed && first == null) { first = cause; stage = owner; }
        }
        synchronized String stage() { return stage; }
        synchronized void seal() { closed = true; }
        synchronized PcmBudgetFailure first() { return first; }
        synchronized PcmBudgetFailure finish() { closed = true; var result = first; first = null; stage = null; return result; }
    }
}
