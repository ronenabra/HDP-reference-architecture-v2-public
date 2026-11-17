package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.SummaryEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.api.server.IBundleProvider;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InternalErrorException;
import ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentOutcome;
import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Count execution, exactness, union and budget regressions with native DAO seams. */
class PcmAuthorizedMatchExecutorTest {
    final DaoRegistry registry = mock(DaoRegistry.class);
    @SuppressWarnings("unchecked") final IFhirResourceDao<Observation> dao = mock(IFhirResourceDao.class);
    final RuleFilteringConsentService matcher = mock(RuleFilteringConsentService.class);
    final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    final IBundleProvider provider = mock(IBundleProvider.class);
    final jakarta.persistence.EntityManager entityManager = mock(jakarta.persistence.EntityManager.class);
    final jakarta.persistence.Query statement = mock(jakarta.persistence.Query.class);
    final PcmAuthorizedMatchExecutor executor = new PcmAuthorizedMatchExecutor(registry, matcher, transactions, entityManager,
            () -> new PcmCountMetrics(() -> 0));

    PcmAuthorizedMatchExecutorTest() {
        when(registry.getResourceDao("Observation")).thenReturn(dao);
        when(transactions.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        when(dao.search(any(SearchParameterMap.class), any())).thenReturn(provider);
        when(entityManager.createNativeQuery(anyString())).thenReturn(statement);
        when(statement.setParameter(anyString(), any())).thenReturn(statement);
        when(entityManager.unwrap(org.hibernate.Session.class)).thenReturn(mock(org.hibernate.Session.class));
    }

    private SystemRequestDetails request() {
        SystemRequestDetails request = new SystemRequestDetails();
        request.setResourceName("Observation");
        request.getUserData().put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, Instant.now().plusSeconds(30));
        request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        request.setParameters(Map.of("_summary", new String[]{"count"}, "status", new String[]{"final", "amended"}));
        return request;
    }

    private PcmRequestContext context(PcmReadGrant... grants) {
        return new PcmRequestContext("ho-a", "client", List.of(grants));
    }

    @Test void unrestrictedSearchGrantUsesNativeAccurateCountWithoutMaterializing() {
        when(provider.size()).thenReturn(123456);
        assertThat(executor.count(request(), context(new PcmReadGrant("Observation", null, null, Set.of('s'))))).isEqualTo(123456);
        verify(dao).translateRawParameters(eq(Map.of("status", List.of("final", "amended"))), any());
        verify(dao).search(argThat(query -> query.getSummaryMode() == SummaryEnum.COUNT), any());
        verify(provider, never()).getResources(anyInt(), anyInt());
        verify(transactions).getTransaction(argThat(def -> def.isReadOnly()
                && def.getPropagationBehavior() == TransactionDefinition.PROPAGATION_REQUIRES_NEW));
        verify(transactions).commit(any());
    }

    @Test void explicitFiniteSearchGrantUsesNativeCountWithoutResidualPredicates() {
        var clinical = context(new PcmReadGrant("Observation", null, null, Set.of('s')));
        when(provider.size()).thenReturn(4);
        assertThat(executor.count(request(), clinical)).isEqualTo(4);
        verify(dao).search(argThat(query -> query.getSummaryMode() == SummaryEnum.COUNT), any());
        verifyNoInteractions(matcher);
    }

    /** Missing native aggregate authority must fail and release its transaction. */
    @Test void unknownNativeAggregateRollsBackWithoutPublishingZeroAndRecovers() {
        var grant = context(new PcmReadGrant("Observation", null, null));
        when(provider.size()).thenReturn(null, -1, 0);
        assertThatThrownBy(() -> executor.count(request(), grant)).isInstanceOf(InternalErrorException.class);
        assertThatThrownBy(() -> executor.count(request(), grant)).isInstanceOf(InternalErrorException.class);
        verify(transactions, times(2)).rollback(any());
        verify(transactions, never()).commit(any());
        assertThat(executor.count(request(), grant)).isZero();
        verify(transactions).commit(any());
    }

