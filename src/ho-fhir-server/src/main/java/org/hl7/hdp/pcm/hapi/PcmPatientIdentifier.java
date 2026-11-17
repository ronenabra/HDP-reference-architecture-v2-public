package org.hl7.hdp.pcm.hapi;

import java.util.Objects;

/** Immutable typed Patient identifier used by presence authorization. */
public record PcmPatientIdentifier(String system, String value) {
    public PcmPatientIdentifier {
        system = requireText(system, "system");
        value = requireText(value, "value");
    }

    /** Return the exact FHIR token-search representation. */
    public String token() {
        return system + "|" + value;
    }

    private static String requireText(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return value;
    }
}
