package org.hl7.hdp.pcm.hapi;

import java.util.Map;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;

/** Exact local source authorization boundary, independent of general simulation controls. */
public final class PcmSandboxSamplePolicy {
    public static final String SYSTEM = "http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id";
    private static final Map<String, String> EXPECTED = Map.of(
            "identifier", SYSTEM + "|", "_count", "10", "_total", "none", "_elements", "identifier,name,birthDate");
    private PcmSandboxSamplePolicy() { }

    /** Reject wider searches, repeated parameters, alternate systems and nonprojected requests. */
    public static void validate(Map<String, String[]> parameters) {
        if (!parameters.keySet().equals(EXPECTED.keySet())) throw denied();
        EXPECTED.forEach((key, value) -> {
            String[] values = parameters.get(key);
            if (values == null || values.length != 1 || !value.equals(values[0])) throw denied();
        });
    }
    /** Admit only unique, unambiguous HTEST GUID identities from the already capped page. */
    static boolean eligiblePatient(org.hl7.fhir.r4.model.Patient patient, java.util.Set<String> seen) {
        var identifiers = patient.getIdentifier().stream().filter(value -> SYSTEM.equals(value.getSystem())).toList();
        if (identifiers.size() != 1) return false;
        String value = identifiers.get(0).getValue();
        if (value == null || !value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
                || value.equals("00000000-0000-0000-0000-000000000000")
                || patient.getMeta().getSecurity().stream().noneMatch(tag -> "http://terminology.hl7.org/CodeSystem/v3-ActReason".equals(tag.getSystem()) && "HTEST".equals(tag.getCode()))) return false;
        return seen.add(value);
    }

    private static ForbiddenOperationException denied() {
        return new ForbiddenOperationException("Local sandbox sample denied");
    }
}
