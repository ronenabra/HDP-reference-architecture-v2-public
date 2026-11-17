package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import org.hl7.fhir.r4.model.Observation;
import org.hl7.fhir.r4.model.Patient;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher.MatchResult.buildMatched;
import static ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher.MatchResult.buildUnmatched;
import static ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher.MatchResult.buildUnsupported;
import static org.assertj.core.api.Assertions.assertThat;

/** Unit coverage for the deny-first HAPI rule chain. */
class PcmAuthorizationInterceptorTest {
    private static final Pointcut RESPONSE_POINTCUT = Pointcut.STORAGE_PREACCESS_RESOURCES;

    @Test
    void explicitMasterReadUsesTargetPolicyOutsidePatientCompartmentAndDeniesOtherInteractions() {
        for (String type : List.of("Organization", "Practitioner", "PractitionerRole", "Location")) {
            PcmReadGrant grant = PcmSmartScopeParser.parse("patient/" + type + ".r?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V", "patient-1").get(0);
            PcmAuthorizationInterceptor interceptor = interceptor(fixedContext(grant), (filter, resource) -> buildMatched());
            org.hl7.fhir.r4.model.Resource target = switch (type) {
                case "Organization" -> new org.hl7.fhir.r4.model.Organization();
                case "Practitioner" -> new org.hl7.fhir.r4.model.Practitioner();
                case "PractitionerRole" -> new org.hl7.fhir.r4.model.PractitionerRole();
                default -> new org.hl7.fhir.r4.model.Location();
            };
            target.setId(type + "/outside-compartment");
            SystemRequestDetails head = new SystemRequestDetails();
            head.setRestOperationType(RestOperationTypeEnum.READ); head.setResourceName(type);
            head.setRequestType(ca.uhn.fhir.rest.api.RequestTypeEnum.HEAD);
            assertThat(interceptor.buildRuleList(head)).hasSize(1);
            PcmAdmissionAuthorizationInterceptor admission = new PcmAdmissionAuthorizationInterceptor(fixedContext(grant));
            assertThat(admission.buildRuleList(head)).hasSize(1);
            assertThat(decision(interceptor, RestOperationTypeEnum.READ, type, target)).isEqualTo(PolicyEnum.ALLOW);
            PcmAuthorizationInterceptor restricted = interceptor(fixedContext(grant), (filter, resource) -> buildUnmatched());
            assertThat(decision(restricted, RestOperationTypeEnum.READ, type, target)).isEqualTo(PolicyEnum.DENY);
            for (RestOperationTypeEnum operation : List.of(RestOperationTypeEnum.SEARCH_TYPE, RestOperationTypeEnum.VREAD, RestOperationTypeEnum.HISTORY_INSTANCE)) {
                assertThat(decision(interceptor, operation, type, target)).isEqualTo(PolicyEnum.DENY);
            }
            assertThat(decision(interceptor, RestOperationTypeEnum.READ, "Patient", new Patient())).isEqualTo(PolicyEnum.DENY);
        }
    }

