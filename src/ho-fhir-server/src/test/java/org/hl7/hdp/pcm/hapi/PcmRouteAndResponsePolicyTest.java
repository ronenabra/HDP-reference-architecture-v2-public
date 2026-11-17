package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentInterceptor;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.CapabilityStatement;
import org.hl7.fhir.r4.model.OperationOutcome;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Public-surface, aggregate, and capability fail-closed invariants. */
class PcmRouteAndResponsePolicyTest {
    private final SignedRequestContextVerifier ordinary = request ->
            new PcmRequestContext("ho-a", "client", List.of(new PcmReadGrant("Observation", null, null)));

    /** Expose HAPI's actual request-scoped skip decision without duplicating its flag. */
    private static final class ConsentProbe extends ConsentInterceptor {
        boolean skips(SystemRequestDetails request) {
            return isSkipServiceForRequest(request);
        }
    }

    @Test
    void verifiedMaintenanceSkipsCandidateMaterializationWithoutRelaxingOrdinaryAccess() {
        String credential = "0123456789abcdef0123456789abcdef";
        PcmRoutePolicyInterceptor importer = new PcmRoutePolicyInterceptor(
                new PrivateImportRequestContextVerifier(credential, "ho-c"));
        SystemRequestDetails maintenance = request("Observation", Map.of("_count", new String[]{"1000"}));
        maintenance.addHeader(PrivateImportRequestContextVerifier.HEADER, credential);
        importer.enforce(maintenance, RestOperationTypeEnum.SEARCH_TYPE);
        ConsentProbe consent = new ConsentProbe();
        assertThat(consent.skips(maintenance)).isTrue();
        ca.uhn.fhir.rest.api.server.IPreResourceAccessDetails rows = org.mockito.Mockito.mock(
                ca.uhn.fhir.rest.api.server.IPreResourceAccessDetails.class);
        consent.interceptPreAccess(maintenance, rows);
        org.mockito.Mockito.verifyNoInteractions(rows);

        SystemRequestDetails protectedSearch = request("Observation", Map.of());
        new PcmRoutePolicyInterceptor(ordinary).enforce(protectedSearch, RestOperationTypeEnum.SEARCH_TYPE);
        assertThat(consent.skips(protectedSearch)).isFalse();

        SystemRequestDetails forged = request("Observation", Map.of());
        forged.addHeader(PrivateImportRequestContextVerifier.HEADER, "wrong");
        assertThatThrownBy(() -> importer.enforce(forged, RestOperationTypeEnum.SEARCH_TYPE))
                .isInstanceOf(ForbiddenOperationException.class);
        assertThat(consent.skips(forged)).isFalse();
    }

    @Test
    void exactAggregateCountsRequireVerifiedMaintenanceAndRetainTheirTotal() {
        String credential = "0123456789abcdef0123456789abcdef";
        PcmRoutePolicyInterceptor importer = new PcmRoutePolicyInterceptor(
                new PrivateImportRequestContextVerifier(credential, "ho-c"));
        Map<String, String[]> countQuery = Map.of(
                "_summary", new String[]{"count"}, "_total", new String[]{"accurate"});
        SystemRequestDetails maintenance = request("Observation", countQuery);
        maintenance.addHeader(PrivateImportRequestContextVerifier.HEADER, credential);
        importer.enforce(maintenance, RestOperationTypeEnum.SEARCH_TYPE);
        // Exercise the real HAPI hook that otherwise rejects both aggregate parameters.
        new ConsentProbe().interceptPreHandled(maintenance);
        Bundle result = new Bundle().setType(Bundle.BundleType.SEARCHSET).setTotal(40055);
        new PcmResponsePolicyInterceptor().removeOrdinaryTotal(maintenance, result);
        assertThat(result.getTotal()).isEqualTo(40055);

        SystemRequestDetails protectedCount = request("Observation", countQuery);
        new PcmRoutePolicyInterceptor(ordinary).enforce(protectedCount, RestOperationTypeEnum.SEARCH_TYPE);
        // Native Consent still rejects an aggregate reaching ordinary dispatch;
        // only the dedicated verified count interceptor may short circuit it.
        assertThatThrownBy(() -> new ConsentProbe().interceptPreHandled(protectedCount))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        SystemRequestDetails forged = request("Observation", countQuery);
        forged.addHeader(PrivateImportRequestContextVerifier.HEADER, "wrong");
        assertThatThrownBy(() -> importer.enforce(forged, RestOperationTypeEnum.SEARCH_TYPE))
                .isInstanceOf(ForbiddenOperationException.class);
        assertThat(new ConsentProbe().skips(forged)).isFalse();
    }

