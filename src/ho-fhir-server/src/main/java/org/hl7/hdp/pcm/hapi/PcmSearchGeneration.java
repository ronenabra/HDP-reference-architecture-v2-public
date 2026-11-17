package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.exceptions.ResourceGoneException;
import ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Constant-space validity fence for clinical writes through this single native HAPI instance. */
final class PcmSearchGeneration {
    private long generation;
    private int writers;
    private boolean unavailable;

    /** Track each writing transaction once, including transaction imports and rollbacks. */
    synchronized void writing() {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            // A previously unknown native write lifecycle cannot leave old totals trusted.
            unavailable = true;
            generation++;
            return;
        }
        if (TransactionSynchronizationManager.getSynchronizations().stream()
                .anyMatch(sync -> sync instanceof Mutation mutation && mutation.owner() == this)) return;
        Mutation mutation = new Mutation(this);
        TransactionSynchronizationManager.registerSynchronization(mutation);
        writers++;
        generation++;
    }

    /** Capture a quiet source before BOTH count and native membership/page evaluation. */
    synchronized long begin() {
        if (unavailable || writers != 0) throw busy();
        return generation;
    }

    /** A stable fence is the response's linearization point; no partial exact result may escape it. */
    synchronized void verify(long expected, boolean continuation) {
        if (unavailable || writers != 0 || generation != expected) {
            if (continuation) throw new ResourceGoneException("PCM accurate search changed; start a new search");
            throw busy();
        }
    }

    /** Completion invalidates even rolled-back writes conservatively and releases active-write exclusion. */
    private synchronized void completed() { generation++; writers--; }

    /** Native hooks run inside Spring's actual write transaction, not merely the surrounding HTTP request. */
    private record Mutation(PcmSearchGeneration owner) implements TransactionSynchronization {
        @Override public void afterCompletion(int status) { owner.completed(); }
    }

    /** Concurrent mutation is retryable; it is never an invented zero or silently omitted total. */
    private static UnclassifiedServerFailureException busy() {
        return new UnclassifiedServerFailureException(503, "PCM accurate search changed during evaluation; retry search");
    }
}
