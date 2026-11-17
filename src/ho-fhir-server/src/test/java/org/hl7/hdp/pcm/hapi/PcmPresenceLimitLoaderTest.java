package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Presence limit configuration is required, local, bounded, and fail-closed. */
class PcmPresenceLimitLoaderTest {
    @TempDir
    Path temporaryDirectory;

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void loadsAllRequiredOperationalLimits() throws Exception {
        Path config = write("""
                {"presence":{"batch":{
                  "maxPatients":100,
                  "maxPayloadBytes":65536,
                  "timeoutMilliseconds":5000
                }}}
                """);

        assertThat(PcmPresenceLimitLoader.load(config, mapper))
                .isEqualTo(new PcmPresenceLimits(100, 65536, 5000));
    }

    @Test
    void failsClosedForMissingFileSectionOrValue() throws Exception {
        assertThatThrownBy(() -> PcmPresenceLimitLoader.load(
                temporaryDirectory.resolve("missing.json"), mapper))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PcmPresenceLimitLoader.load(write("{}"), mapper))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PcmPresenceLimitLoader.load(write(
                "{\"presence\":{\"batch\":{\"maxPatients\":2,\"maxPayloadBytes\":1024}}}"), mapper))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PcmPresenceLimitLoader.load(write(
                "{\"presence\":{\"batch\":{\"maxPatients\":2,\"maxPayloadBytes\":1024,"
                        + "\"timeoutMilliseconds\":1,\"unknown\":true}}}"), mapper))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rejectsWrongTypesAndUnsafeBounds() throws Exception {
        assertThatThrownBy(() -> PcmPresenceLimitLoader.load(write("""
                {"presence":{"batch":{
                  "maxPatients":"100",
                  "maxPayloadBytes":65536,
                  "timeoutMilliseconds":5000
                }}}
                """), mapper)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PcmPresenceLimitLoader.load(write("""
                {"presence":{"batch":{
                  "maxPatients":1,
                  "maxPayloadBytes":65536,
                  "timeoutMilliseconds":5000
                }}}
                """), mapper)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sourceOverrideReloadsAboveOneHundredWithoutChangingOtherSources() throws Exception {
        Path config = write("{\"presence\":{\"batch\":{\"maxPatients\":100,\"maxPayloadBytes\":65536,\"timeoutMilliseconds\":5000,\"maxRarBytes\":32768},\"sources\":{\"ho-b\":{\"maxPatients\":105}}}}");
        assertThat(PcmPresenceLimitLoader.load(config, mapper, "ho-a").maxPatients()).isEqualTo(100);
        assertThat(PcmPresenceLimitLoader.load(config, mapper, "ho-b").maxPatients()).isEqualTo(105);
        Files.writeString(config, Files.readString(config).replace("105", "106"));
        assertThat(PcmPresenceLimitLoader.load(config, mapper, "ho-b").maxPatients()).isEqualTo(106);
        assertThat(PcmPresenceLimitLoader.load(config, mapper, "ho-a").maxPatients()).isEqualTo(100);
    }

    private Path write(String json) throws Exception {
        Path config = temporaryDirectory.resolve("team-config-" + System.nanoTime() + ".json");
        Files.writeString(config, json);
        return config;
    }
}
