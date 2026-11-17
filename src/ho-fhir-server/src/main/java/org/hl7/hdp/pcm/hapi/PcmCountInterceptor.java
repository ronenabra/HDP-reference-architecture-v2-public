package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.RestfulServerUtils;
import ca.uhn.fhir.rest.server.servlet.ServletRequestDetails;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import java.io.IOException;
import java.util.Set;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.OperationOutcome;

/** Delegates explicit clinical counts before HAPI's ordinary Consent aggregate guard. */
public final class PcmCountInterceptor implements AutoCloseable {
    private final SignedRequestContextVerifier verifier;
    private final PcmRoutePolicyInterceptor routes;
    private final PcmAuthorizedMatchExecutor executor;
    private PcmPageExecutor pages;
    private final Function<jakarta.servlet.http.HttpServletRequest, PcmCountConnection> connections;
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(0, 32, 60, TimeUnit.SECONDS,
            new SynchronousQueue<>(), runnable -> {
                Thread worker = new Thread(runnable, "pcm-exact-count");
                worker.setDaemon(true);
                return worker;
            }, new ThreadPoolExecutor.AbortPolicy());
    private final PcmQueryAdmission admission = new PcmQueryAdmission();
    private final ScheduledThreadPoolExecutor observer = new ScheduledThreadPoolExecutor(1, runnable -> {
        Thread thread = new Thread(runnable, "pcm-count-connection"); thread.setDaemon(true); return thread;
    });

    /** Retain original signature, route and scope validation before any native DAO access. */
    public PcmCountInterceptor(SignedRequestContextVerifier verifier, PcmRoutePolicyInterceptor routes,
            PcmAuthorizedMatchExecutor executor) {
        this(verifier, routes, executor, PcmCountTomcatProtocol::connection);
    }

    /** Share the already qualified bounded transport lifecycle with ordinary native page retrieval. */
    public PcmCountInterceptor(SignedRequestContextVerifier verifier, PcmRoutePolicyInterceptor routes,
            PcmAuthorizedMatchExecutor executor, PcmPageExecutor pages) {
        this(verifier, routes, executor);
        this.pages = pages;
    }

    /** Inject the native connection seam for lifecycle tests without faking transport proof. */
    PcmCountInterceptor(SignedRequestContextVerifier verifier, PcmRoutePolicyInterceptor routes,
            PcmAuthorizedMatchExecutor executor,
            Function<jakarta.servlet.http.HttpServletRequest, PcmCountConnection> connections) {
        this.verifier = verifier; this.routes = routes; this.executor = executor; this.connections = connections;
        observer.setRemoveOnCancelPolicy(true);
    }

