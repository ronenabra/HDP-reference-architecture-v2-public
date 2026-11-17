package org.hl7.hdp.pcm.hapi;

import org.hibernate.BaseSessionEventListener;
import org.slf4j.LoggerFactory;
import java.lang.management.ManagementFactory;

/** Per-execution native work and JVM allocation measurements, without resource identifiers. */
final class PcmCountMetrics extends BaseSessionEventListener {
    static final long MAX_ALLOCATED_BYTES = 256L * 1024 * 1024;
    ca.uhn.fhir.rest.api.server.RequestDetails request;
    PcmQueryLimits limits = PcmQueryLimits.DEFAULTS;
    private final java.util.function.LongSupplier allocation;
    private final long started = System.nanoTime();
    private final long initialAllocated;
    private long statements;
    long candidates;
    long nativeIdVisits;
    long materialized;
    int authorized;
    boolean nativeCount;
    boolean completed;

    /** The pinned JVM exposes exact thread allocation, distinct from whole-process RSS. */
    PcmCountMetrics() {
        this(allocationSupplier());
    }

    /** Deterministic allocation seam for budget tests independent of mock-framework allocations. */
    PcmCountMetrics(java.util.function.LongSupplier allocation) {
        this.allocation = allocation;
        initialAllocated = allocation.getAsLong();
    }

    /** Resolve the counter for the executing worker, rather than a servlet request thread. */
    private static java.util.function.LongSupplier allocationSupplier() {
        var bean = ManagementFactory.getThreadMXBean();
        if (!(bean instanceof com.sun.management.ThreadMXBean supported) || !supported.isThreadAllocatedMemorySupported()) {
            throw new IllegalStateException("PCM count allocation accounting unavailable");
        }
        if (!supported.isThreadAllocatedMemoryEnabled()) supported.setThreadAllocatedMemoryEnabled(true);
        long thread = Thread.currentThread().getId();
        return () -> supported.getThreadAllocatedBytes(thread);
    }

    /** Count actual native SQL executions for this isolated Hibernate session. */
    @Override public void jdbcExecuteStatementStart() { statements++; }

    /** Include batch executions if an upstream implementation changes its query mechanics. */
    @Override public void jdbcExecuteBatchStart() { statements++; }

    /** Cumulative request-thread heap allocations are bounded independently of global heap use. */
    long allocatedBytes() { return allocation.getAsLong() - initialAllocated; }

    /** Emit one bounded operational record for success, budget failure or cancellation. */
    void record(PcmCountCancellation cancellation) {
        LoggerFactory.getLogger(PcmCountMetrics.class).info(
                "PCM_COUNT_METRICS native={} elapsed_ms={} sql_statements={} candidates={} native_id_visits={} materialized={} authorized={} allocated_bytes={} cancelled={} completed={}",
                nativeCount, (System.nanoTime() - started) / 1_000_000, statements, candidates, nativeIdVisits,
                materialized, authorized, allocatedBytes(), cancellation.isCancelled(), completed);
    }
}
