package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import static org.assertj.core.api.Assertions.*;

/** Every declared GET resource traverses the same POST route and SMART admission owners. */
class PcmPostSearchPolicyTest {
    static java.util.stream.Stream<String> types() { return PcmSmartScopeParser.declaredResourceTypes().stream().sorted(); }

    @ParameterizedTest @MethodSource("types")
    void postAndGetUseTheSameTypeAndInteractionPolicy(String type) {
        for (var method : List.of(RequestTypeEnum.GET, RequestTypeEnum.POST)) {
            var request = new SystemRequestDetails(); request.setFhirContext(FhirContext.forR4Cached());
            request.setResourceName(type); request.setRequestType(method); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
            request.setRequestPath(type + (method == RequestTypeEnum.POST ? "/_search" : ""));
            // Role/Location have no search scope in the existing GET policy; .r remains denied for every type.
            for (String letters : List.of("r", "s")) {
                if (letters.equals("s") && java.util.Set.of("Location", "PractitionerRole").contains(type)) {
                    assertThatThrownBy(() -> PcmSmartScopeParser.parse("patient/" + type + ".s", "p")).isInstanceOf(SecurityException.class);
                    continue;
                }
                var grants = PcmSmartScopeParser.parse("patient/" + type + "." + letters, "p");
                SignedRequestContextVerifier verifier = ignored -> new PcmRequestContext("ho-a", "client", grants);
                new PcmRoutePolicyInterceptor(verifier).enforce(request, RestOperationTypeEnum.SEARCH_TYPE);
                var admission = new PcmAdmissionAuthorizationInterceptor(verifier);
                var resource = FhirContext.forR4Cached().getResourceDefinition(type).newInstance();
                var verdict = admission.applyRulesAndReturnDecision(RestOperationTypeEnum.SEARCH_TYPE, request, null,
                        null, resource, Pointcut.STORAGE_PREACCESS_RESOURCES).getDecision();
                assertThat(verdict).as(type + "/" + method + "/" + letters).isEqualTo(letters.equals("s") ? PolicyEnum.ALLOW : PolicyEnum.DENY);
            }
        }
    }
}
