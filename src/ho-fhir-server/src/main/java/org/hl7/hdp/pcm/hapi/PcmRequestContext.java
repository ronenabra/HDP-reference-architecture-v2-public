package org.hl7.hdp.pcm.hapi;

import java.util.List;
import java.util.Objects;

/**
 * Verified adapter context consumed by the HAPI authorization seam.
 *
 * @param healthOrganization immutable local HO binding
 * @param subject authenticated client subject
 * @param readGrants independently granted SMART read rules
 * @param kind closed authorization class from PCM introspection
 * @param patientIdentifier exact online-presence Patient identifier, if any
 * @param presenceIdentifiers exact batch-presence Patient set
 * @param presenceCount pre-authorized online count, populated only after query validation
 * @param importAccess true only for the private one-shot loader credential
 */
public record PcmRequestContext(
        String healthOrganization,
        String subject,
        List<PcmReadGrant> readGrants,
        Kind kind,
        PcmPatientIdentifier patientIdentifier,
        List<PcmPatientIdentifier> presenceIdentifiers,
        Integer presenceCount,
        boolean importAccess,
        PcmPatientIdentifier representativeIdentifier,
        String targetPatientId) {
    /** Closed classes accepted from the private adapter JWT. */
    public enum Kind {
        DATA_SOURCE_ACCESS,
        SANDBOX_PATIENT_SAMPLE,
        ONLINE_PRESENCE,
        BATCH_PRESENCE,
        PATIENT_AUTHENTICATION,
        DEPENDENT_DISCOVERY,
        UNFILTERED_SIMULATION,
        IMPORT
    }

    /** Preserve existing contexts while carrying a separately verified operation target. */
    public PcmRequestContext(String healthOrganization, String subject, List<PcmReadGrant> readGrants,
            Kind kind, PcmPatientIdentifier patientIdentifier, List<PcmPatientIdentifier> presenceIdentifiers,
            Integer presenceCount, boolean importAccess, PcmPatientIdentifier representativeIdentifier) {
        this(healthOrganization, subject, readGrants, kind, patientIdentifier, presenceIdentifiers,
                presenceCount, importAccess, representativeIdentifier, null);
    }

    /** Preserve constructors for contexts without a discovery representative. */
    public PcmRequestContext(String healthOrganization, String subject, List<PcmReadGrant> readGrants,
            Kind kind, PcmPatientIdentifier patientIdentifier, List<PcmPatientIdentifier> presenceIdentifiers,
            Integer presenceCount, boolean importAccess) {
        this(healthOrganization, subject, readGrants, kind, patientIdentifier, presenceIdentifiers,
                presenceCount, importAccess, null);
    }

    /** Construct an ordinary clinical request context. */
    public PcmRequestContext(String healthOrganization, String subject, List<PcmReadGrant> readGrants) {
        this(healthOrganization, subject, readGrants, Kind.DATA_SOURCE_ACCESS, null, List.of(), null, false);
    }

    /** Construct the private loader context. */
    public PcmRequestContext(String healthOrganization, String subject, List<PcmReadGrant> readGrants, boolean importAccess) {
        this(healthOrganization, subject, readGrants,
                importAccess ? Kind.IMPORT : Kind.DATA_SOURCE_ACCESS, null, List.of(), null, importAccess);
    }

    public PcmRequestContext {
        healthOrganization = Objects.requireNonNull(healthOrganization, "healthOrganization");
        subject = Objects.requireNonNull(subject, "subject");
        readGrants = List.copyOf(Objects.requireNonNull(readGrants, "readGrants"));
        kind = Objects.requireNonNull(kind, "kind");
        if (kind == Kind.UNFILTERED_SIMULATION) throw new IllegalArgumentException("Unfiltered clinical contexts are retired");
        presenceIdentifiers = List.copyOf(Objects.requireNonNull(presenceIdentifiers, "presenceIdentifiers"));
        if (importAccess != (kind == Kind.IMPORT)) throw new IllegalArgumentException("import kind mismatch");
        if (presenceCount != null && (kind != Kind.ONLINE_PRESENCE || presenceCount < 0 || presenceCount > 1)) {
            throw new IllegalArgumentException("presence count is invalid");
        }
    }

    /** Return an online context carrying a count produced after exact pre-authorization. */
    public PcmRequestContext withPresenceCount(int count) {
        return new PcmRequestContext(healthOrganization, subject, readGrants, kind,
                patientIdentifier, presenceIdentifiers, count, importAccess);
    }
}