    /** Short circuit only verified GET/form-POST type searches; ordinary Consent remains installed. */
    @Hook(Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED)
    public boolean count(RequestDetails request) throws IOException {
        final PcmRequestContext context;
        try { context = verifier.verify(request); }
        catch (RuntimeException rejected) {
            throw new ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException("PCM context required");
        }
        // Native HEAD retains its own authorization/Consent path and never starts a GET worker.
        // Verify the original signed request first, including its method and untouched query.
        if (request.getRequestType() == ca.uhn.fhir.rest.api.RequestTypeEnum.HEAD) return true;
        boolean clinical = context.kind() == PcmRequestContext.Kind.DATA_SOURCE_ACCESS;
        boolean simulation = context.kind() == PcmRequestContext.Kind.UNFILTERED_SIMULATION;
        if (!clinical && !simulation) return true;
        boolean everything = PcmEverythingPolicy.isPath(request.getRequestPath());
        boolean exactCount = !everything && PcmCountRequestPolicy.isCount(request.getParameters());
        boolean page = !exactCount && pages != null
                && (request.getRestOperationType() == RestOperationTypeEnum.SEARCH_TYPE
                    || request.getRestOperationType() == RestOperationTypeEnum.GET_PAGE || everything);
        if (!clinical && exactCount || !exactCount && !page) return true;
        if (page) pages.prepare(request, context);
        routes.enforce(request, request.getRestOperationType());
        boolean postSearch = request.getRequestType() == ca.uhn.fhir.rest.api.RequestTypeEnum.POST
                && request.getRestOperationType() == RestOperationTypeEnum.SEARCH_TYPE
                && (request.getResourceName() + "/_search").equals(request.getRequestPath());
        if ((!page && request.getRestOperationType() != RestOperationTypeEnum.SEARCH_TYPE)
                || request.getRequestType() != ca.uhn.fhir.rest.api.RequestTypeEnum.GET && !postSearch
                || !everything && request.getRestOperationType() == RestOperationTypeEnum.SEARCH_TYPE
                    && !request.getResourceName().equals(request.getRequestPath()) && !postSearch) {
            throw new ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException("PCM count requires type search");
        }
        if (!(request instanceof ServletRequestDetails servlet) || !servlet.getServletRequest().isAsyncSupported()) {
            throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("PCM count async lifecycle unavailable");
        }
        var input = servlet.getServletRequest();
        if (postSearch) {
            String media = input.getContentType();
            if (media == null || !media.split(";", 2)[0].trim().equalsIgnoreCase("application/x-www-form-urlencoded")) {
                throw new ca.uhn.fhir.rest.server.exceptions.InvalidRequestException("PCM POST search requires a form");
            }
            // HAPI has already consumed and combined the form with URL parameters.
            // Consume cached request contents before observing additional connection input.
            request.loadRequestContents();
        } else if (input.getContentLengthLong() > 0 || input.getHeader("Transfer-Encoding") != null
                || !input.getInputStream().isFinished()) {
            throw new ca.uhn.fhir.rest.server.exceptions.InvalidRequestException("PCM count requires a bodyless GET");
        }
        if (PcmEverythingPolicy.target(request) != null) request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        PcmCountConnection connection = connections.apply(input);
        AsyncContext async = input.startAsync();
        PcmQueryLimits limits = PcmQueryLimits.from(request);
        Object expiry = request.getUserData().get(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE);
        long outerMillis = expiry instanceof java.time.Instant instant
                ? Math.min(limits.timeoutMilliseconds(), instant.toEpochMilli() - System.currentTimeMillis()) : 0;
        if (outerMillis <= 1000) { failure(request, exactCount ? 500 : 503); complete(async); return false; }
        PcmQueryLimits.deadline(request, (java.time.Instant) expiry);
        async.setTimeout(outerMillis);
        PcmRuntimeObservability.nativeWorkStarted(request);
        Execution execution = new Execution(request, context, connection, async, exactCount);
        execution.reservation = admission.acquire(limits.maxConcurrentQueries(), request);
        if (execution.reservation == null) { execution.fail(503, false); return false; }
        try {
            async.addListener(execution);
            Future<?> worker = workers.submit(execution);
            execution.worker.set(worker);
            if (execution.cancellation.isCancelled()) execution.cancelWorker(worker);
            execution.monitor.set(observer.scheduleWithFixedDelay(execution::observe, 25, 25, TimeUnit.MILLISECONDS));
            // A very small native count can finish before its registration is published.
            if (execution.responded.get()) execution.stopObserving();
        } catch (java.util.concurrent.RejectedExecutionException saturated) {
            execution.fail(503, false);
        } catch (RuntimeException unavailable) {
            execution.fail(500, false);
        }
        return false;
    }

    /** One bounded worker and observer registration, sharing the connector lock for terminal transitions. */
    private final class Execution implements Runnable, AsyncListener {
        private final RequestDetails request;
        private final PcmRequestContext context;
        private final PcmCountConnection connection;
        private final AsyncContext async;
        private final PcmCountCancellation cancellation = new PcmCountCancellation();
        private final AtomicBoolean responded = new AtomicBoolean();
        private final AtomicReference<Future<?>> worker = new AtomicReference<>();
        private final AtomicReference<ScheduledFuture<?>> monitor = new AtomicReference<>();
        private volatile boolean nativeWorkFinished;
        private PcmQueryAdmission.Reservation reservation;
        private boolean started;
        private boolean cancelledBeforeStart;
        private final boolean exactCount;

        /** Bind this execution to the already verified request and its original native connection. */
        Execution(RequestDetails request, PcmRequestContext context, PcmCountConnection connection, AsyncContext async, boolean exactCount) {
            this.request = request; this.context = context; this.connection = connection; this.async = async; this.exactCount = exactCount;
        }

        /** Run the isolated transaction before acquiring the connector lock to publish a terminal result. */
        @Override public void run() {
            synchronized (this) { if (cancelledBeforeStart) return; started = true; }
            try (var requestContext = PcmRuntimeObservability.attach(request)) { runObserved(); }
            finally { reservation.close(); }
        }

        private void runObserved() {
            try {
                Bundle result;
                try {
                    if (exactCount) {
                        int total = executor.count(request, context, cancellation);
                        request.getUserData().put(PcmAuthorizedMatchExecutor.VERIFIED_TOTAL, total);
                        result = new Bundle().setType(Bundle.BundleType.SEARCHSET).setTotal(total);
                    } else result = pages.page(request, context, cancellation);
                } finally { nativeWorkFinished = true; PcmRuntimeObservability.nativeWorkFinished(request); }
                var lock = connection.lock(); lock.lock();
                try {
                    if (!responded.get()) {
                        if (connection.hasAdditionalInput()) fail(503, true);
                        else if (responded.compareAndSet(false, true)) success(request, result);
                    }
                } finally { lock.unlock(); }
            } catch (RuntimeException failed) {
                int status = failed instanceof ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException response
                        ? response.getStatusCode() : 500;
                fail(status, false);
            } catch (IOException disconnected) {
                PcmRuntimeObservability.transportFailure(request, disconnected, disconnected instanceof org.apache.catalina.connector.ClientAbortException);
                responded.set(true); cancel();
            } finally { finish(); }
        }

