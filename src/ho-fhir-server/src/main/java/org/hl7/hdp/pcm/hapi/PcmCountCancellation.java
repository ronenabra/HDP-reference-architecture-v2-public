package org.hl7.hdp.pcm.hapi;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Request-local cancellation shared by the servlet lifecycle and native query worker. */
public final class PcmCountCancellation {
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final AtomicReference<Runnable> nativeCancellation = new AtomicReference<>();

    /** Cancel any active JDBC operation, including a race with worker registration. */
    public void cancel() {
        cancelled.set(true);
        Runnable action = nativeCancellation.get();
        if (action != null) run(action);
    }

    /** Register Hibernate's thread-safe Session.cancelQuery for the isolated transaction. */
    void bind(Runnable action) {
        nativeCancellation.set(action);
        if (cancelled.get()) run(action);
    }

    /** Release the callback before the persistence session returns to its owner. */
    void unbind() { nativeCancellation.set(null); }

    /** A cancellation remains terminal even if no statement was active at that moment. */
    boolean isCancelled() { return cancelled.get(); }

    /** Query cancellation may race with normal statement completion. */
    private static void run(Runnable action) {
        try { action.run(); } catch (RuntimeException alreadyCompleted) { /* Cooperative checks still stop the worker. */ }
    }
}
