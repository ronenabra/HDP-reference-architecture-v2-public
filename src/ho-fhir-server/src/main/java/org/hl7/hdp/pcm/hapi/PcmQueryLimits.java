package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.JsonNode;
import ca.uhn.fhir.rest.api.server.RequestDetails;

/** Immutable operational snapshot derived from the source policy's existing parsed document. */
public record PcmQueryLimits(long maxAllocatedBytes,
        int timeoutMilliseconds,
        int maxConcurrentQueries,
        int maxPageIdVisits,
        int maxPageBodyVisits,
        int maxPageRefills,
        int maxPageIncludes,
        int maxPagePayloadBytes,
        int maxCountCandidates,
        int maxCountNativeIdVisits,
        int maxRetainedSearches,
        int searchTtlMilliseconds,
        int maxQueryUriCharacters,
        int maxPrivateAuthorizationBytes, String revision) {
    static final String ATTRIBUTE = PcmQueryLimits.class.getName();
    static final PcmQueryLimits DEFAULTS = new PcmQueryLimits(268435456L, 10000, 2, 5000, 5000, 32, 100, 2097152, 100000, 2000000, 128, 300000, 8192, 57344, "0");
    private static final java.util.Map<String, long[]> BOUNDS = java.util.Map.ofEntries(
        java.util.Map.entry("maxAllocatedBytes", new long[]{1L, 8589934592L}),
        java.util.Map.entry("timeoutMilliseconds", new long[]{1001L, 300000L}),
        java.util.Map.entry("maxConcurrentQueries", new long[]{1L, 32L}),
        java.util.Map.entry("maxPageIdVisits", new long[]{1L, 1000000L}),
        java.util.Map.entry("maxPageBodyVisits", new long[]{1L, 1000000L}),
        java.util.Map.entry("maxPageRefills", new long[]{1L, 1024L}),
        java.util.Map.entry("maxPageIncludes", new long[]{1L, 10000L}),
        java.util.Map.entry("maxPagePayloadBytes", new long[]{1L, 16777216L}),
        java.util.Map.entry("maxCountCandidates", new long[]{1L, 1000000L}),
        java.util.Map.entry("maxCountNativeIdVisits", new long[]{1L, 20000000L}),
        java.util.Map.entry("maxRetainedSearches", new long[]{1L, 4096L}),
        java.util.Map.entry("searchTtlMilliseconds", new long[]{1L, 3600000L}),
        java.util.Map.entry("maxQueryUriCharacters", new long[]{1L, 8192L}),
        java.util.Map.entry("maxPrivateAuthorizationBytes", new long[]{1L, 57344L}));

    /** Production requests install this once during JWT verification; fixture requests retain defaults. */
    static PcmQueryLimits from(RequestDetails request) {
        Object value = request.getUserData().get(ATTRIBUTE);
        return value instanceof PcmQueryLimits limits ? limits : DEFAULTS;
    }

    /** Validate all rows, then overlay only the immutable registered HO identity. No I/O occurs here. */
    static PcmQueryLimits parse(JsonNode config, String hoId) {
        JsonNode offset = config.path("runtime").path("queryLimitsRevisionOffset");
        if (!offset.isMissingNode() && (!offset.isIntegralNumber() || !offset.canConvertToLong()
                || offset.longValue() < 0 || offset.longValue() > config.path("runtime").path("revision").asLong(0))) throw new SecurityException("Invalid query limits revision offset");
        JsonNode block = config.path("clinicalQuery");
        java.util.Map<String, Long> values = new java.util.HashMap<>();
        if (!block.isMissingNode()) {
            if (!block.isObject()) throw new SecurityException("Invalid clinicalQuery block");
            block.fieldNames().forEachRemaining(key -> { if (!java.util.Set.of("defaults", "sources").contains(key)) throw new SecurityException("Unknown clinicalQuery field"); });
            row(block.path("defaults"), values);
            JsonNode sources = block.path("sources");
            if (!sources.isMissingNode() && !sources.isObject()) throw new SecurityException("Invalid clinical query sources");
            java.util.Set<String> registered = new java.util.HashSet<>();
            config.path("healthOrganizations").forEach(source -> registered.add(source.path("id").asText()));
            sources.fields().forEachRemaining(entry -> {
                if (!registered.contains(entry.getKey())) throw new SecurityException("Unknown managed clinical query source");
                row(entry.getValue(), new java.util.HashMap<>());
            });
            row(sources.path(hoId), values);
        }
        return new PcmQueryLimits(
                values.getOrDefault("maxAllocatedBytes", 268435456L),
                Math.toIntExact(values.getOrDefault("timeoutMilliseconds", 10000L)),
                Math.toIntExact(values.getOrDefault("maxConcurrentQueries", 2L)),
                Math.toIntExact(values.getOrDefault("maxPageIdVisits", 5000L)),
                Math.toIntExact(values.getOrDefault("maxPageBodyVisits", 5000L)),
                Math.toIntExact(values.getOrDefault("maxPageRefills", 32L)),
                Math.toIntExact(values.getOrDefault("maxPageIncludes", 100L)),
                Math.toIntExact(values.getOrDefault("maxPagePayloadBytes", 2097152L)),
                Math.toIntExact(values.getOrDefault("maxCountCandidates", 100000L)),
                Math.toIntExact(values.getOrDefault("maxCountNativeIdVisits", 2000000L)),
                Math.toIntExact(values.getOrDefault("maxRetainedSearches", 128L)),
                Math.toIntExact(values.getOrDefault("searchTtlMilliseconds", 300000L)),
                Math.toIntExact(values.getOrDefault("maxQueryUriCharacters", 8192L)),
                Math.toIntExact(values.getOrDefault("maxPrivateAuthorizationBytes", 57344L)), config.path("runtime").path("revision").asText("0"));
    }

    /** Reject fractional, unrecognized and out-of-range raw units instead of silently coercing. */
    private static void row(JsonNode row, java.util.Map<String, Long> values) {
        if (row.isMissingNode()) return;
        if (!row.isObject()) throw new SecurityException("Invalid clinical query limits row");
        row.fields().forEachRemaining(entry -> {
            long[] bounds = BOUNDS.get(entry.getKey()); JsonNode value = entry.getValue();
            if (bounds == null || !value.isIntegralNumber() || !value.canConvertToLong()
                    || value.longValue() < bounds[0] || value.longValue() > bounds[1]) throw new SecurityException("Invalid finite clinical query limit " + entry.getKey());
            values.put(entry.getKey(), value.longValue());
        });
    }

    /** One shared measured work deadline includes COUNT nested inside an accurate PAGE. */
    static long deadline(RequestDetails request, java.time.Instant expiry) {
        String key = ATTRIBUTE + ".deadline";
        var data = request.getUserData();
        synchronized (data) {
            if (data.get(key) instanceof Deadline captured) return captured.ends;
            long configured = from(request).timeoutMilliseconds();
            long authority = expiry.toEpochMilli() - System.currentTimeMillis();
            long effective = Math.max(0, Math.min(configured, authority) - 1000);
            Deadline captured = new Deadline(System.nanoTime(), effective, authority >= configured);
            data.put(key, captured);
            PcmBudgetFailure.capture(request);
            return captured.ends;
        }
    }

    /** At the actual deadline boundary report elapsed work, distinguishing earlier authority expiry. */
    static void timedOut(RequestDetails request) { timedOut(request, "async-deadline"); }

    /** The actual timer/worker owner stays explicit even when PAGE encloses exact COUNT. */
    static void timedOut(RequestDetails request, String stage) {
        Object value = request.getUserData().get(ATTRIBUTE + ".deadline");
        if (value instanceof Deadline captured && captured.queryLimited) {
            var state = PcmRuntimeObservability.state(request);
            if (state != null) state.fields.put("executionDeadline", java.util.Map.of(
                    "effectiveThreshold", captured.effectiveMillis, "unit", "milliseconds", "reason", "completion-reserve"));
            exceeded(request, stage, "timeoutMilliseconds", from(request).timeoutMilliseconds(),
                    java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - captured.started));
        }
    }

    /** Existing connection observation also enforces COUNT's shared effective work deadline. */
    static boolean deadlineReached(RequestDetails request) {
        Object value = request.getUserData().get(ATTRIBUTE + ".deadline");
        return value instanceof Deadline captured && System.nanoTime() >= captured.ends;
    }

    /** Configured duration and the tighter work reserve are separate facts, never nominal observations. */
    private static final class Deadline {
        final long started, ends, effectiveMillis;
        final boolean queryLimited;
        Deadline(long started, long effectiveMillis, boolean queryLimited) {
            this.started = started; this.effectiveMillis = effectiveMillis; this.queryLimited = queryLimited;
            ends = started + effectiveMillis * 1_000_000;
        }
    }

    /** Capture before logging; a diagnostic failure must never alter clinical completion. */
    static void exceeded(RequestDetails request, String setting, long threshold, long observed) {
        exceeded(request, "query-limit", setting, threshold, observed);
    }

    /** Keep the first measured execution stage beside its immutable cause. */
    static void exceeded(RequestDetails request, String stage, String setting, long threshold, long observed) {
        if (!java.util.Set.of("query-limit", "page", "count", "query-admission", "async-deadline").contains(stage))
            throw new IllegalArgumentException("Unknown query budget owner");
        PcmBudgetFailure cause = PcmBudgetFailure.of(setting, threshold, observed);
        PcmBudgetFailure.Capture capture = PcmBudgetFailure.capture(request);
        if (capture != null) capture.retain(cause, stage);
        try (var requestContext = PcmRuntimeObservability.attach(request)) {
            org.slf4j.LoggerFactory.getLogger(PcmQueryLimits.class).warn(PcmBudgetFailure.WARNING, cause);
        }
        catch (RuntimeException unavailable) { /* Captured cause and enforcement survive unavailable logging. */ }
    }
}
