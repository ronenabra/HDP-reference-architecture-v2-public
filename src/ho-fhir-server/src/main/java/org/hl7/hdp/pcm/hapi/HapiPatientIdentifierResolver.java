package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.param.TokenParam;
import org.hl7.fhir.r4.model.Patient;

import java.util.List;

/** Exact Patient identifier lookup implemented through HAPI's native DAO. */
public final class HapiPatientIdentifierResolver implements PatientIdentifierResolver, PatientPresenceCounter {
    private static final String TEST_IDENTIFIER_SYSTEM = "http://fhir.health.gov.il/identifier/il-hdp-test-id";
    private static final String ACT_REASON_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActReason";
    static final String INTERNAL_RESOLUTION_ATTRIBUTE = HapiPatientIdentifierResolver.class.getName() + ".exactLookup";
    private final DaoRegistry daoRegistry;

    public HapiPatientIdentifierResolver(DaoRegistry daoRegistry) {
        this.daoRegistry = daoRegistry;
    }

    @Override
    public String resolve(String system, String value, RequestDetails requestDetails) {
        if (system == null || system.isBlank() || value == null || value.isBlank()) {
            throw new SecurityException("Patient context is invalid");
        }
        List<Patient> matches = find(system, value);
        if (matches.size() != 1 || matches.get(0).getIdElement().getIdPart() == null) {
            throw new PcmContextException(matches.size() > 1 ? "PATIENT_AMBIGUOUS" : "PATIENT_UNMAPPED", "Patient context does not resolve exactly once");
        }
        return matches.get(0).getIdElement().getIdPart();
    }

    /** Return a privacy-safe zero/one count and reject ambiguous or improperly labelled test identities. */
    @Override
    public int count(PcmPatientIdentifier identifier, RequestDetails requestDetails) {
        List<Patient> matches = find(identifier.system(), identifier.value());
        if (matches.size() > 1) throw new SecurityException("Patient identifier is ambiguous");
        if (matches.isEmpty()) return 0;
        if (TEST_IDENTIFIER_SYSTEM.equals(identifier.system()) && matches.get(0).getMeta().getSecurity().stream()
                .noneMatch(label -> ACT_REASON_SYSTEM.equals(label.getSystem()) && "HTEST".equals(label.getCode()))) {
            throw new SecurityException("Synthetic Patient is missing HTEST security");
        }
        Object context = requestDetails.getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE);
        boolean workflow = context instanceof PcmRequestContext pcm
                && (pcm.kind() == PcmRequestContext.Kind.ONLINE_PRESENCE || pcm.kind() == PcmRequestContext.Kind.BATCH_PRESENCE);
        if (workflow && !Boolean.FALSE.equals(requestDetails.getUserData().get(LocalJwtRequestContextVerifier.FILTERING_ATTRIBUTE))
                && matches.get(0).getMeta().getSecurity().stream().noneMatch(label ->
                    "http://fhir.health.gov.il/cs/il-hdp-information-buckets".equals(label.getSystem())
                    && "patientDemographics".equals(label.getCode()))) return 0;
        return 1;
    }

    private List<Patient> find(String system, String value) {
        if (system == null || system.isBlank() || value == null || value.isBlank()) {
            throw new SecurityException("Patient context is invalid");
        }
        IFhirResourceDao<Patient> dao = daoRegistry.getResourceDao(Patient.class);
        SearchParameterMap query = new SearchParameterMap()
                .add(Patient.SP_IDENTIFIER, new TokenParam(system, value))
                .setCount(2)
                .setLoadSynchronous(true);
        SystemRequestDetails internal = new SystemRequestDetails();
        internal.getUserData().put(INTERNAL_RESOLUTION_ATTRIBUTE, Boolean.TRUE);
        return dao.searchForResources(query, internal);
    }

    /** True only for the in-process exact lookup request created above. */
    static boolean isInternalResolution(RequestDetails requestDetails) {
        return requestDetails != null
                && Boolean.TRUE.equals(requestDetails.getUserData().get(INTERNAL_RESOLUTION_ATTRIBUTE));
    }
}
