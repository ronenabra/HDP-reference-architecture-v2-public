package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.ResourceGoneException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Bounded, expiring metadata binds HAPI's own persisted search to independently rechecked authority. */
final class PcmPageState {
    static final int MAX_SEARCHES = 128;
    static final long TTL_MILLIS = 300_000;
    record Search(String nativeId, String type, int count, String authority, String policy, String query, Map<String, java.util.List<String>> predicates, long created, Integer total, long generation) { }
    record Continuation(Search search, int offset) { }
    private final Map<String, Search> searches = new LinkedHashMap<>();
    private final byte[] secret = new byte[32];
    private final Clock clock;

    /** New process state intentionally invalidates cursors across restart. */
    PcmPageState() { this(Clock.systemUTC()); }
    /** Inject time for expiry and eviction tests without waiting. */
    PcmPageState(Clock clock) { this.clock = clock; new java.security.SecureRandom().nextBytes(secret); }

    /** Store metadata only; native search membership and resource bodies remain HAPI-owned. */
    synchronized Search create(String nativeId, String type, int count, PcmRequestContext context, String query) {
        return create(nativeId, type, count, context, query, "");
    }

    /** Also bind the verified policy revision; fresh tokens after a source-policy switch cannot inherit old state. */
    synchronized Search create(String nativeId, String type, int count, PcmRequestContext context, String query, String policy) {
        return create(nativeId, type, count, context, query, policy, null, 0);
    }

    /** Retain only server-produced exact provenance alongside existing bounded search metadata. */
    synchronized Search create(String nativeId, String type, int count, PcmRequestContext context, String query,
            String policy, Integer total, long generation) {
        return create(nativeId, type, count, context, query, policy, total, generation, PcmQueryLimits.DEFAULTS);
    }

    /** Apply captured capacity and fixed lifetime before creating this request's metadata. */
    synchronized Search create(String nativeId, String type, int count, PcmRequestContext context, String query,
            String policy, Integer total, long generation, PcmQueryLimits limits) {
        return create(nativeId, type, count, context, query, policy, total, generation, limits, Map.of());
    }

    /** Retain HAPI-parsed client conjunctions separately from the exact public URL, including POST forms. */
    synchronized Search create(String nativeId, String type, int count, PcmRequestContext context, String query,
            String policy, Integer total, long generation, PcmQueryLimits limits, Map<String, String[]> parameters) {
        if (total != null && total < 0) throw new IllegalArgumentException("Negative exact total");
        cleanup(limits);
        while (searches.size() >= limits.maxRetainedSearches()) searches.remove(searches.keySet().iterator().next());
        Search state = new Search(nativeId, type, count, authority(context), policy, query, snapshot(parameters), clock.millis(), total, generation);
        searches.put(nativeId, state);
        return state;
    }

    /** Defensive immutable values prevent caller mutation from changing retained native revalidation. */
    private static Map<String, java.util.List<String>> snapshot(Map<String, String[]> parameters) {
        var result = new LinkedHashMap<String, java.util.List<String>>();
        PcmCountRequestPolicy.predicates(parameters).forEach((name, values) -> {
            if (!"_elements".equals(name)) result.put(name, java.util.List.copyOf(values));
        });
        return java.util.Collections.unmodifiableMap(result);
    }

    /** A cursor has no bearer authority: verify its MAC, bounded position and current effective grant. */
    synchronized Continuation resolve(String cursor, PcmRequestContext context) {
        return resolve(cursor, context, "");
    }

    /** Recheck current signed policy as well as grant equivalence. */
    synchronized Continuation resolve(String cursor, PcmRequestContext context, String policy) {
        return resolve(cursor, context, policy, PcmQueryLimits.DEFAULTS);
    }

    /** Lowered limits can expire/evict old cursors; later increases never restore removed metadata. */
    synchronized Continuation resolve(String cursor, PcmRequestContext context, String policy, PcmQueryLimits limits) {
        cleanup(limits);
        String[] parts = cursor == null ? new String[0] : cursor.split("\\.", -1);
        if (parts.length != 3 || !parts[0].matches("[a-f0-9-]{36}") || !parts[1].matches("[0-9]{1,9}")) throw denied();
        String payload = parts[0] + "." + parts[1];
        if (!MessageDigest.isEqual(mac(payload).getBytes(StandardCharsets.US_ASCII), parts[2].getBytes(StandardCharsets.US_ASCII))) throw denied();
        Search search = searches.get(parts[0]);
        if (search == null) throw new ResourceGoneException("PCM page state expired; start a new search");
        if (!search.authority.equals(authority(context)) || !search.policy.equals(policy)) throw denied();
        return new Continuation(search, Integer.parseInt(parts[1]));
    }

    /** Authenticate exact candidate position without storing one metadata row per page. */
    String cursor(Search search, int offset) {
        if (offset < 0) throw denied();
        String payload = search.nativeId + "." + offset;
        return payload + "." + mac(payload);
    }

    /** Fresh identical grants and duplicate/reordered alternatives have the same authority. */
    static String authority(PcmRequestContext context) {
        var grants = context.readGrants().stream().map(grant -> grant.resourceType() + "|" + grant.patientId() + "|"
                + grant.masterRead() + "|" + grant.interactions().stream().sorted().toList() + "|" + normalize(grant.filter())).distinct().sorted().toList();
        return context.healthOrganization() + "|" + context.subject() + "|" + context.kind() + "|"
                + context.patientIdentifier() + "|" + context.targetPatientId() + "|" + grants;
    }

    /** Preserve conjunctions while ignoring lexical order in independently compiled scope predicates. */
    private static String normalize(String filter) {
        if (filter == null || filter.isBlank()) return "";
        return java.util.Arrays.stream(filter.split("&", -1)).sorted().toList().toString();
    }

    /** Eager on-access cleanup is bounded by the fixed search capacity. */
    private void cleanup(PcmQueryLimits limits) {
        searches.values().removeIf(search -> clock.millis() - search.created >= limits.searchTtlMilliseconds());
        while (searches.size() > limits.maxRetainedSearches()) searches.remove(searches.keySet().iterator().next());
    }
    /** Calculate a process-private cursor authenticator without exposing native DAO identifiers. */
    private String mac(String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(payload.getBytes(StandardCharsets.US_ASCII)));
        } catch (java.security.GeneralSecurityException unavailable) { throw new IllegalStateException(unavailable); }
    }
    /** Return identifier-free denial for tampering or authority changes. */
    private static ForbiddenOperationException denied() { return new ForbiddenOperationException("PCM continuation denied"); }
}
