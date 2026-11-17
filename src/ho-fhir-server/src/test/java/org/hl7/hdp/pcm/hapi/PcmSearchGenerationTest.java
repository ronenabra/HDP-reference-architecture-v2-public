package org.hl7.hdp.pcm.hapi;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import static org.assertj.core.api.Assertions.*;

/** Transaction completion, active-writer exclusion and constant-space validity fences. */
class PcmSearchGenerationTest {
    @AfterEach void clear() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) TransactionSynchronizationManager.clearSynchronization();
    }
    @Test void oneTransactionRegistersOnceAndBothCommitAndRollbackInvalidate() {
        var generation = new PcmSearchGeneration();
        for (int status : new int[]{TransactionSynchronization.STATUS_COMMITTED, TransactionSynchronization.STATUS_ROLLED_BACK}) {
            long old = generation.begin();
            TransactionSynchronizationManager.initSynchronization();
            generation.writing(); generation.writing();
            var callbacks = TransactionSynchronizationManager.getSynchronizations();
            assertThat(callbacks).hasSize(1);
            assertThatThrownBy(generation::begin).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
            assertThatThrownBy(() -> generation.verify(old, true)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
            callbacks.forEach(callback -> callback.afterCompletion(status));
            TransactionSynchronizationManager.clearSynchronization();
            assertThat(generation.begin()).isGreaterThan(old);
            assertThatThrownBy(() -> generation.verify(old, false)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        }
    }
    @Test void independentlyCompletingOverlappingWritersCannotExposeAnIntermediateQuietGeneration() {
        var generation = new PcmSearchGeneration();
        TransactionSynchronizationManager.initSynchronization(); generation.writing();
        var first = TransactionSynchronizationManager.getSynchronizations().get(0);
        TransactionSynchronizationManager.clearSynchronization();
        TransactionSynchronizationManager.initSynchronization(); generation.writing();
        var second = TransactionSynchronizationManager.getSynchronizations().get(0);
        first.afterCompletion(TransactionSynchronization.STATUS_COMMITTED);
        assertThatThrownBy(generation::begin).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        second.afterCompletion(TransactionSynchronization.STATUS_COMMITTED);
        assertThatCode(generation::begin).doesNotThrowAnyException();
    }
    @Test void missingNativeTransactionLifecyclePermanentlyFailsClosed() {
        var generation = new PcmSearchGeneration(); long old = generation.begin();
        generation.writing();
        assertThatThrownBy(generation::begin).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException.class);
        assertThatThrownBy(() -> generation.verify(old, true)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
    }
}
