package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;

/** Request-time policy stamp shared with the adapter; the public token contract is unchanged. */
public record PcmSimulationPolicy(String stamp, boolean nativeFiltering, boolean sandboxSampling,
        boolean transportSimulation, boolean signatureSimulation, boolean anonymousSimulation, PcmQueryLimits queryLimits) {
    /** Explicit fixture policies preserve existing operational defaults. */
    public PcmSimulationPolicy(String stamp, boolean nativeFiltering, boolean sandboxSampling,
            boolean transportSimulation, boolean signatureSimulation, boolean anonymousSimulation) {
        this(stamp, nativeFiltering, sandboxSampling, transportSimulation, signatureSimulation, anonymousSimulation, PcmQueryLimits.DEFAULTS);
    }
    /** Existing contexts grant no authentication simulation without explicit policy. */
    public PcmSimulationPolicy(String stamp, boolean nativeFiltering, boolean sandboxSampling) {
        this(stamp, nativeFiltering, sandboxSampling, false, false, false);
    }
    /** Existing test contexts admit no local sampler implicitly. */
    public PcmSimulationPolicy(String stamp, boolean nativeFiltering) { this(stamp, nativeFiltering, false); }
    private static final List<String> SIMULATIONS = List.of(
            "publicClientMtls", "serverCertificateVerification", "clientAssertionSignature",
            "clientAssertionAudience", "clientAssertionReplay", "clientAssertionExpiry");
    private static final List<String> REQUIRED = List.of(
            "oauthBearer", "tokenResourceBinding", "tokenAudience", "tokenExpiry",
            "consentState", "serviceState", "patientIdentifier", "patientMapping",
            "smartScopes", "smartInteractions", "smartQueryFilters", "informationBucket",
            "sensitivityLabels", "history", "references", "includes", "paging",
            "resultFiltering", "presenceAuthorization");

    /** Read the mounted effective source controls on every request, including runtime tightening. */
    public static PcmSimulationPolicy load(Path path, String hoId) {
        try {
            JsonNode config = new ObjectMapper().readTree(path.toFile());
            if (!"pcm-team-config/5".equals(config.path("configVersion").asText())
                    || !"pcm-sandbox-policy/4".equals(config.path("conformance").path("policyVersion").asText())
                    || config.path("sandbox").has("grantFullClinicalAccess")
                    || !config.path("security").path("dsFhirServer").path("enforceMappedPatients").asBoolean()) {
                throw new SecurityException("Incompatible source configuration; coordinated scope migration required");
            }
            for (JsonNode overrides : List.of(config.path("securitySimulation").path("global"),
                    config.path("securitySimulation").path("perSource").path(hoId))) {
                overrides.fieldNames().forEachRemaining(name -> {
                    if (!SIMULATIONS.contains(name) || !overrides.path(name).isBoolean())
                        throw new SecurityException("Retired or invalid source simulation control: " + name);
                });
            }
            String preset = config.path("conformance").path("preset").asText("connectathon-easy");
            boolean enabled = !preset.equals("connectathon-easy");
            boolean signature = enabled;
            StringBuilder bits = new StringBuilder();
            for (String control : SIMULATIONS) {
                boolean value = enabled && !(preset.equals("connectathon-balanced") && control.equals("publicClientMtls"));
                JsonNode global = config.path("securitySimulation").path("global").path(control);
                JsonNode local = config.path("securitySimulation").path("perSource").path(hoId).path(control);
                if (global.isBoolean()) value = global.asBoolean();
                if (local.isBoolean()) value = local.asBoolean();
                bits.append(value ? '1' : '0');
                if (control.equals("clientAssertionSignature")) signature = value;
            }
            REQUIRED.forEach(name -> bits.append('1'));
            String revision = Long.toString(config.path("runtime").path("revision").asLong(0) - config.path("runtime").path("queryLimitsRevisionOffset").asLong(0));
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(("pcm-sandbox-policy/4:" + hoId + ":" + revision + ":" + bits).getBytes(StandardCharsets.UTF_8));
            boolean nonStrict = config.path("conformance").path("mode").asText().equals("connectathon") && !preset.equals("strict");
            return new PcmSimulationPolicy(HexFormat.of().formatHex(digest), true,
                    config.path("conformance").path("mode").asText().equals("connectathon")
                    && !preset.equals("strict") && config.path("sandboxSampling").isObject()
                    && java.util.stream.StreamSupport.stream(config.path("sandboxSampling").path("sourceIds").spliterator(), false)
                        .anyMatch(value -> hoId.equals(value.asText())),
                    nonStrict && config.path("security").path("pcmApi").path("clientAuth").asText("mtls").equals("tls"),
                    nonStrict && !signature, false, PcmQueryLimits.parse(config, hoId));
        } catch (Exception error) {
            throw new SecurityException("Unable to resolve the current source simulation policy", error);
        }
    }
}
