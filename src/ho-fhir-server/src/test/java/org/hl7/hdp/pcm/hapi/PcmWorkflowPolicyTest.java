package org.hl7.hdp.pcm.hapi;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Exact authored Contract identities reload without Contract reads or title inference. */
class PcmWorkflowPolicyTest {
    @TempDir Path directory;

    @Test
    void loadsAndReloadsConfiguredBusinessIdentityWithExplicitDefaults() throws Exception {
        Path config = directory.resolve("team-config.json"), catalog = directory.resolve("catalog.json");
        Files.writeString(config, "{}");
        assertThat(PcmWorkflowPolicy.load(config)).isEqualTo(PcmWorkflowPolicy.DEFAULTS);
        Files.writeString(config, "{\"serviceCatalog\":{\"file\":\"catalog.json\"}}");
        Files.writeString(catalog, "{\"systemPolicies\":[{\"scenario\":\"presence-check\",\"policyIdentifier\":\"replacement\",\"name\":\"untrusted title\"}]}");
        assertThat(PcmWorkflowPolicy.load(config)).containsEntry("presence-check", "replacement");
        Files.writeString(catalog, Files.readString(catalog).replace("replacement", "next-identity"));
        assertThat(PcmWorkflowPolicy.load(config)).containsEntry("presence-check", "next-identity");
    }

    @Test
    void missingUnsafeOrAmbiguousSelectedCatalogFailsClosed() throws Exception {
        Path config = directory.resolve("team-config.json");
        Files.writeString(config, "{\"serviceCatalog\":{\"file\":\"missing.json\"}}");
        assertThatThrownBy(() -> PcmWorkflowPolicy.load(config)).isInstanceOf(SecurityException.class);
        Files.writeString(config, "{\"serviceCatalog\":{\"file\":\"../escape.json\"}}");
        assertThatThrownBy(() -> PcmWorkflowPolicy.load(config)).isInstanceOf(SecurityException.class);
        Files.writeString(config, "{\"serviceCatalog\":{\"file\":\"catalog.json\"}}");
        Files.writeString(directory.resolve("catalog.json"), "{\"systemPolicies\":[{\"scenario\":\"presence-check\",\"policyIdentifier\":\"PCM-POLICY-PATIENT-AUTHENTICATION-001\"}]}");
        assertThatThrownBy(() -> PcmWorkflowPolicy.load(config)).isInstanceOf(SecurityException.class);
    }
    @Test
    void exactSyntheticFixtureEnrollmentReloadsAndCannotEnableSandboxGuidOrPersonLogin() throws Exception {
        Path config = directory.resolve("team-config.json");
        Files.writeString(config, "{}");
        assertThat(PcmWorkflowPolicy.syntheticFixtures(config)).isEmpty();
        String fixture = """
                {"systemAuthorization":{"configurationKind":"synthetic-local","memberships":[
                  {"identifier":{"system":"http://fhir.health.gov.il/identifier/il-hdp-test-id","value":"1"},"sandboxFixture":true},
                  {"identifier":{"system":"http://fhir.health.gov.il/identifier/il-hdp-test-id","value":"2"}},
                  {"identifier":{"system":"http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id","value":"fixture"},"sandboxFixture":true}]}}
                """;
        Files.writeString(config, fixture);
        assertThat(PcmWorkflowPolicy.syntheticFixtures(config)).containsExactly(new PcmPatientIdentifier("http://fhir.health.gov.il/identifier/il-hdp-test-id", "1"));
        Files.writeString(config, fixture.replace("synthetic-local", "production"));
        assertThat(PcmWorkflowPolicy.syntheticFixtures(config)).isEmpty();
        Files.writeString(config, fixture.replace("true", "false"));
        assertThat(PcmWorkflowPolicy.syntheticFixtures(config)).isEmpty();
    }

}
