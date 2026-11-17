package org.hl7.hdp.pcm.hapi;

import org.junit.jupiter.api.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.*;

/** Cancellation races and instrumentation counters are independent of servlet timing. */
class PcmCountCancellationTest {
    @Test void cancellationBeforeAndDuringNativeRegistrationIsTerminal() {
        PcmCountCancellation before = new PcmCountCancellation();
        AtomicInteger calls = new AtomicInteger();
        before.cancel(); before.bind(calls::incrementAndGet);
        assertThat(before.isCancelled()).isTrue(); assertThat(calls.get()).isEqualTo(1);
        before.unbind(); before.cancel(); assertThat(calls.get()).isEqualTo(1);
        PcmCountCancellation during = new PcmCountCancellation();
        during.bind(calls::incrementAndGet); during.cancel();
        assertThat(calls.get()).isEqualTo(2);
    }

    @Test void anAlreadyCompletedStatementDoesNotClearCancellation() {
        PcmCountCancellation token = new PcmCountCancellation();
        token.bind(() -> { throw new IllegalStateException("closed session"); });
        assertThatCode(token::cancel).doesNotThrowAnyException();
        assertThat(token.isCancelled()).isTrue();
    }

    @Test void allocationAccountingMeasuresOnlyTheCurrentExecutionDelta() {
        java.util.concurrent.atomic.AtomicLong allocated = new java.util.concurrent.atomic.AtomicLong(100);
        PcmCountMetrics metrics = new PcmCountMetrics(allocated::get);
        allocated.addAndGet(1024);
        assertThat(metrics.allocatedBytes()).isEqualTo(1024);
        metrics.jdbcExecuteStatementStart(); metrics.jdbcExecuteBatchStart();
        assertThatCode(() -> metrics.record(new PcmCountCancellation())).doesNotThrowAnyException();
    }
}
