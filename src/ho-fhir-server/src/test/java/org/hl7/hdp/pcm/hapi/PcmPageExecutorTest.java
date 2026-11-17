package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.IBundleProvider;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.IPagingProvider;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterEach;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exact advancement, authority restoration and explicit partial-work failures over native provider seams. */
class PcmPageExecutorTest {
    final DaoRegistry registry = mock(DaoRegistry.class);
    @SuppressWarnings("unchecked") final IFhirResourceDao<Observation> dao = mock(IFhirResourceDao.class);
    final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    final jakarta.persistence.EntityManager entityManager = mock(jakarta.persistence.EntityManager.class);
    final IBundleProvider provider = mock(IBundleProvider.class);
    final PcmPageExecutor executor = new PcmPageExecutor(registry, transactions, entityManager, FhirContext.forR4Cached());
    final PcmRequestContext context = new PcmRequestContext("ho-a", "client", List.of(new PcmReadGrant("Observation", null, "p")));
    PcmPageExecutorTest() {
        when(registry.getResourceDao("Observation")).thenReturn(dao);
        when(transactions.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        when(dao.search(any(SearchParameterMap.class), any())).thenReturn(provider);
        when(dao.searchForResources(any(SearchParameterMap.class), any())).thenAnswer(call -> List.of(observation("one"), observation("two")));
        when(provider.getUuid()).thenReturn("11111111-1111-1111-1111-111111111111");
        var statement = mock(jakarta.persistence.Query.class);
        when(entityManager.createNativeQuery(anyString())).thenReturn(statement);
        when(statement.setParameter(anyString(), any())).thenReturn(statement);
        when(entityManager.unwrap(org.hibernate.Session.class)).thenReturn(mock(org.hibernate.Session.class));
    }
    @AfterEach void closeDeadlineFacility() { executor.close(); }
    private SystemRequestDetails request() {
        var request = spy(new SystemRequestDetails());
        request.setResourceName("Observation"); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        request.setParameters(Map.of("_count", new String[]{"1"}));
        request.getUserData().put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, Instant.now().plusSeconds(30));
        doReturn("/fhir/Observation?_count=1").when(request).getHeader("X-PCM-Request-URI");
        doReturn("https://ho-a.example/fhir").when(request).getFhirServerBase();
        doReturn(new RestfulServer(FhirContext.forR4Cached())).when(request).getServer();
        executor.prepare(request, context);
        return request;
    }
    private Observation observation(String id) { return (Observation) new Observation().setId("Observation/" + id); }
    @Test void emptyNativeHoleAdvancesBeforeReturningUsefulPageAndPreservesExactOffset() {
        var request = request();
        when(provider.getResources(eq(0), eq(1), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2); return List.of();
        });
        when(provider.getResources(eq(1), eq(2), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2); return List.of(observation("two"));
        });
        var result = executor.page(request, context, new PcmCountCancellation());
        assertThat(result.getEntry()).hasSize(1); assertThat(result.getEntryFirstRep().getResource().getIdElement().getIdPart()).isEqualTo("two");
        assertThat(result.hasTotal()).isFalse(); assertThat(result.getLink("next").getUrl()).contains(".2.");
        verify(provider).getResources(eq(0), eq(1), any()); verify(provider).getResources(eq(1), eq(2), any());
    }
    @Test void emptyExhaustedProviderHasNoNextButUnboundedHolesFailExplicitly() {
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(0); return List.of();
        });
        var result = executor.page(request(), context, new PcmCountCancellation());
        assertThat(result.getEntry()).isEmpty(); assertThat(result.getLink("next")).isNull();
        doAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2); return List.of();
        }).when(provider).getResources(anyInt(), anyInt(), any());
        assertThatThrownBy(() -> executor.page(request(), context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class)
                .extracting(e -> ((ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException)e).getStatusCode()).isEqualTo(503);
    }
    @Test void providerOverflowCannotSilentlyTruncateAndSkipUnusedMatches() {
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2);
            return List.of(observation("one"), observation("two"));
        });
        assertThatThrownBy(() -> executor.page(request(), context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
    }
    @Test void missingAuthorityExpiryAndCancellationFailBeforePublishingEntries() {
        var request = request(); request.getUserData().remove(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE);
        assertThatThrownBy(() -> executor.page(request, context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
        var cancellation = new PcmCountCancellation(); cancellation.cancel();
        assertThatThrownBy(() -> executor.page(request(), context, cancellation))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        verify(dao, never()).search(any(SearchParameterMap.class), any());
    }

    @Test void nativeCandidateCoverKeepsOriginalBindingAndAccountsExceptionalIdsBeforeSearch() {
        var parser = mock(ca.uhn.fhir.jpa.searchparam.MatchUrlService.class);
        var counter = new PcmAuthorizedMatchExecutor(registry,
                mock(ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService.class), transactions,
                entityManager, FhirContext.forR4Cached(), parser);
        @SuppressWarnings("unchecked") var references = (jakarta.persistence.TypedQuery<String>) mock(jakarta.persistence.TypedQuery.class);
        when(entityManager.createQuery(anyString(), eq(String.class))).thenReturn(references);
        when(references.setParameter(anyString(), any())).thenReturn(references);
        when(references.setMaxResults(anyInt())).thenReturn(references);
        when(references.getResultStream()).thenReturn(java.util.stream.Stream.of("foreign"));
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(0); return List.of();
        });
        var request = request();
        try (var optimized = new PcmPageExecutor(registry, transactions, entityManager, FhirContext.forR4Cached(), counter)) {
            optimized.prepare(request, context);
            var result = optimized.page(request, context, new PcmCountCancellation());
            assertThat(result.getLink("self").getUrl()).endsWith("/Observation?_count=1");
        }
        var query = org.mockito.ArgumentCaptor.forClass(SearchParameterMap.class);
        var delegated = org.mockito.ArgumentCaptor.forClass(ca.uhn.fhir.rest.api.server.RequestDetails.class);
        verify(dao).search(query.capture(), delegated.capture());
        assertThat(query.getValue().get("_filter").get(0).get(0).getValueAsQueryToken(FhirContext.forR4Cached()))
                .contains("performer eq \"Patient/p\"", "subject eq \"Patient/p\"", "_id eq \"foreign\"");
        assertThat(request.getParameters()).containsOnlyKeys("_count");
        assertThat(delegated.getValue().getHeader("Cache-Control")).isEqualTo("no-cache");
        verify(references).setMaxResults(PcmPageExecutor.MAX_ID_VISITS + 1);
        verify(references).setParameter("paths", java.util.Set.of("Observation.performer", "Observation.subject"));
        verify(references).setParameter("absolute0", "%/Patient/p");
    }

    @Test void residualBudgetFailureClosesItsStreamBeforeNativeSearchAndNextRequestRecovers() {
        var counter = new PcmAuthorizedMatchExecutor(registry,
                mock(ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService.class), transactions,
                entityManager, FhirContext.forR4Cached(), mock(ca.uhn.fhir.jpa.searchparam.MatchUrlService.class));
        @SuppressWarnings("unchecked") var references = (jakarta.persistence.TypedQuery<String>) mock(jakarta.persistence.TypedQuery.class);
        when(entityManager.createQuery(anyString(), eq(String.class))).thenReturn(references);
        when(references.setParameter(anyString(), any())).thenReturn(references);
        when(references.setMaxResults(anyInt())).thenReturn(references);
        var closed = new java.util.concurrent.atomic.AtomicBoolean();
        when(references.getResultStream()).thenReturn(java.util.stream.Stream.generate(() -> "exceptional")
                .limit(PcmPageExecutor.MAX_ID_VISITS + 1).onClose(() -> closed.set(true)), java.util.stream.Stream.empty());
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(0); return List.of();
        });
        try (var optimized = new PcmPageExecutor(registry, transactions, entityManager, FhirContext.forR4Cached(), counter)) {
            var failed = request(); optimized.prepare(failed, context);
            assertThatThrownBy(() -> optimized.page(failed, context, new PcmCountCancellation()))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
            assertThat(closed).isTrue(); verify(dao, never()).search(any(SearchParameterMap.class), any());
            var recovered = request(); optimized.prepare(recovered, context);
            assertThat(optimized.page(recovered, context, new PcmCountCancellation()).getEntry()).isEmpty();
        }
        verify(dao).search(any(SearchParameterMap.class), any());
    }
    @Test void includesAndOutcomesHaveTheirOwnBoundsAndNeverConsumePrimarySlots() {
        var include = new org.hl7.fhir.r4.model.Practitioner(); include.setId("Practitioner/one");
        ca.uhn.fhir.model.api.ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.put(include,
                ca.uhn.fhir.model.valueset.BundleEntrySearchModeEnum.INCLUDE);
        var outcome = new org.hl7.fhir.r4.model.OperationOutcome();
        outcome.addIssue().setDiagnostics("private native diagnostic");
        doAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(1);
            return List.of(observation("one"), include, outcome);
        }).when(provider).getResources(anyInt(), anyInt(), any());
        var bundle = executor.page(request(), context, new PcmCountCancellation());
        assertThat(bundle.getEntry()).hasSize(3);
        assertThat(bundle.getEntry().stream().map(entry -> entry.getSearch().getMode()).toList())
                .containsExactly(org.hl7.fhir.r4.model.Bundle.SearchEntryMode.MATCH,
                    org.hl7.fhir.r4.model.Bundle.SearchEntryMode.INCLUDE, org.hl7.fhir.r4.model.Bundle.SearchEntryMode.OUTCOME);
        assertThat(((org.hl7.fhir.r4.model.OperationOutcome) bundle.getEntry().get(2).getResource()).getIssueFirstRep().getDiagnostics())
                .isEqualTo("PCM search outcome");
    }
    @Test void operationRefillsStaleNativeBodiesUsingOnlyFreshTypedGraphCandidateIds() {
        @SuppressWarnings("unchecked") var patientDao = (ca.uhn.fhir.jpa.api.dao.IFhirResourceDaoPatient<org.hl7.fhir.r4.model.Patient>) mock(ca.uhn.fhir.jpa.api.dao.IFhirResourceDaoPatient.class);
        when(registry.getResourceDao("Patient")).thenReturn(patientDao);
        when(patientDao.patientInstanceEverything(any(), any(), any(), any())).thenReturn(provider);
        var operationContext = new PcmRequestContext("ho-a", "client", context.readGrants(), PcmRequestContext.Kind.DATA_SOURCE_ACCESS,
                null, List.of(), null, false, null, "p");
        var request = request(); request.setResourceName("Patient"); request.setRequestPath("Patient/$everything");
        request.setRestOperationType(RestOperationTypeEnum.EXTENDED_OPERATION_TYPE);
        doReturn("/fhir/Patient/$everything?_count=1").when(request).getHeader("X-PCM-Request-URI");
        executor.prepare(request, operationContext);
        var old = observation("one"); var current = observation("two");
        ca.uhn.fhir.model.api.ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.put(old, ca.uhn.fhir.model.valueset.BundleEntrySearchModeEnum.MATCH);
        ca.uhn.fhir.model.api.ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.put(current, ca.uhn.fhir.model.valueset.BundleEntrySearchModeEnum.MATCH);
        when(dao.searchForResources(any(SearchParameterMap.class), any())).thenReturn(List.of(), List.of(current));
        when(provider.getResources(eq(0), eq(1), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2); return List.of(old);
        });
        when(provider.getResources(eq(1), eq(2), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(1); return List.of(current);
        });
        var result = executor.page(request, operationContext, new PcmCountCancellation());
        assertThat(result.getEntry()).singleElement().satisfies(entry -> assertThat(entry.getResource().getIdElement().getIdPart()).isEqualTo("two"));
        assertThat(result.getLink("next")).isNull();
        verify(dao, times(2)).translateRawParameters(anyMap(), any());
        verify(patientDao).patientInstanceEverything(isNull(), any(), any(), argThat(id -> "p".equals(id.getIdPart())));
    }

    @Test void nativeWorkLimitsFailEvenWhenAllCandidatesAreHidden() {
        var budget = new PcmPageExecutor.Budget(5000, new PcmCountCancellation());
        PcmPageExecutor.CURRENT.set(budget);
        try {
            for (int i = 0; i < PcmPageExecutor.MAX_ID_VISITS; i++) executor.foundId();
            assertThatThrownBy(executor::foundId).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        } finally { PcmPageExecutor.CURRENT.remove(); }
    }

    @Test void continuationRestoresPrimaryTypeAndNativeExpiryIsExplicitGone() {
        doAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2);
            return List.of(observation("one"));
        }).when(provider).getResources(anyInt(), anyInt(), any());
        var first = executor.page(request(), context, new PcmCountCancellation());
        String query = java.net.URI.create(first.getLink("next").getUrl()).getRawQuery();
        String cursor = query.substring("_getpages=".length(), query.indexOf("&_count="));
        var next = request(); next.setResourceName(null); next.setRestOperationType(RestOperationTypeEnum.GET_PAGE);
        next.setParameters(Map.of("_count", new String[]{"1"}, "_getpages", new String[]{cursor}));
        doReturn("/fhir?" + query).when(next).getHeader("X-PCM-Request-URI");
        executor.prepare(next, context);
        assertThat(next.getResourceName()).isEqualTo("Observation");
        RestfulServer server = mock(RestfulServer.class); IPagingProvider nativePaging = mock(IPagingProvider.class);
        doReturn(server).when(next).getServer(); when(server.getPagingProvider()).thenReturn(nativePaging);
        assertThatThrownBy(() -> executor.page(next, context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
        assertThat(PcmPageExecutor.CURRENT.get()).isNull();
    }

    @Test void actualPageRegistersTheEarlierVerifiedAuthorityDeadlineAndCleansUpAfterExpiry() throws Exception {
        var request = request();
        var cancellation = new PcmCountCancellation();
        var cancelled = new java.util.concurrent.CountDownLatch(1);
        doAnswer(call -> {
            cancellation.bind(cancelled::countDown);
            assertThat(cancelled.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            throw new IllegalStateException("native driver cancelled SQL");
        }).when(dao).search(any(SearchParameterMap.class), any());
        request.getUserData().put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, Instant.now().plusMillis(1300));
        long start = System.nanoTime();
        assertThatThrownBy(() -> executor.page(request, context, cancellation))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class)
                .extracting(failure -> ((ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException) failure).getStatusCode()).isEqualTo(503);
        assertThat(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start)).isLessThan(1500);
        assertThat(cancellation.isCancelled()).isTrue(); assertThat(PcmPageExecutor.CURRENT.get()).isNull();
        var late = mock(Runnable.class); cancellation.bind(late); verify(late).run(); cancellation.unbind();
    }

    @Test void completedBudgetIgnoresAnAlreadyDispatchedDeadlineCallback() {
        var timer = mock(java.util.concurrent.ScheduledExecutorService.class);
        var task = mock(java.util.concurrent.ScheduledFuture.class);
        doReturn(task).when(timer).schedule(any(Runnable.class), anyLong(), any(java.util.concurrent.TimeUnit.class));
        var budget = new PcmPageExecutor.Budget(5000, new PcmCountCancellation());
        budget.watchDeadline(timer); budget.close();
        var callback = org.mockito.ArgumentCaptor.forClass(Runnable.class);
        verify(timer).schedule(callback.capture(), anyLong(), eq(java.util.concurrent.TimeUnit.NANOSECONDS));
        callback.getValue().run(); assertThat(budget.cancellation.isCancelled()).isFalse();
        verify(task).cancel(false);
    }

    /** Captured refill reductions reject; a following request's increase permits the same work. */
    @Test void configuredRefillsUseOneRequestSnapshot() {
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            int offset = call.getArgument(0);
            ((PcmPageExecutor.Progress)call.getArgument(2)).setTotalRequestedResourcesFetched(offset == 0 ? 2 : 0);
            return offset == 0 ? List.of() : List.of(observation("one"));
        });
        var first = request(); first.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxPageRefills\":1}"));
        assertThatThrownBy(() -> executor.page(first, context, new PcmCountCancellation())).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        var next = request(); next.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxPageRefills\":2}"));
        assertThat(executor.page(next, context, new PcmCountCancellation()).getEntry()).hasSize(1);
        assertThat(PcmQueryLimits.from(first).maxPageRefills()).isEqualTo(1);
        assertThat(PcmBudgetFailure.capture(first).first()).isEqualTo(PcmBudgetFailure.of("maxPageRefills", 1, 2));
        assertThat(PcmBudgetFailure.capture(next).first()).isNull();
    }

    @Test void actualIdAndBodyEnforcementCaptureExactBoundaryAndPreserveFirstCause() {
        var request = request();
        request.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxPageIdVisits\":1,\"maxPageBodyVisits\":1}"));
        var access = mock(ca.uhn.fhir.rest.api.server.IPreResourceAccessDetails.class); when(access.size()).thenReturn(1);
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            executor.foundId(); executor.preAccess(request, access);
            assertThat(PcmBudgetFailure.capture(request).first()).isNull();
            assertThatThrownBy(() -> executor.preAccess(request, access)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
            executor.foundId(); return List.of();
        });
        assertThatThrownBy(() -> executor.page(request, context, new PcmCountCancellation())).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxPageBodyVisits", 1, 2));
        assertThat(PcmPageExecutor.CURRENT.get()).isNull();
    }

    @Test void uriRejectionCapturesCharactersButMissingBindingIsNotABudget() {
        var request = request(); request.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxQueryUriCharacters\":1}"));
        assertThatThrownBy(() -> executor.prepare(request, context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxQueryUriCharacters", 1, "/fhir/Observation?_count=1".length()));
        var missing = request(); doReturn(null).when(missing).getHeader("X-PCM-Request-URI");
        assertThatThrownBy(() -> executor.prepare(missing, context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        assertThat(PcmBudgetFailure.capture(missing).first()).isNull();
    }

    @Test void includeAndOutcomeExpansionCaptureTheirOwnExactLimits() {
        for (boolean outcomes : List.of(false, true)) {
            var request = request();
            request.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxPageIncludes\":1}"));
            var one = outcomes ? new org.hl7.fhir.r4.model.OperationOutcome() : new org.hl7.fhir.r4.model.Practitioner();
            var two = outcomes ? new org.hl7.fhir.r4.model.OperationOutcome() : new org.hl7.fhir.r4.model.Practitioner();
            one.setId("one"); two.setId("two");
            if (!outcomes) {
                ca.uhn.fhir.model.api.ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.put(one, ca.uhn.fhir.model.valueset.BundleEntrySearchModeEnum.INCLUDE);
                ca.uhn.fhir.model.api.ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.put(two, ca.uhn.fhir.model.valueset.BundleEntrySearchModeEnum.INCLUDE);
            }
            doAnswer(call -> { ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(0); return List.of(one, two); })
                    .when(provider).getResources(anyInt(), anyInt(), any());
            assertThatThrownBy(() -> executor.page(request, context, new PcmCountCancellation())).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
            assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxPageIncludes", 1, 2));
        }
    }

    @Test void productionTimerRetainsExactSharedDeadlineWithoutMillisecondTruncation() {
        long deadline = System.nanoTime() + 123456789L;
        try (var budget = new PcmPageExecutor.Budget(123, new PcmCountCancellation(), PcmQueryLimits.DEFAULTS, deadline)) {
            assertThat(budget.deadline).isEqualTo(deadline);
        }
    }

}