        /** Nonblocking observation retains bytes in Tomcat and imposes a COUNT-only pipeline limit. */
        void observe() {
            var lock = connection.lock(); lock.lock();
            try {
                if (responded.get()) return;
                try {
                    if (PcmQueryLimits.deadlineReached(request)) {
                        PcmQueryLimits.timedOut(request); fail(exactCount ? 500 : 503, false); return;
                    }
                    if (connection.hasAdditionalInput()) fail(503, true);
                } catch (IOException disconnected) {
                    PcmRuntimeObservability.transportFailure(request, disconnected, true);
                    responded.set(true); cancel(); finish();
                } catch (RuntimeException unavailable) {
                    fail(500, false);
                }
            } finally { lock.unlock(); }
        }

        /** Complete a failed request once; successful status/headers have never been committed. */
        void fail(int status, boolean closeConnection) {
            var lock = connection.lock(); lock.lock();
            try {
                if (!responded.compareAndSet(false, true)) return;
                cancel();
                if (closeConnection && request instanceof ServletRequestDetails servlet) {
                    servlet.getServletResponse().setHeader("Connection", "close");
                    servlet.getServletResponse().setHeader("Retry-After", "1");
                }
                if (status == 503 && request instanceof ServletRequestDetails servlet) {
                    servlet.getServletResponse().setHeader("Retry-After", "1");
                }
                try { failure(request, status); } catch (IOException disconnected) { /* Native work is cancelled. */ }
                finally { finish(); }
            } finally { lock.unlock(); }
        }

        /** Handle native cancellation racing with bounded worker submission. */
        void cancel() {
            var captured = PcmBudgetFailure.capture(request);
            if (captured != null) captured.seal();
            cancellation.cancel();
            synchronized (this) {
                if (!started) { cancelledBeforeStart = true; if (reservation != null) reservation.close(); }
            }
            Future<?> submitted = worker.get(); if (submitted != null) cancelWorker(submitted);
            stopObserving();
        }

        /** Never interrupt terminal response serialization after native work has already unwound. */
        void cancelWorker(Future<?> submitted) {
            // This also covers cancellation before submit publishes its Future. Interrupting
            // a finished worker here can truncate the OperationOutcome partway through JSON.
            submitted.cancel(!nativeWorkFinished);
        }

        /** Eager removal prevents completed requests accumulating in the observer's delay queue. */
        void stopObserving() {
            ScheduledFuture<?> task = monitor.get(); if (task != null) task.cancel(false);
        }

        /** Serialize completion with observation and response output; repeated completion is harmless. */
        void finish() {
            var lock = connection.lock(); lock.lock();
            try { stopObserving(); complete(async); } finally { lock.unlock(); }
        }

        /** Container completion releases every registration and any remaining authority. */
        @Override public void onComplete(AsyncEvent event) { responded.set(true); cancel(); }
        /** Reported errors supplement native transport observation. */
        @Override public void onError(AsyncEvent event) { responded.set(true); cancel(); finish(); }
        /** Preserve explicit FHIR failure rather than a partial count on timeout. */
        @Override public void onTimeout(AsyncEvent event) {
            var lock = connection.lock(); lock.lock();
            try {
                if (responded.get()) return;
                PcmQueryLimits.timedOut(request);
                fail(exactCount ? 500 : 503, false);
            } finally { lock.unlock(); }
        }
        /** This delegate never starts another asynchronous dispatch. */
        @Override public void onStartAsync(AsyncEvent event) { responded.set(true); cancel(); }
    }

    /** Serialize only the server-produced exact total after the transaction completes. */
    private static void success(RequestDetails request, Bundle result) throws IOException {
        PcmRuntimeObservability.outgoing(request, result, false);
        RestfulServerUtils.streamResponseAsResource(request.getServer(), result, Set.of(), 200, false, false, request);
    }

    /** Async failures bypass HAPI's synchronous exception hook, so construct the safe outcome here. */
    private static void failure(RequestDetails request, int status) throws IOException {
        OperationOutcome outcome = new OperationOutcome();
        outcome.addIssue().setSeverity(OperationOutcome.IssueSeverity.ERROR)
                .setCode(OperationOutcome.IssueType.PROCESSING).setDiagnostics("PCM clinical read could not complete");
        RestfulServerUtils.streamResponseAsResource(request.getServer(), outcome, Set.of(), status, false, false, request);
    }

    /** Completion and a transport event may race after the response writer closes. */
    private static void complete(AsyncContext async) {
        try { async.complete(); } catch (IllegalStateException alreadyComplete) { /* No worker remains authorized. */ }
    }

    /** Stop both bounded lifecycle facilities when this HAPI application shuts down. */
    @Override public void close() { observer.shutdownNow(); workers.shutdownNow(); if (pages != null) pages.close(); }
}
