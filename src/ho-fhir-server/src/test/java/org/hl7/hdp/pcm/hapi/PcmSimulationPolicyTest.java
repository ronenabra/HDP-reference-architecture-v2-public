package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Mounted policy, rather than signed caller claims, permits the bounded authentication exception. */
class PcmSimulationPolicyTest {
    @TempDir Path directory;

    private static final String CURRENT_CONFIG = """
            {"configVersion":"pcm-team-config/5",
             "conformance":{"policyVersion":"pcm-sandbox-policy/4","mode":"connectathon","preset":"connectathon-balanced"},
             "security":{"pcmApi":{"clientAuth":"tls"},"dsFhirServer":{"enforceMappedPatients":true}},
             "securitySimulation":{"perSource":{"ho-a":{"clientAssertionSignature":false}}}}
            """;

    /** Current mounted controls retain source-specific simulation while Strict remains locked. */
    @Test
    void sourceOverridesAndPcmTransportRemainIndependentAndStrictNeverRelaxes() throws Exception {
        Path config = directory.resolve("team.json");
        Files.writeString(config, CURRENT_CONFIG);
        PcmSimulationPolicy selected = PcmSimulationPolicy.load(config, "ho-a");
        PcmSimulationPolicy other = PcmSimulationPolicy.load(config, "ho-b");
        assertThat(selected.transportSimulation()).isTrue();
        assertThat(selected.signatureSimulation()).isTrue();
        assertThat(other.signatureSimulation()).isFalse();
        assertThat(selected.anonymousSimulation()).isFalse();
        String strict = Files.readString(config).replace("connectathon-balanced", "strict").replace("connectathon", "strict");
        Files.writeString(config, strict);
        PcmSimulationPolicy locked = PcmSimulationPolicy.load(config, "ho-a");
        assertThat(locked.transportSimulation()).isFalse();
        assertThat(locked.signatureSimulation()).isFalse();
        assertThat(locked.anonymousSimulation()).isFalse();
    }

    /** Missing and prior team versions cannot enable source authentication simulation. */
    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"pcm-team-config/4"})
    void missingOrOldConfigurationVersionDenies(String version) throws Exception {
        ObjectNode config = (ObjectNode) new ObjectMapper().readTree(CURRENT_CONFIG);
        if (version == null) config.remove("configVersion");
        else config.put("configVersion", version);
        assertIncompatibleConfiguration(config);
    }

    /** Missing and prior policy versions require coordinated migration before use. */
    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"pcm-sandbox-policy/3"})
    void missingOrOldPolicyVersionDenies(String version) throws Exception {
        ObjectNode config = (ObjectNode) new ObjectMapper().readTree(CURRENT_CONFIG);
        ObjectNode conformance = (ObjectNode) config.path("conformance");
        if (version == null) conformance.remove("policyVersion");
        else conformance.put("policyVersion", version);
        assertIncompatibleConfiguration(config);
    }

    /** Missing or disabled mapped-Patient enforcement never grants simulation authority. */
    @ParameterizedTest
    @NullSource
    @ValueSource(booleans = {false})
    void missingOrDisabledMappedPatientEnforcementDenies(Boolean enforceMappedPatients) throws Exception {
        ObjectNode config = (ObjectNode) new ObjectMapper().readTree(CURRENT_CONFIG);
        ObjectNode server = (ObjectNode) config.path("security").path("dsFhirServer");
        if (enforceMappedPatients == null) server.remove("enforceMappedPatients");
        else server.put("enforceMappedPatients", enforceMappedPatients);
        assertIncompatibleConfiguration(config);
    }

    /** Write a single invalid mounted config and require the loader's explicit migration denial. */
    private void assertIncompatibleConfiguration(ObjectNode config) throws Exception {
        Path path = directory.resolve("team.json");
        Files.writeString(path, config.toString());
        assertThatThrownBy(() -> PcmSimulationPolicy.load(path, "ho-a"))
                .isInstanceOf(SecurityException.class)
                .hasMessage("Unable to resolve the current source simulation policy")
                .hasCauseInstanceOf(SecurityException.class)
                .hasRootCauseMessage("Incompatible source configuration; coordinated scope migration required");
    }
}
