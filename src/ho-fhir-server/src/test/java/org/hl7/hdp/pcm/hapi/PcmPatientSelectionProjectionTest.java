package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirResourceDao;
import ca.uhn.fhir.jpa.model.dao.JpaPid;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.param.TokenParam;
import jakarta.persistence.EntityManager;
import jakarta.persistence.TypedQuery;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;
import org.hl7.fhir.r4.model.Patient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Selective native probes and both link projections share one bounded, consistent transaction. */
class PcmPatientSelectionProjectionTest {
    final DaoRegistry registry = mock(DaoRegistry.class);
    @SuppressWarnings("unchecked") final IFhirResourceDao<Patient> dao = mock(IFhirResourceDao.class);
    final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    final TransactionStatus status = mock(TransactionStatus.class);
    final EntityManager entityManager = mock(EntityManager.class);
    final jakarta.persistence.Query isolation = mock(jakarta.persistence.Query.class);
    @SuppressWarnings("unchecked") final TypedQuery<String> local = mock(TypedQuery.class);
    @SuppressWarnings("unchecked") final TypedQuery<String> foreign = mock(TypedQuery.class);
    final PcmPageExecutor executor = new PcmPageExecutor(registry, transactions, entityManager, FhirContext.forR4Cached());
    final SystemRequestDetails request = new SystemRequestDetails();
    final SearchParameterMap client = new SearchParameterMap("_id", new TokenParam("linked"));
    final PcmCountCancellation cancellation = new PcmCountCancellation();
    final PcmPageExecutor.Budget budget = new PcmPageExecutor.Budget(10000, cancellation);

    PcmPatientSelectionProjectionTest() {
        request.setResourceName("Patient"); budget.request = request;
        when(registry.getResourceDao("Patient")).thenReturn(dao);
        when(transactions.getTransaction(any())).thenReturn(status);
        when(entityManager.createNativeQuery(anyString())).thenReturn(isolation);
        when(entityManager.createQuery(contains("myTargetResource.myResourceType"), eq(String.class))).thenReturn(local);
        when(entityManager.createQuery(contains("myTargetResourceUrl is not null"), eq(String.class))).thenReturn(foreign);
        for (var query : java.util.List.of(local, foreign)) {
            when(query.setParameter(anyString(), any())).thenReturn(query);
            when(query.setMaxResults(anyInt())).thenReturn(query);
        }
        when(local.getResultStream()).thenAnswer(call -> Stream.of("local"));
        when(foreign.getResultStream()).thenAnswer(call -> Stream.of("foreign"));
        PcmPageExecutor.CURRENT.set(budget);
    }

    @AfterEach void close() { PcmPageExecutor.CURRENT.remove(); budget.close(); executor.close(); }

    /** Exercise the exact projection owner with immutable typed native predicates. */
    Set<String> select() {
        return executor.referenceIds(request, budget, new PcmNativeMatchQueries.ReferenceSelection(
                Set.of("Patient.link.other"), Set.of("self"), true, client));
    }

    @Test void smallCompleteNativeSetRestrictsBothProjectionsAfterRepeatableReadBegins() {
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> Stream.of(JpaPid.fromId(42L))
                .peek(pid -> executor.foundId()));
        assertThat(select()).containsExactlyInAnyOrder("local", "foreign");
        var order = inOrder(entityManager, isolation, dao);
        order.verify(entityManager).createNativeQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        order.verify(isolation).executeUpdate();
        order.verify(dao).searchForIdStream(any(), any(), isNull());
        order.verify(entityManager).createQuery(contains("myTargetResource.myResourceType"), eq(String.class));
        order.verify(entityManager).createQuery(contains("myTargetResourceUrl is not null"), eq(String.class));
        verify(local).setParameter("sources", Set.of(42L)); verify(foreign).setParameter("sources", Set.of(42L));
        var definition = org.mockito.ArgumentCaptor.forClass(TransactionDefinition.class);
        verify(transactions).getTransaction(definition.capture());
        assertThat(definition.getValue().getPropagationBehavior()).isEqualTo(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        assertThat(definition.getValue().isReadOnly()).isTrue();
        assertThat(budget.ids.get()).isEqualTo(3);
        assertThat(client.getLoadSynchronousUpTo()).isNull();
    }

    @Test void emptyNativeIntersectionSkipsBothLinkProjections() {
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> Stream.empty());
        assertThat(select()).isEmpty();
        verify(entityManager, never()).createQuery(anyString(), eq(String.class));
        assertThat(budget.ids.get()).isZero();
    }

    @Test void incompleteProbeClosesAtThirtyThreeAndRetainsTheFullCompartmentCover() {
        var closed = new AtomicBoolean();
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> {
            SearchParameterMap nativeQuery = call.getArgument(0);
            assertThat(nativeQuery.getLoadSynchronousUpTo()).isEqualTo(33);
            return java.util.stream.LongStream.rangeClosed(1, 1000).mapToObj(JpaPid::fromId)
                    .peek(pid -> executor.foundId()).onClose(() -> closed.set(true));
        });
        assertThat(select()).containsExactlyInAnyOrder("local", "foreign");
        assertThat(closed).isTrue(); assertThat(budget.ids.get()).isEqualTo(35);
        verify(local, never()).setParameter(eq("sources"), any());
        verify(foreign, never()).setParameter(eq("sources"), any());
    }

    @Test void cancellationClosesProbeRollsBackAndStartsNoProjection() {
        var closed = new AtomicBoolean();
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> Stream.of(JpaPid.fromId(42L))
                .peek(pid -> { executor.foundId(); cancellation.cancel(); }).onClose(() -> closed.set(true)));
        assertThatThrownBy(this::select).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        assertThat(closed).isTrue(); verify(transactions).rollback(status);
        verify(entityManager, never()).createQuery(anyString(), eq(String.class));
    }

    @Test void rawDuplicateSaturationCannotMasqueradeAsACompleteSmallPidSet() {
        when(dao.searchForIdStream(any(), any(), isNull())).thenAnswer(call -> {
            // The pinned native iterator deduplicates after FOUND_ID observes each SQL row.
            for (int i = 0; i < 33; i++) executor.foundId();
            return Stream.of(JpaPid.fromId(42L));
        });
        assertThat(select()).containsExactlyInAnyOrder("local", "foreign");
        verify(local, never()).setParameter(eq("sources"), any());
        verify(foreign, never()).setParameter(eq("sources"), any());
        assertThat(budget.ids.get()).isEqualTo(35);
    }
}