    /** A native stream failure after partial progress closes work and never commits its prefix. */
    @Test void nativeStreamFailureClosesRollsBackAndReleasesWorker() {
        var grant = context(new PcmReadGrant("Observation", null, "p"));
        var pid = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        var body = new Observation(); body.setId("Observation/one");
        when(dao.readByPid(pid)).thenReturn(body);
        when(matcher.canSeeResource(any(), any(), isNull())).thenReturn(ConsentOutcome.PROCEED);
        var closed = new java.util.concurrent.atomic.AtomicBoolean();
        var advanced = new java.util.concurrent.atomic.AtomicBoolean();
        var databaseFailure = new IllegalStateException("native stream interrupted");
        when(dao.searchForIdStream(any(), any(), isNull())).thenReturn(
                java.util.stream.Stream.<ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?>>of(pid, pid).<ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?>>map(value -> {
                    if (advanced.getAndSet(true)) throw databaseFailure;
                    return value;
                }).onClose(() -> closed.set(true)));
        assertThatThrownBy(() -> executor.count(request(), grant)).isSameAs(databaseFailure);
        assertThat(closed).isTrue();
        verify(transactions).rollback(any());
        verify(transactions, never()).commit(any());
        when(dao.searchForIdStream(any(), any(), isNull())).thenReturn(java.util.stream.Stream.empty());
        assertThat(executor.count(request(), grant)).isZero();
    }

    @Test void filteredGrantUnionCountsDistinctAuthorizedCurrentIdsOnly() {
        Observation one = new Observation(); one.setId("Observation/one/_history/2");
        Observation hidden = new Observation(); hidden.setId("Observation/hidden");
        Observation two = new Observation(); two.setId("Observation/two");
        var pid1 = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        var pid2 = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        var pid3 = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        when(dao.searchForIdStream(any(), any(), isNull())).thenReturn(java.util.stream.Stream.of(pid1, pid2, pid1, pid3));
        when(dao.readByPid(pid1)).thenReturn(one);
        when(dao.readByPid(pid2)).thenReturn(hidden);
        when(dao.readByPid(pid3)).thenReturn(two);
        when(matcher.canSeeResource(any(), any(), isNull())).thenReturn(ConsentOutcome.PROCEED);
        when(matcher.canSeeResource(any(), eq(hidden), isNull())).thenReturn(ConsentOutcome.REJECT);
        PcmReadGrant grant = new PcmReadGrant("Observation", "status=final", "patient");
        assertThat(executor.count(request(), context(grant, grant))).isEqualTo(2);
        verify(dao).searchForIdStream(argThat(query -> query.getIncludes().isEmpty() && query.getRevIncludes().isEmpty()), any(), isNull());
        verify(entityManager, times(4)).clear();
    }

    @Test void zeroRequiresCompletedSearchAndReadOnlyGrantNeverFallsBackToRead() {
        when(dao.searchForIdStream(any(), any(), isNull())).thenReturn(java.util.stream.Stream.empty());
        assertThat(executor.count(request(), context(new PcmReadGrant("Observation", null, "p")))).isZero();
        clearInvocations(dao);
        assertThatThrownBy(() -> executor.count(request(), context(new PcmReadGrant("Observation", null, null, Set.of('r')))))
                .isInstanceOf(ForbiddenOperationException.class);
        verifyNoInteractions(dao);
    }

