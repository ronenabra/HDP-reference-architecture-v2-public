package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/** Configured exact workflow identities and explicit synthetic lookup fixtures; no title or FHIR-fetch authority. */
final class PcmWorkflowPolicy {
    static final String DEMOGRAPHICS = "_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics";
    static final String DISCOVERY_TAG = "_tag=http://fhir.health.gov.il/cs/il-hdp-resource-tags|hmo-dependent-discovery";
    static final Map<String, String> DEFAULTS = Map.of(
            "presence-check", "PCM-POLICY-PRESENCE-001",
            "patient-authentication", "PCM-POLICY-PATIENT-AUTHENTICATION-001",
            "dependent-discovery", "PCM-POLICY-DEPENDENT-DISCOVERY-001");

    private PcmWorkflowPolicy() { }

    /** Read the authored team catalog used by PCM provisioning. Missing selected inputs deny. */
    static Map<String, String> load(Path configPath) {
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode config = mapper.readTree(configPath.toFile());
            if (!config.has("serviceCatalog")) return DEFAULTS;
            String relative = config.path("serviceCatalog").path("file").asText();
            Path root = configPath.toRealPath().getParent();
            Path catalog = root.resolve(relative).normalize();
            if (relative.isBlank() || Path.of(relative).isAbsolute() || !catalog.startsWith(root)
                    || !catalog.toRealPath().startsWith(root)) throw new SecurityException("Unsafe workflow catalog");
            Map<String, String> identities = new java.util.HashMap<>(DEFAULTS);
            for (JsonNode policy : mapper.readTree(catalog.toFile()).path("systemPolicies")) {
                String scenario = policy.path("scenario").asText();
                String identifier = policy.path("policyIdentifier").asText();
                if (!DEFAULTS.containsKey(scenario) || identifier.isBlank()) throw new SecurityException("Invalid workflow catalog");
                identities.put(scenario, identifier);
            }
            if (new java.util.HashSet<>(identities.values()).size() != identities.size()) throw new SecurityException("Ambiguous workflow identities");
            return Map.copyOf(identities);
        } catch (Exception rejected) { throw new SecurityException("Unable to resolve configured workflow identities", rejected); }
    }
    /** Load only explicitly enrolled HTEST lookup fixtures; ordinary person login is separate. */
    static java.util.Set<PcmPatientIdentifier> syntheticFixtures(Path configPath) {
        try {
            JsonNode settings = new ObjectMapper().readTree(configPath.toFile()).path("systemAuthorization");
            if (!"synthetic-local".equals(settings.path("configurationKind").asText())) return java.util.Set.of();
            java.util.Set<PcmPatientIdentifier> result = new java.util.HashSet<>();
            for (JsonNode member : settings.path("memberships")) {
                JsonNode identity = member.path("identifier");
                if (member.path("sandboxFixture").isBoolean() && member.path("sandboxFixture").booleanValue()
                        && "http://fhir.health.gov.il/identifier/il-hdp-test-id".equals(identity.path("system").asText())
                        && java.util.Set.of("1", "2").contains(identity.path("value").asText())) {
                    result.add(new PcmPatientIdentifier(identity.path("system").asText(), identity.path("value").asText()));
                }
            }
            return java.util.Set.copyOf(result);
        } catch (Exception rejected) { throw new SecurityException("Unable to resolve synthetic workflow fixtures", rejected); }
    }

}
