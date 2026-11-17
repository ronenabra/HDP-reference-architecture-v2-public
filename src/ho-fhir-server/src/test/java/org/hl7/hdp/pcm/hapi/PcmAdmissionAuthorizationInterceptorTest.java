package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Request admission stays bounded while Consent owns exact result filtering. */
class PcmAdmissionAuthorizationInterceptorTest {
    @Test
    void admitsOnlyTheResourceAndInteractionGrantedBySmartLetters() {
        PcmAdmissionAuthorizationInterceptor interceptor = new PcmAdmissionAuthorizationInterceptor(request ->
                new PcmRequestContext("ho-a", "client", List.of(
                        new PcmReadGrant("Observation", "status=final", "patient-1", Set.of('s')))));

        assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE)).isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(interceptor, RestOperationTypeEnum.READ)).isEqualTo(PolicyEnum.DENY);
        assertThat(decision(interceptor, RestOperationTypeEnum.CREATE)).isEqualTo(PolicyEnum.DENY);
    }

    @Test
    void admitsReadGrantedReferencedTypeOnlyInsideAnotherTypesSearch() {
        PcmAdmissionAuthorizationInterceptor interceptor = new PcmAdmissionAuthorizationInterceptor(request ->
                new PcmRequestContext("ho-a", "client", List.of(
                        new PcmReadGrant("Observation", null, "patient-1", Set.of('s')),
                        new PcmReadGrant("Practitioner", null, null, Set.of('r')))));
        SystemRequestDetails details = new SystemRequestDetails();
        details.setFhirContext(FhirContext.forR4Cached());
        details.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        details.setResourceName("Observation");
        org.hl7.fhir.r4.model.Practitioner practitioner = new org.hl7.fhir.r4.model.Practitioner();

        assertThat(interceptor.applyRulesAndReturnDecision(
                RestOperationTypeEnum.SEARCH_TYPE, details, null, practitioner.getIdElement(), practitioner,
                Pointcut.STORAGE_PREACCESS_RESOURCES).getDecision()).isEqualTo(PolicyEnum.ALLOW);
    }

    private static PolicyEnum decision(PcmAdmissionAuthorizationInterceptor interceptor, RestOperationTypeEnum operation) {
        SystemRequestDetails details = new SystemRequestDetails();
        details.setFhirContext(FhirContext.forR4Cached());
        details.setRestOperationType(operation);
        Observation observation = new Observation();
        return interceptor.applyRulesAndReturnDecision(
                operation, details, null, observation.getIdElement(), observation,
                Pointcut.STORAGE_PREACCESS_RESOURCES).getDecision();
    }
}