    @Test
    void allowsDeclaredReadSideAndDeniesWritesCountsAdvancedAndBinary() {
        PcmRoutePolicyInterceptor policy = new PcmRoutePolicyInterceptor(ordinary);
        SystemRequestDetails allowed = request("Observation", Map.of("status", new String[]{"final"}));
        policy.enforce(allowed, RestOperationTypeEnum.SEARCH_TYPE);

        for (SystemRequestDetails denied : List.of(
                request("Observation", Map.of("subject.identifier", new String[]{"123"})),
                request("Observation", Map.of("_filter", new String[]{"status eq final"})),
                request("Binary", Map.of()))) {
            assertThatThrownBy(() -> policy.enforce(denied, RestOperationTypeEnum.SEARCH_TYPE))
                    .isInstanceOf(ForbiddenOperationException.class)
                    .hasMessageNotContaining("123");
        }
        assertThatThrownBy(() -> policy.enforce(allowed, RestOperationTypeEnum.CREATE))
                .isInstanceOf(ForbiddenOperationException.class);
        PcmRoutePolicyInterceptor invalidContext = new PcmRoutePolicyInterceptor(request -> {
            throw new SecurityException("Patient/secret");
        });
        assertThatThrownBy(() -> invalidContext.enforce(allowed, RestOperationTypeEnum.SEARCH_TYPE))
                .isInstanceOf(ForbiddenOperationException.class)
                .hasMessageNotContaining("secret");
    }

    @Test
    void authorizedPresenceAdmitsRootBatchToItsValidatingProviderButStillDeniesResourceWrites() {
        PcmRoutePolicyInterceptor policy = new PcmRoutePolicyInterceptor(request -> new PcmRequestContext("ho-a", "pcm-presence-orchestrator", List.of(),
                PcmRequestContext.Kind.BATCH_PRESENCE, null,
                List.of(new PcmPatientIdentifier("http://fhir.health.gov.il/identifier/il-hdp-test-id", "1"),
                        new PcmPatientIdentifier("http://fhir.health.gov.il/identifier/il-hdp-test-id", "2")), null, false));
        policy.enforce(new SystemRequestDetails(), RestOperationTypeEnum.TRANSACTION);
        for (RestOperationTypeEnum write : List.of(RestOperationTypeEnum.CREATE, RestOperationTypeEnum.UPDATE,
                RestOperationTypeEnum.DELETE, RestOperationTypeEnum.TRANSACTION)) {
            assertThatThrownBy(() -> policy.enforce(request("Patient", Map.of()), write))
                    .isInstanceOf(ForbiddenOperationException.class);
        }
    }

    @Test
    void omitsOrdinaryTotalAndFiltersNativeCapability() {
        PcmResponsePolicyInterceptor policy = new PcmResponsePolicyInterceptor();
        SystemRequestDetails request = new SystemRequestDetails();
        request.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE,
                new PcmRequestContext("ho-a", "client", List.of()));
        assertThat(request.getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE))
                .isInstanceOf(PcmRequestContext.class);
        Bundle bundle = new Bundle().setType(Bundle.BundleType.SEARCHSET).setTotal(42);
        assertThat(policy.removeOrdinaryTotal(request, bundle)).isTrue();
        assertThat(bundle.hasTotal()).isFalse();

        OperationOutcome denied = new OperationOutcome();
        denied.addIssue().setDiagnostics("Resource Observation/secret and Patient/000000018 are not known");
        assertThat(policy.removeOrdinaryTotal(request, denied)).isTrue();
        assertThat(denied.getIssue()).singleElement().satisfies(issue ->
                assertThat(issue.getDiagnostics()).isEqualTo("PCM request denied"));

        denied.getIssueFirstRep().setDiagnostics("Patient/000000018");
        policy.sanitizeFailure(request, denied);
        assertThat(denied.getIssueFirstRep().getDiagnostics()).isEqualTo("PCM request denied");

        ForbiddenOperationException exception = new ForbiddenOperationException(
                "Resource Observation/secret and Patient/000000018 are not known");
        assertThat(policy.sanitizeException(request, exception).getOperationOutcome())
                .isInstanceOf(OperationOutcome.class);
        assertThat(((OperationOutcome) exception.getOperationOutcome()).getIssueFirstRep().getDiagnostics())
                .isEqualTo("PCM request denied");

        CapabilityStatement statement = new CapabilityStatement();
        CapabilityStatement.CapabilityStatementRestComponent rest = statement.addRest();
        rest.addInteraction().setCode(CapabilityStatement.SystemRestfulInteraction.TRANSACTION);
        rest.addResource().setType("Binary").addInteraction().setCode(CapabilityStatement.TypeRestfulInteraction.READ);
        rest.addResource().setType("Observation").addInteraction().setCode(CapabilityStatement.TypeRestfulInteraction.READ);
        policy.limitCapability(statement);
        assertThat(rest.getInteraction()).isEmpty();
        assertThat(rest.getResource()).extracting(CapabilityStatement.CapabilityStatementRestResourceComponent::getType)
                .containsExactly("Observation");
    }

    private static SystemRequestDetails request(String resource, Map<String, String[]> parameters) {
        SystemRequestDetails request = new SystemRequestDetails();
        request.setResourceName(resource);
        request.setRequestPath(resource);
        request.setParameters(parameters);
        return request;
    }
}
