package org.hl7.hdp.pcm.hapi;

import java.util.Objects;
import java.util.Set;

/**
 * One independently granted read rule. Multiple instances are intentionally
 * emitted as separate HAPI rules so OAuth/SMART union semantics are preserved.
 *
 * @param resourceType concrete R4 resource type
 * @param filter optional conjunctive FHIR search expression for this grant
 * @param patientId optional local Patient id for a Patient-compartment grant
 * @param masterRead explicit finite master direct-read authority, retaining Patient invocation context
 * @param interactions SMART interaction letters granted by this scope
 */
public record PcmReadGrant(String resourceType, String filter, String patientId, Set<Character> interactions, boolean masterRead) {
    /** Existing clinical/system rules retain their previous compartment behavior. */
    public PcmReadGrant(String resourceType, String filter, String patientId, Set<Character> interactions) {
        this(resourceType, filter, patientId, interactions, false);
    }

    /** Compatibility constructor for a scope granting both read and search. */
    public PcmReadGrant(String resourceType, String filter, String patientId) {
        this(resourceType, filter, patientId, Set.of('r', 's'));
    }

    public PcmReadGrant {
        resourceType = Objects.requireNonNull(resourceType, "resourceType");
        interactions = Set.copyOf(Objects.requireNonNull(interactions, "interactions"));
        if (masterRead && (!Set.of("Organization", "Practitioner", "PractitionerRole", "Location").contains(resourceType)
                || patientId == null || patientId.isBlank() || !interactions.equals(Set.of('r')))) {
            throw new IllegalArgumentException("Master authority requires a finite Patient-context direct-read grant");
        }
        if (interactions.isEmpty() || interactions.stream().anyMatch(value -> value != 'r' && value != 's')) {
            throw new IllegalArgumentException("Only SMART r/s interactions are supported");
        }
    }

    /** Return true when this grant is scoped to one Patient compartment. */
    public boolean isPatientGrant() {
        return patientId != null && !patientId.isBlank();
    }
}
