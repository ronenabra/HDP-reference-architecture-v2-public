package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.api.config.JpaStorageSettings;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/** Pins the bounded HAPI maintenance capabilities required by Admin reset. */
class HapiMaintenanceConfigTest {
    /** Bind the shipped YAML to HAPI's real enum and verify source-only storage. */
    @Test
    void uploadedSourceUrisAreStoredWithoutGeneratedRequestIdSuffixes() throws IOException {
        var source = new YamlPropertySourceLoader().load("maintenance", new ClassPathResource("application.yaml")).get(0);
        var mode = new Binder(ConfigurationPropertySources.from(source)).bind(
                "hapi.fhir.store-meta-source-information",
                Bindable.of(JpaStorageSettings.StoreMetaSourceInformationEnum.class)).get();
        assertThat(mode).isEqualTo(JpaStorageSettings.StoreMetaSourceInformationEnum.SOURCE_URI);
        assertThat(mode.isStoreSourceUri()).isTrue();
        assertThat(mode.isStoreRequestId()).isFalse();
    }

    @Test
    void privateResetDependenciesAreExplicitlyEnabled() throws IOException {
        try (var stream = getClass().getResourceAsStream("/application.yaml")) {
            assertThat(stream).isNotNull();
            String yaml = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            assertThat(yaml).contains("allow_multiple_delete: true");
            assertThat(yaml).contains("expunge_enabled: true");
        }
    }
}
