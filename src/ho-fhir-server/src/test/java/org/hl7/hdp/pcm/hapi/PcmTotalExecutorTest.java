package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.IBundleProvider;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.IPagingProvider;
import ca.uhn.fhir.rest.server.RestfulServer;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

/** Exact-total provenance, unchanged continuation reuse and deterministic between-stage mutation failures. */
class PcmTotalExecutorTest {
    final DaoRegistry registry = mock(DaoRegistry.class);
    @SuppressWarnings("unchecked") final IFhirResourceDao<Observation> dao = mock(IFhirResourceDao.class);
    final IBundleProvider provider = mock(IBundleProvider.class);
    final PcmAuthorizedMatchExecutor counter = mock(PcmAuthorizedMatchExecutor.class);
    final org.springframework.transaction.PlatformTransactionManager transactions = mock(org.springframework.transaction.PlatformTransactionManager.class);
    final jakarta.persistence.EntityManager entityManager = mock(jakarta.persistence.EntityManager.class);
    final PcmPageExecutor pages = new PcmPageExecutor(registry, transactions, entityManager, FhirContext.forR4Cached(), counter);
    final PcmRequestContext context = new PcmRequestContext("ho-a", "client", List.of(new PcmReadGrant("Observation", null, "p")));
    final RestfulServer server = mock(RestfulServer.class);
    final IPagingProvider paging = mock(IPagingProvider.class);
    PcmTotalExecutorTest() {
        when(counter.pageSelection(any(), any(), any(), any())).thenAnswer(call ->
                new PcmNativeMatchQueries.PageSelection(call.getArgument(2), context.readGrants(), call.getArgument(2), "fixture"));
        when(registry.getResourceDao("Observation")).thenReturn(dao);
        when(transactions.getTransaction(any())).thenReturn(mock(org.springframework.transaction.TransactionStatus.class));
        when(entityManager.createNativeQuery(anyString())).thenReturn(mock(jakarta.persistence.Query.class));
        when(dao.search(any(SearchParameterMap.class), any())).thenReturn(provider);
        when(dao.searchForResources(any(SearchParameterMap.class), any())).thenReturn(List.of(observation()));
        when(provider.getUuid()).thenReturn("11111111-1111-1111-1111-111111111111");
        when(provider.getResources(anyInt(), anyInt(), any())).thenAnswer(call -> {
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(2);
            return List.of(observation());
        });
        when(counter.count(any(), eq(context), any())).thenReturn(3);
        when(server.getFhirContext()).thenReturn(FhirContext.forR4Cached());
        when(server.getDefaultResponseEncoding()).thenReturn(ca.uhn.fhir.rest.api.EncodingEnum.JSON);
        when(server.getPagingProvider()).thenReturn(paging);
        when(paging.retrieveResultList(any(), anyString())).thenReturn(provider);
    }
    @AfterEach void close() { pages.close(); }
    Observation observation() { return (Observation) new Observation().setId("Observation/one"); }
    SystemRequestDetails request(String uri, Map<String, String[]> parameters) {
        var request = spy(new SystemRequestDetails());
        request.setResourceName("Observation"); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        request.setParameters(parameters);
        request.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE, context);
        request.getUserData().put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, Instant.now().plusSeconds(30));
        doReturn(uri).when(request).getHeader("X-PCM-Request-URI");
        doReturn("https://ho-a.example/fhir").when(request).getFhirServerBase();
        doReturn(server).when(request).getServer();
        return request;
    }
    SystemRequestDetails first() {
        var request = request("/fhir/Observation?_count=1&_total=accurate", Map.of("_count", new String[]{"1"}, "_total", new String[]{"accurate"}));
        pages.prepare(request, context); return request;
    }
    SystemRequestDetails continuation(org.hl7.fhir.r4.model.Bundle bundle) {
        var uri = java.net.URI.create(bundle.getLink("next").getUrl());
        String cursor = uri.getRawQuery().split("&")[0].substring("_getpages=".length());
        var request = request("/fhir?" + uri.getRawQuery(), Map.of("_count", new String[]{"1"}, "_getpages", new String[]{cursor}));
        request.setRestOperationType(RestOperationTypeEnum.GET_PAGE); pages.prepare(request, context); return request;
    }
    void mutate() {
        TransactionSynchronizationManager.initSynchronization();
        try {
            pages.clinicalUpdated();
            TransactionSynchronizationManager.getSynchronizations().forEach(sync -> sync.afterCompletion(0));
        } finally { TransactionSynchronizationManager.clearSynchronization(); }
    }
    @Test void exactTotalPreservesEntriesAndValidContinuationReusesWithoutRecount() {
        var request = first();
        var first = pages.page(request, context, new PcmCountCancellation());
        assertThat(first.getTotal()).isEqualTo(3); assertThat(first.getEntry()).hasSize(1);
        new PcmResponsePolicyInterceptor().removeOrdinaryTotal(request, first);
        assertThat(first.getEntry()).hasSize(1); assertThat(first.getTotal()).isEqualTo(3);
        var next = pages.page(continuation(first), context, new PcmCountCancellation());
        assertThat(next.getTotal()).isEqualTo(3);
        verify(counter, times(1)).count(any(), eq(context), any());
        var query = org.mockito.ArgumentCaptor.forClass(SearchParameterMap.class);
        verify(dao, times(1)).search(query.capture(), any());
        assertThat(query.getValue().getSearchTotalMode()).isEqualTo(ca.uhn.fhir.rest.api.SearchTotalModeEnum.NONE);
        assertThat(request.getHeaders("Cache-Control")).isEmpty();
        var delegated = org.mockito.ArgumentCaptor.forClass(ca.uhn.fhir.rest.api.server.RequestDetails.class);
        verify(dao).search(any(SearchParameterMap.class), delegated.capture());
        assertThat(delegated.getValue().getHeaders("cache-control")).containsExactly("no-cache");
        assertThat(delegated.getValue().getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE)).isSameAs(context);
        assertThat(delegated.getValue()).isNotInstanceOf(SystemRequestDetails.class);
    }
    @Test void changedGenerationInvalidatesContinuationBeforeNativeWorkOrRecount() {
        var first = pages.page(first(), context, new PcmCountCancellation());
        mutate(); clearInvocations(dao, provider, counter);
        assertThatThrownBy(() -> pages.page(continuation(first), context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
        verifyNoInteractions(dao, provider, counter);
    }
    @Test void concurrentMutationBetweenSuccessfulCountAndPageFailsWholeRequest() {
        when(counter.count(any(), eq(context), any())).thenAnswer(call -> { mutate(); return 3; });
        var request = first();
        assertThatThrownBy(() -> pages.page(request, context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        assertThat(request.getUserData()).doesNotContainKey(PcmAuthorizedMatchExecutor.VERIFIED_PAGE_TOTAL);
    }
    @Test void mutationDuringPageFailsEvenAfterCountSucceeded() {
        doAnswer(call -> { mutate();
            ((PcmPageExecutor.Progress) call.getArgument(2)).setTotalRequestedResourcesFetched(1); return List.of(observation()); }).when(provider).getResources(anyInt(), anyInt(), any());
        assertThatThrownBy(() -> pages.page(first(), context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
    }
    @Test void countFailureNeverStartsPageAndPageFailureNeverPublishesTrustedTotal() {
        when(counter.count(any(), eq(context), any())).thenThrow(new IllegalStateException("count failed"));
        assertThatThrownBy(() -> pages.page(first(), context, new PcmCountCancellation())).hasMessage("count failed");
        verifyNoInteractions(provider); verify(dao, never()).search(any(SearchParameterMap.class), any());
        when(counter.count(any(), eq(context), any())).thenReturn(3);
        when(dao.search(any(SearchParameterMap.class), any())).thenThrow(new IllegalStateException("page failed"));
        var request = first();
        assertThatThrownBy(() -> pages.page(request, context, new PcmCountCancellation())).hasMessage("page failed");
        assertThat(request.getUserData()).doesNotContainKey(PcmAuthorizedMatchExecutor.VERIFIED_PAGE_TOTAL);
    }
    @Test void defaultsAndNoneHaveNoCounterOrGenerationCostAndUnknownModesReject() {
        for (var parameters : List.of(Map.<String,String[]>of("_count",new String[]{"1"}),
                Map.of("_count",new String[]{"1"},"_total",new String[]{"none"}))) {
            var request = request("/fhir/Observation?_count=1", parameters); pages.prepare(request, context);
            assertThat(pages.page(request, context, new PcmCountCancellation()).hasTotal()).isFalse();
        }
        verify(counter, never()).count(any(), any(), any());
        for (String invalid : List.of("estimate", "", "ACCURATE", "true"))
            assertThatThrownBy(() -> PcmPageRequestPolicy.accurate(Map.of("_total",new String[]{invalid})))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        assertThatThrownBy(() -> PcmPageRequestPolicy.accurate(Map.of("_total",new String[]{"accurate","accurate"})))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
    }
    @Test void countCancellationFailsBeforeAnyPageCanBeReturned() {
        var cancellation = new PcmCountCancellation();
        when(counter.count(any(), eq(context), any())).thenAnswer(call -> { cancellation.cancel(); return 3; });
        assertThatThrownBy(() -> pages.page(first(), context, cancellation))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        verify(dao, never()).search(any(SearchParameterMap.class), any());
    }
    @Test void activeNativeWriteRejectsBeforeEitherRequiredBranch() {
        TransactionSynchronizationManager.initSynchronization();
        try {
            pages.clinicalCreated();
            assertThatThrownBy(() -> pages.page(first(), context, new PcmCountCancellation()))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
            verifyNoInteractions(counter, provider);
        } finally {
            TransactionSynchronizationManager.getSynchronizations().forEach(sync -> sync.afterCompletion(1));
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test void verifiedAuthorityDeadlineRemainsActiveDuringTheCountBranch() {
        var request = first();
        request.getUserData().put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, Instant.now().plusMillis(1300));
        var cancellation = new PcmCountCancellation();
        var cancelled = new java.util.concurrent.CountDownLatch(1);
        when(counter.count(any(), eq(context), any())).thenAnswer(call -> {
            cancellation.bind(cancelled::countDown);
            assertThat(cancelled.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            return 3;
        });
        assertThatThrownBy(() -> pages.page(request, context, cancellation))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        assertThat(cancellation.isCancelled()).isTrue();
        verify(dao, never()).search(any(SearchParameterMap.class), any());
    }

    @Test void nestedCountFailureRetainsItsOwnMeasuredCauseThroughPageCleanupAndWrapping() {
        var request = first();
        when(counter.count(eq(request), eq(context), any())).thenAnswer(call -> {
            PcmQueryLimits.exceeded(request, "count", "maxCountCandidates", 2, 3);
            throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("nested count failed", new IllegalStateException("wrapped"));
        });
        assertThatThrownBy(() -> pages.page(request, context, new PcmCountCancellation()))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InternalErrorException.class);
        assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxCountCandidates", 2, 3));
        assertThat(PcmBudgetFailure.capture(request).stage()).isEqualTo("count");
        assertThat(PcmPageExecutor.CURRENT.get()).isNull();
        verify(dao, never()).search(any(SearchParameterMap.class), any());
    }

}
