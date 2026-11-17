package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import org.hl7.fhir.r4.model.Patient;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** Identity ambiguity and demographics authorization are independent native presence decisions. */
class HapiPatientIdentifierResolverTest {
    @Test
    void countRequiresDemographicsForWorkflowButAllOffAndOrdinaryIdentityResolutionStaySeparate() {
        DaoRegistry registry = mock(DaoRegistry.class);
        @SuppressWarnings("unchecked") IFhirResourceDao<Patient> dao = mock(IFhirResourceDao.class);
        when(registry.getResourceDao(Patient.class)).thenReturn(dao);
        Patient patient = new Patient(); patient.setId("Patient/local");
        when(dao.searchForResources(any(), any())).thenReturn(List.of(patient));
        var resolver = new HapiPatientIdentifierResolver(registry);
        var identifier = new PcmPatientIdentifier("http://example.test/id", "1");
        var request = new SystemRequestDetails();
        request.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE, new PcmRequestContext("ho-a", "client", List.of(),
                PcmRequestContext.Kind.ONLINE_PRESENCE, null, List.of(identifier), null, false));
        assertThat(resolver.count(identifier, request)).isZero();
        patient.getMeta().addSecurity("http://fhir.health.gov.il/cs/il-hdp-information-buckets", "wrong", null);
        assertThat(resolver.count(identifier, request)).isZero();
        assertThat(resolver.resolve(identifier.system(), identifier.value(), request)).isEqualTo("local");
        patient.getMeta().addSecurity("http://fhir.health.gov.il/cs/il-hdp-information-buckets", "patientDemographics", null);
        assertThat(resolver.count(identifier, request)).isOne();
        patient.getMeta().getSecurity().clear();
        request.getUserData().put(LocalJwtRequestContextVerifier.FILTERING_ATTRIBUTE, false);
        assertThat(resolver.count(identifier, request)).isOne();
        when(dao.searchForResources(any(), any())).thenReturn(List.of(patient, patient));
        assertThatThrownBy(() -> resolver.count(identifier, request)).isInstanceOf(SecurityException.class);
    }
}
