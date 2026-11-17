package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import org.hl7.fhir.r4.model.Bundle;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Exact online/batch query shape and privacy-safe response tests. */
class PcmPresenceRequestPolicyTest {
    private static final PcmPatientIdentifier PATIENT =
            new PcmPatientIdentifier("http://fhir.health.gov.il/identifier/il-hdp-test-id", "1");

    @Test
    void acceptsOnlyTheExactCountOnlyOnlineShape() {
        SystemRequestDetails request = online(Map.of(
                "identifier", new String[]{PATIENT.token()},
                "_summary", new String[]{"count"},
                "_count", new String[]{"0"}));
        assertThat(PcmPresenceRequestPolicy.online(request)).isEqualTo(PATIENT);

        for (Map<String, String[]> invalid : List.of(
                Map.of("identifier", new String[]{PATIENT.token()}, "_summary", new String[]{"count"}),
                Map.of("identifier", new String[]{PATIENT.token()}, "_summary", new String[]{"true"}, "_count", new String[]{"0"}),
                Map.of("identifier", new String[]{PATIENT.token()}, "_summary", new String[]{"count"},
                        "_count", new String[]{"0"}, "name", new String[]{"secret"}))) {
            assertThatThrownBy(() -> PcmPresenceRequestPolicy.online(online(invalid)))
                    .isInstanceOf(SecurityException.class).hasMessageNotContaining("secret");
        }
    }

    @Test
    void parsesEncodedBatchUrlsWithoutAcceptingDuplicatesOrExtraFields() {
        assertThat(PcmPresenceRequestPolicy.batchEntry(
                "Patient?identifier=http%3A%2F%2Ffhir.health.gov.il%2Fidentifier%2Fil-hdp-test-id%7C1&_summary=count&_count=0"))
                .isEqualTo(PATIENT);
        for (String invalid : List.of(
                "Observation?identifier=x%7C1&_summary=count&_count=0",
                "Patient?identifier=x%7C1&_summary=count&_count=0&name=secret",
                "Patient?identifier=x%7C1&identifier=x%7C2&_summary=count&_count=0",
                "https://other.example/Patient?identifier=x%7C1&_summary=count&_count=0")) {
            assertThatThrownBy(() -> PcmPresenceRequestPolicy.batchEntry(invalid))
                    .isInstanceOf(SecurityException.class).hasMessageNotContaining("secret");
        }
    }

    @Test
    void routePreauthorizesIdentifierBeforePreservingOnlyZeroOrOneTotal() {
        PcmRequestContext context = new PcmRequestContext("ho-a", "pcm-presence-orchestrator", List.of(),
                PcmRequestContext.Kind.ONLINE_PRESENCE, null, List.of(PATIENT), null, false);
        PcmRoutePolicyInterceptor route = new PcmRoutePolicyInterceptor(request -> context, (identifier, request) -> 1);
        SystemRequestDetails request = online(Map.of(
                "identifier", new String[]{PATIENT.token()}, "_summary", new String[]{"count"}, "_count", new String[]{"0"}));
        assertThat(context.presenceIdentifiers()).containsExactly(PcmPresenceRequestPolicy.online(request));
        assertThat(context.withPresenceCount(1).presenceCount()).isEqualTo(1);
        route.enforce(request, RestOperationTypeEnum.SEARCH_TYPE);

        Bundle response = new Bundle().setType(Bundle.BundleType.SEARCHSET).setTotal(99);
        response.addEntry().setResource(new org.hl7.fhir.r4.model.Patient().setId("secret"));
        new PcmResponsePolicyInterceptor().removeOrdinaryTotal(request, response);
        assertThat(response.getTotal()).isEqualTo(1);
        assertThat(response.getEntry()).isEmpty();

        SystemRequestDetails wrongPatient = online(Map.of(
                "identifier", new String[]{PATIENT.system() + "|2"}, "_summary", new String[]{"count"}, "_count", new String[]{"0"}));
        assertThatThrownBy(() -> route.enforce(wrongPatient, RestOperationTypeEnum.SEARCH_TYPE))
                .isInstanceOf(ForbiddenOperationException.class);
    }

    private static SystemRequestDetails online(Map<String, String[]> parameters) {
        SystemRequestDetails request = new SystemRequestDetails();
        request.setResourceName("Patient");
        request.setRequestPath("Patient");
        request.setParameters(parameters);
        return request;
    }
}