    @Test void incompleteUnknownAndOverBudgetSearchesNeverReturnPartialCounts() {
        PcmRequestContext grant = context(new PcmReadGrant("Observation", null, "p"));
        var pid = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        Observation resource = new Observation(); resource.setId("Observation/one");
        when(dao.readByPid(pid)).thenReturn(resource);
        when(matcher.canSeeResource(any(), any(), isNull())).thenReturn(ConsentOutcome.PROCEED);
        java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();
        when(dao.searchForIdStream(any(), any(), isNull())).thenReturn(
                java.util.stream.Stream.<ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?>>generate(() -> pid)
                        .limit(100001).onClose(() -> closed.set(true)));
        assertThatThrownBy(() -> executor.count(request(), grant)).isInstanceOf(InternalErrorException.class);
        assertThat(closed.get()).isTrue();
        SystemRequestDetails expired = request();
        expired.getUserData().put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, Instant.now().minusSeconds(1));
        assertThatThrownBy(() -> executor.count(expired, grant)).isInstanceOf(InternalErrorException.class);
        Thread.currentThread().interrupt();
        try {
            assertThatThrownBy(() -> executor.count(request(), grant)).isInstanceOf(InternalErrorException.class);
        } finally { Thread.interrupted(); }
    }

    @Test void allocationBudgetRollsBackAndReleasesTheExecutionSlot() {
        java.util.concurrent.atomic.AtomicLong allocated = new java.util.concurrent.atomic.AtomicLong();
        PcmAuthorizedMatchExecutor measured = new PcmAuthorizedMatchExecutor(registry, matcher, transactions, entityManager,
                () -> new PcmCountMetrics(allocated::get));
        when(provider.size()).thenReturn(1);
        when(dao.search(any(SearchParameterMap.class), any())).thenAnswer(invocation -> {
            allocated.set(PcmCountMetrics.MAX_ALLOCATED_BYTES + 1); return provider;
        });
        PcmRequestContext grant = context(new PcmReadGrant("Observation", null, null));
        assertThatThrownBy(() -> measured.count(request(), grant)).isInstanceOf(InternalErrorException.class);
        verify(transactions).rollback(any());
        allocated.set(0);
        when(dao.search(any(SearchParameterMap.class), any())).thenReturn(provider);
        assertThat(measured.count(request(), grant)).isEqualTo(1);
        when(dao.search(any(SearchParameterMap.class), any())).thenAnswer(invocation -> { allocated.set(2); return provider; });
        var low = request(); low.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxAllocatedBytes\":1}"));
        assertThatThrownBy(() -> measured.count(low,grant)).isInstanceOf(InternalErrorException.class);
        allocated.set(0);
        var increased = request(); increased.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxAllocatedBytes\":2}"));
        assertThat(measured.count(increased,grant)).isEqualTo(1);
    }

    @Test void nativeCancellationReachesHibernateAndUnbindsAfterRollback() {
        PcmCountCancellation token = new PcmCountCancellation();
        org.hibernate.Session session = entityManager.unwrap(org.hibernate.Session.class);
        when(provider.size()).thenReturn(4);
        when(dao.search(any(SearchParameterMap.class), any())).thenAnswer(invocation -> {
            token.cancel(); return provider;
        });
        assertThatThrownBy(() -> executor.count(request(), context(new PcmReadGrant("Observation", null, null)), token))
                .isInstanceOf(InternalErrorException.class);
        verify(session).cancelQuery();
        verify(transactions).rollback(any());
        token.cancel();
        verify(session, times(1)).cancelQuery();
    }
    @Test void nativeLocalUnionMaterializesOnlyExceptionalReferencesAndUsesAuthoritativeMatcher() {
        var parser = mock(ca.uhn.fhir.jpa.searchparam.MatchUrlService.class);
        var optimized = new PcmAuthorizedMatchExecutor(registry, matcher, transactions, entityManager,
                ca.uhn.fhir.context.FhirContext.forR4Cached(), parser);
        var local = persistentId(1L);
        var mixed = persistentId(2L);
        var hidden = persistentId(3L);
        var foreign = persistentId(4L);
        var otherPatient = persistentId(5L);
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(invocation -> {
            SearchParameterMap query = invocation.getArgument(0);
            var parameter = query.containsKey("subject") ? query.get("subject").get(0).get(0)
                    : query.get("performer").get(0).get(0);
            var reference = (ca.uhn.fhir.rest.param.ReferenceParam) parameter;
            if (reference.getChain() != null) return java.util.stream.Stream.of(local, otherPatient);
            if (Boolean.FALSE.equals(reference.getMissing())) return query.containsKey("subject")
                    ? java.util.stream.Stream.of(local, foreign, otherPatient) : java.util.stream.Stream.of(mixed, hidden);
            return query.containsKey("subject") ? java.util.stream.Stream.of(local) : java.util.stream.Stream.empty();
        });
        Observation mixedBody = new Observation(); mixedBody.setId("Observation/mixed");
        Observation hiddenBody = new Observation(); hiddenBody.setId("Observation/hidden");
        Observation foreignBody = new Observation(); foreignBody.setId("Observation/foreign");
        when(dao.readByPid(mixed)).thenReturn(mixedBody);
        when(dao.readByPid(hidden)).thenReturn(hiddenBody);
        when(dao.readByPid(foreign)).thenReturn(foreignBody);
        when(matcher.canSeeResource(any(), any(), isNull())).thenReturn(ConsentOutcome.PROCEED);
        when(matcher.canSeeResource(any(), eq(hiddenBody), isNull())).thenReturn(ConsentOutcome.REJECT);
        assertThat(optimized.count(request(), context(new PcmReadGrant("Observation", null, "p")))).isEqualTo(3);
        verify(dao, never()).readByPid(local);
        verify(dao, never()).readByPid(otherPatient);
        verify(dao, times(3)).readByPid(any());
        verify(transactions).commit(any());
    }

    /** Distinct current persistent IDs supply deduplication without loading logical IDs/bodies. */
    private ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?> persistentId(long value) {
        var pid = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        when(pid.getId()).thenReturn(value);
        return pid;
    }

    /** Exact count uses its configured candidate bound over the same native stream. */
    @Test void configuredCandidateLimitAndIncreaseUseTheSameNativeStream() {
        var pid = mock(ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId.class);
        var body = new Observation(); body.setId("Observation/one");
        when(dao.readByPid(pid)).thenReturn(body);
        when(matcher.canSeeResource(any(), any(), isNull())).thenReturn(ConsentOutcome.PROCEED);
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> java.util.stream.Stream.of(pid,pid));
        var grant = context(new PcmReadGrant("Observation", null, "p"));
        var low = request(); low.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxCountCandidates\":1}"));
        assertThatThrownBy(() -> executor.count(low,grant)).isInstanceOf(InternalErrorException.class);
        assertThat(PcmBudgetFailure.capture(low).first()).isEqualTo(PcmBudgetFailure.of("maxCountCandidates", 1, 2));
        var next = request(); next.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxCountCandidates\":2}"));
        assertThat(executor.count(next,grant)).isEqualTo(1);
    }

    @Test void exactAllocationAboveTwoGiBIsMeasuredOnceAndEqualitySucceeds() {
        var allocated = new java.util.concurrent.atomic.AtomicLong();
        var measured = new PcmAuthorizedMatchExecutor(registry, matcher, transactions, entityManager,
                () -> new PcmCountMetrics(allocated::get));
        when(provider.size()).thenReturn(1);
        var limits = PcmQueryLimitsTest.limits("{\"maxAllocatedBytes\":2147483648}");
        var grant = context(new PcmReadGrant("Observation", null, null));
        var equal = request(); equal.getUserData().put(PcmQueryLimits.ATTRIBUTE, limits);
        when(dao.search(any(SearchParameterMap.class), any())).thenAnswer(call -> { allocated.set(2147483648L); return provider; });
        assertThat(measured.count(equal, grant)).isEqualTo(1); assertThat(PcmBudgetFailure.capture(equal).first()).isNull();
        allocated.set(0); var exceeded = request(); exceeded.getUserData().put(PcmQueryLimits.ATTRIBUTE, limits);
        when(dao.search(any(SearchParameterMap.class), any())).thenAnswer(call -> { allocated.set(2159627600L); return provider; });
        assertThatThrownBy(() -> measured.count(exceeded, grant)).isInstanceOf(InternalErrorException.class);
        assertThat(PcmBudgetFailure.capture(exceeded).first()).isEqualTo(PcmBudgetFailure.of("maxAllocatedBytes", 2147483648L, 2159627600L));
    }

    @Test void nativeIdBudgetCapturesActualStreamVisitsBeforeCandidateMaterialization() {
        var optimized = new PcmAuthorizedMatchExecutor(registry, matcher, transactions, entityManager,
                ca.uhn.fhir.context.FhirContext.forR4Cached(), mock(ca.uhn.fhir.jpa.searchparam.MatchUrlService.class));
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> java.util.stream.Stream.of(persistentId(1), persistentId(2)));
        var request = request(); request.getUserData().put(PcmQueryLimits.ATTRIBUTE, PcmQueryLimitsTest.limits("{\"maxCountNativeIdVisits\":1}"));
        assertThatThrownBy(() -> optimized.count(request, context(new PcmReadGrant("Observation", null, "p")))).isInstanceOf(InternalErrorException.class);
        assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxCountNativeIdVisits", 1, 2));
        verify(dao, never()).readByPid(any()); verify(transactions).rollback(any());
    }

}
