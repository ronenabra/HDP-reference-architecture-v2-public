package org.hl7.hdp.pcm.hapi;

/** No-wait reservations compare current usage against each newly captured request limit. */
final class PcmQueryAdmission {
    private int active;
    /** A decrease leaves existing owners running; an increase immediately admits more owners. */
    Reservation acquire(int maximum) { return acquire(maximum, null); }
    /** Publish the actual active occupancy when a captured request is refused, before logging. */
    synchronized Reservation acquire(int maximum, ca.uhn.fhir.rest.api.server.RequestDetails request) {
        if (active >= maximum) { PcmQueryLimits.exceeded(request, "query-admission", "maxConcurrentQueries", maximum, active); return null; }
        active++; return new Reservation();
    }
    /** Idempotent release handles success, rejection and cancellation races. */
    final class Reservation implements AutoCloseable {
        private boolean released;
        @Override public void close() {
            synchronized (PcmQueryAdmission.this) { if (!released) { released = true; active--; } }
        }
    }
}
