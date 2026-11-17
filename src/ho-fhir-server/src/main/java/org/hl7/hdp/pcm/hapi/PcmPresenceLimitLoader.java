package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;

/** Loads required Data Source-local presence limits from the mounted team config. */
public final class PcmPresenceLimitLoader {
    private PcmPresenceLimitLoader() {
    }

    public static PcmPresenceLimits load(Path path, ObjectMapper mapper) {
        return load(path, mapper, System.getenv().getOrDefault("HO_ID", ""));
    }

    /** Select by immutable local HO identity and overlay its current explicit budgets. */
    public static PcmPresenceLimits load(Path path, ObjectMapper mapper, String hoId) {
        try {
            if (!Files.isRegularFile(path)) throw new IllegalStateException("Team config is missing");
            JsonNode presence = mapper.readTree(path.toFile()).path("presence");
            JsonNode batch = presence.path("batch");
            java.util.Set<String> controls = java.util.Set.of("maxPatients", "maxPayloadBytes", "timeoutMilliseconds", "maxRarBytes", "maxFormBytes", "maxEncodedFormBytes", "maxResponseBytes");
            if (!batch.isObject() || batch.size() < 3 || !controls.containsAll(java.util.stream.StreamSupport.stream(
                    ((Iterable<String>) () -> batch.fieldNames()).spliterator(), false).toList())) {
                throw new IllegalStateException("presence.batch config requires exactly three controls");
            }
            JsonNode override = presence.path("sources").path(hoId);
            return new PcmPresenceLimits(
                    requiredInt(override.has("maxPatients") ? override : batch, "maxPatients"),
                    requiredInt(override.has("maxPayloadBytes") ? override : batch, "maxPayloadBytes"),
                    requiredInt(override.has("timeoutMilliseconds") ? override : batch, "timeoutMilliseconds"));
        } catch (RuntimeException rejected) {
            throw rejected;
        } catch (Exception rejected) {
            throw new IllegalStateException("Unable to load presence operational limits", rejected);
        }
    }

    private static int requiredInt(JsonNode node, String name) {
        JsonNode value = node.get(name);
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()) {
            throw new IllegalStateException(name + " is required as an integer");
        }
        return value.intValue();
    }
}