    @Test
    void rejectsMissingOrInvalidInternalContextByDefault() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                request -> { throw new SecurityException("bad signature"); },
                (filter, resource) -> buildMatched());

        assertThat(decision(interceptor, RestOperationTypeEnum.READ, new Patient())).isEqualTo(PolicyEnum.DENY);
    }

    @Test
    void allowsSupportedFilteredReadAndDeniesNonMatch() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                fixedContext(new PcmReadGrant("Observation", "status=final", null)),
                (filter, resource) -> "Observation?status=final".equals(filter)
                        && ((Observation) resource).getStatus() == Observation.ObservationStatus.FINAL
                        ? buildMatched() : buildUnmatched());

        Observation finalObservation = new Observation().setStatus(Observation.ObservationStatus.FINAL);
        Observation preliminary = new Observation().setStatus(Observation.ObservationStatus.PRELIMINARY);
        assertThat(decision(interceptor, RestOperationTypeEnum.READ, finalObservation)).isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(interceptor, RestOperationTypeEnum.READ, preliminary)).isEqualTo(PolicyEnum.DENY);
    }

    @Test
    void independentFilteredRulesHaveUnionSemantics() {
        SignedRequestContextVerifier context = request -> new PcmRequestContext("ho-a", "client", List.of(
                new PcmReadGrant("Observation", "status=final", null),
                new PcmReadGrant("Observation", "identifier=http://lab|B", null)));
        PcmAuthorizationInterceptor interceptor = interceptor(context, (filter, resource) ->
                filter.endsWith("identifier=http://lab|B") ? buildMatched() : buildUnmatched());

        assertThat(decision(interceptor, RestOperationTypeEnum.READ, new Observation())).isEqualTo(PolicyEnum.ALLOW);
        assertThat(interceptor.buildRuleList(new SystemRequestDetails())).hasSize(3);
    }

    @Test
    void resultFilterRetainsReadGrantDuringSearchForIncludedResources() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                request -> new PcmRequestContext("ho-a", "client", List.of(
                        new PcmReadGrant("Practitioner", null, null, java.util.Set.of('r')))),
                (filter, resource) -> buildMatched());

        assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation",
                new org.hl7.fhir.r4.model.Practitioner())).isEqualTo(PolicyEnum.ALLOW);
    }

    @Test
    void sameTypeReadGrantDoesNotBroadenFilteredSearchGrant() {
        SignedRequestContextVerifier context = request -> new PcmRequestContext("ho-a", "client", List.of(
                new PcmReadGrant("Observation", "status=final", null, Set.of('s')),
                new PcmReadGrant("Observation", null, null, Set.of('r'))));
        PcmAuthorizationInterceptor interceptor = interceptor(context, (filter, resource) ->
                ((Observation) resource).getStatus() == Observation.ObservationStatus.FINAL
                        ? buildMatched() : buildUnmatched());

        Observation finalObservation = new Observation().setStatus(Observation.ObservationStatus.FINAL);
        Observation preliminary = new Observation().setStatus(Observation.ObservationStatus.PRELIMINARY);

        assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation", finalObservation))
                .isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation", preliminary))
                .isEqualTo(PolicyEnum.DENY);
        assertThat(decision(interceptor, RestOperationTypeEnum.GET_PAGE, "Observation", preliminary))
                .isEqualTo(PolicyEnum.DENY);
        assertThat(decision(interceptor, RestOperationTypeEnum.HISTORY_TYPE, "Observation", preliminary))
                .isEqualTo(PolicyEnum.DENY);
        assertThat(decision(interceptor, RestOperationTypeEnum.READ, "Observation", preliminary))
                .isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(interceptor, RestOperationTypeEnum.VREAD, "Observation", preliminary))
                .isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(interceptor, RestOperationTypeEnum.HISTORY_INSTANCE, "Observation", preliminary))
                .isEqualTo(PolicyEnum.ALLOW);
    }

    @Test
    void mixedInteractionUnionIsOrderIndependentAndKeepsSearchScopeUnion() {
        for (List<PcmReadGrant> grants : List.of(
                List.of(
                        new PcmReadGrant("Observation", null, "patient-1", Set.of('r')),
                        new PcmReadGrant("Observation", "status=final", "patient-1", Set.of('s')),
                        new PcmReadGrant("Observation", "status=preliminary", "patient-1", Set.of('s'))),
                List.of(
                        new PcmReadGrant("Observation", "status=preliminary", "patient-1", Set.of('s')),
                        new PcmReadGrant("Observation", "status=final", "patient-1", Set.of('s')),
                        new PcmReadGrant("Observation", null, "patient-1", Set.of('r'))))) {
            PcmAuthorizationInterceptor interceptor = interceptor(
                    request -> new PcmRequestContext("ho-a", "client", grants),
                    (filter, resource) -> {
                        Observation observation = (Observation) resource;
                        String status = observation.getStatus().toCode();
                        return filter.endsWith("status=" + status) ? buildMatched() : buildUnmatched();
                    });

            Observation finalObservation = new Observation().setStatus(Observation.ObservationStatus.FINAL);
            finalObservation.setSubject(new org.hl7.fhir.r4.model.Reference("Patient/patient-1"));
            Observation preliminary = new Observation().setStatus(Observation.ObservationStatus.PRELIMINARY);
            preliminary.setSubject(new org.hl7.fhir.r4.model.Reference("Patient/patient-1"));
            Observation amended = new Observation().setStatus(Observation.ObservationStatus.AMENDED);
            amended.setSubject(new org.hl7.fhir.r4.model.Reference("Patient/patient-1"));

            assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation", finalObservation))
                    .isEqualTo(PolicyEnum.ALLOW);
            assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation", preliminary))
                    .isEqualTo(PolicyEnum.ALLOW);
            assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation", amended))
                    .isEqualTo(PolicyEnum.DENY);
            assertThat(decision(interceptor, RestOperationTypeEnum.READ, "Observation", amended))
                    .isEqualTo(PolicyEnum.ALLOW);
        }
    }

    @Test
    void searchReadGrantForAnotherTypeStillAuthorizesIncludedResource() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                request -> new PcmRequestContext("ho-a", "client", List.of(
                        new PcmReadGrant("Observation", "status=final", null, Set.of('s')),
                        new PcmReadGrant("Practitioner", null, null, Set.of('r')))),
                (filter, resource) -> buildMatched());

        assertThat(decision(interceptor, RestOperationTypeEnum.SEARCH_TYPE, "Observation",
                new org.hl7.fhir.r4.model.Practitioner())).isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(interceptor, RestOperationTypeEnum.GET_PAGE, "Observation",
                new org.hl7.fhir.r4.model.Practitioner())).isEqualTo(PolicyEnum.ALLOW);
    }

    @Test
    void patientCompartmentAndFilterProduceOneConjunctiveRule() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                fixedContext(new PcmReadGrant("Observation", "status=final", "patient-123")),
                (filter, resource) -> buildMatched());

        assertThat(interceptor.buildRuleList(new SystemRequestDetails()))
                .hasSize(2)
                .first().asString().contains("IN_COMPARTMENT", "status=final");
    }

    @Test
    void writesOperationsAndUnsupportedMatcherResultsFailClosed() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                fixedContext(new PcmReadGrant("Observation", "status=final", null)),
                (filter, resource) -> buildUnsupported("not representable"));

        assertThat(decision(interceptor, RestOperationTypeEnum.READ, new Observation())).isEqualTo(PolicyEnum.DENY);
        assertThat(decision(interceptor, RestOperationTypeEnum.CREATE, new Observation())).isEqualTo(PolicyEnum.DENY);
        assertThat(decision(interceptor, RestOperationTypeEnum.EXTENDED_OPERATION_TYPE, new Observation()))
                .isEqualTo(PolicyEnum.DENY);
    }

    @Test
    void pageHistoryAndIncludeResourcesAreRefilteredByTheSameRules() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                fixedContext(new PcmReadGrant("Observation", "status=final", null)),
                (filter, resource) -> resource instanceof Observation ? buildMatched() : buildUnmatched());

        for (RestOperationTypeEnum operation : List.of(
                RestOperationTypeEnum.GET_PAGE,
                RestOperationTypeEnum.HISTORY_INSTANCE,
                RestOperationTypeEnum.HISTORY_TYPE,
                RestOperationTypeEnum.SEARCH_TYPE)) {
            assertThat(decision(interceptor, operation, new Observation())).isEqualTo(PolicyEnum.ALLOW);
            assertThat(decision(interceptor, operation, new Patient())).isEqualTo(PolicyEnum.DENY);
        }
    }

    @Test
    void advancedExpressionRejectsTheWholeContextBeforeAnyAllowRule() {
        PcmAuthorizationInterceptor interceptor = interceptor(
                fixedContext(new PcmReadGrant("Observation", "subject.identifier=123", null)),
                (filter, resource) -> buildMatched());

        assertThat(interceptor.buildRuleList(new SystemRequestDetails()))
                .hasSize(1);
        assertThat(decision(interceptor, RestOperationTypeEnum.READ, new Observation()))
                .isEqualTo(PolicyEnum.DENY);
    }

    @Test
    void privateImportContextAllowsTransactionalWritesWithoutChangingDefaultDeny() {
        PcmAuthorizationInterceptor importer = interceptor(
                request -> new PcmRequestContext("ho-a", "clinical-data-loader", List.of(), true),
                (filter, resource) -> buildUnmatched());
        PcmAuthorizationInterceptor ordinary = interceptor(
                request -> new PcmRequestContext("ho-a", "client", List.of()),
                (filter, resource) -> buildUnmatched());

        assertThat(decision(importer, RestOperationTypeEnum.CREATE, new Observation())).isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(importer, RestOperationTypeEnum.TRANSACTION, new Observation())).isEqualTo(PolicyEnum.ALLOW);
        assertThat(decision(ordinary, RestOperationTypeEnum.CREATE, new Observation())).isEqualTo(PolicyEnum.DENY);
    }

    @Test
    void nativeEverythingMatchesRequireSearchAndTargetBoundaryEvenForBroadSystemGrant() {
        var context = new PcmRequestContext("ho-a", "client", List.of(
                new PcmReadGrant("Observation", "status=final", null, Set.of('s')),
                new PcmReadGrant("Observation", null, null, Set.of('r')),
                new PcmReadGrant("Practitioner", null, null, Set.of('r'))),
                PcmRequestContext.Kind.DATA_SOURCE_ACCESS, null, List.of(), null, false, null, "one");
        var filter = interceptor(request -> context, (query, resource) ->
                ((Observation) resource).getStatus() == Observation.ObservationStatus.FINAL ? buildMatched() : buildUnmatched());
        var request = new SystemRequestDetails(); request.setFhirContext(FhirContext.forR4Cached());
        request.setResourceName("Patient"); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        request.getUserData().put(PcmEverythingPolicy.ATTRIBUTE, new PcmEverythingPolicy.Target("one", Set.of("Observation")));
        for (String patient : List.of("one", "other")) for (var status : List.of(Observation.ObservationStatus.FINAL, Observation.ObservationStatus.PRELIMINARY)) {
            var observation = new Observation().setStatus(status).setSubject(new org.hl7.fhir.r4.model.Reference("Patient/" + patient));
            var verdict = filter.applyRulesAndReturnDecision(RestOperationTypeEnum.SEARCH_TYPE, request, null, null, observation, RESPONSE_POINTCUT);
            assertThat(verdict.getDecision()).isEqualTo(patient.equals("one") && status == Observation.ObservationStatus.FINAL ? PolicyEnum.ALLOW : PolicyEnum.DENY);
        }
        assertThat(filter.applyRulesAndReturnDecision(RestOperationTypeEnum.SEARCH_TYPE, request, null, null,
                new org.hl7.fhir.r4.model.Practitioner(), RESPONSE_POINTCUT).getDecision()).isEqualTo(PolicyEnum.DENY);
    }

    private static SignedRequestContextVerifier fixedContext(PcmReadGrant grant) {
        return request -> new PcmRequestContext("ho-a", "client", List.of(grant));
    }

    private static PcmAuthorizationInterceptor interceptor(
            SignedRequestContextVerifier verifier,
            IAuthorizationSearchParamMatcher matcher) {
        return new PcmAuthorizationInterceptor(verifier, matcher);
    }

    private static PolicyEnum decision(
            PcmAuthorizationInterceptor interceptor,
            RestOperationTypeEnum operation,
            org.hl7.fhir.instance.model.api.IBaseResource output) {
        return decision(interceptor, operation, output.fhirType(), output);
    }

    private static PolicyEnum decision(
            PcmAuthorizationInterceptor interceptor,
            RestOperationTypeEnum operation,
            String requestResourceType,
            org.hl7.fhir.instance.model.api.IBaseResource output) {
        SystemRequestDetails requestDetails = new SystemRequestDetails();
        requestDetails.setFhirContext(FhirContext.forR4Cached());
        requestDetails.setRestOperationType(operation);
        requestDetails.setResourceName(requestResourceType);
        return interceptor.applyRulesAndReturnDecision(
                operation,
                requestDetails,
                operation == RestOperationTypeEnum.CREATE ? output : null,
                output.getIdElement(),
                operation == RestOperationTypeEnum.CREATE ? null : output,
                RESPONSE_POINTCUT).getDecision();
    }
}
