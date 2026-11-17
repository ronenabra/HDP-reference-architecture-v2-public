package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.servlet.ServletRequestDetails;
import jakarta.servlet.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import java.io.IOException;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/** Servlet lifecycle and HAPI observation only: never evaluates or changes clinical authority. */
public final class PcmRuntimeObservability implements Filter {
    private static final Logger LOG = LoggerFactory.getLogger(PcmRuntimeObservability.class);
    private static final String ATTRIBUTE = PcmRuntimeObservability.class.getName();
    private static final Pattern TRACE = Pattern.compile("00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})");
    private static final Pattern HINT = Pattern.compile("[A-Za-z0-9._:-]{1,256}");
    private static final ThreadLocal<Evaluation> EVALUATION = new ThreadLocal<>();
    private final Consumer<Map<String, Object>> sink;
    private final Clock clock;
    private final Instant detailStart, detailExpiry;
    private final boolean enabled = !"false".equalsIgnoreCase(System.getenv("PCM_HAPI_OBSERVABILITY_ENABLED"));

    /** The fixed private environment has absolute expiry, unaffected by restart or caller headers. */
    public PcmRuntimeObservability() {
        this(record -> { if ("HAPI_ERROR".equals(record.get("type"))) LOG.error("PCM_EVENT", record); else LOG.info("PCM_EVENT", record); }, Clock.systemUTC(), System.getenv("PCM_HAPI_DETAIL_STARTED_AT"), System.getenv("PCM_HAPI_DETAIL_EXPIRES_AT"));
    }
    PcmRuntimeObservability(Consumer<Map<String, Object>> sink, Clock clock, String start, String expiry) {
        this.sink = sink; this.clock = clock;
        start = start == null || start.isBlank() ? null : start;
        expiry = expiry == null || expiry.isBlank() ? null : expiry;
        if (start == null && expiry != null) throw new IllegalArgumentException("Private detail start is required");
        detailStart = start == null ? null : Instant.parse(start);
        detailExpiry = expiry == null ? (detailStart == null ? null : detailStart.plusSeconds(900)) : Instant.parse(expiry);
        if (detailStart != null && (!detailExpiry.isAfter(detailStart) || detailExpiry.isAfter(detailStart.plusSeconds(3600)))) throw new IllegalArgumentException("Detail lifetime must be positive and at most 60 minutes");
    }
    /** Effective state is observable independently of the viewer's Diagnostics display toggle. */
    public Map<String, Object> detailState() {
        return Map.of("enabled", detailEnabled(), "scope", System.getenv().getOrDefault("HO_ID", "unavailable"),
                "expiresAt", detailExpiry == null ? "disabled" : detailExpiry.toString(),
                "remainingMs", detailEnabled() ? detailExpiry.toEpochMilli() - clock.millis() : 0);
    }
    private boolean detailEnabled() { return enabled && detailStart != null && !clock.instant().isBefore(detailStart) && clock.instant().isBefore(detailExpiry); }

    @Override public void doFilter(ServletRequest input, ServletResponse output, FilterChain chain) throws IOException, ServletException {
        if (!enabled) { chain.doFilter(input, output); return; }
        if (!(input instanceof HttpServletRequest request) || !(output instanceof HttpServletResponse response)) { chain.doFilter(input, output); return; }
        State state = (State) request.getAttribute(ATTRIBUTE);
        if (state == null) {
            state = new State(this); request.setAttribute(ATTRIBUTE, state);
            state.fields.put("requestId", UUID.randomUUID().toString()); state.fields.put("method", request.getMethod());
            state.fields.put("url", request.getRequestURI() + (request.getQueryString() == null ? "" : "?" + request.getQueryString()));
            state.fields.put("correlationTrust", "caller-hint-not-authority");
            String trace = single(request, "traceparent"); var match = trace == null ? null : TRACE.matcher(trace);
            if (match != null && match.matches() && !match.group(1).matches("0+") && !match.group(2).matches("0+")) {
                state.fields.put("traceId", match.group(1)); state.fields.put("parentSpanId", match.group(2));
                state.fields.put("traceFlags", (Integer.parseInt(match.group(3), 16) & 1) == 1 ? "01" : "00");
            } else { state.fields.put("traceId", randomHex()); state.fields.put("traceFlags", "00"); state.fields.put("traceParent", trace == null ? "missing-unlinked" : "invalid-unlinked"); }
            state.fields.put("spanId", randomHex().substring(0, 16));
            for (String[] hint : new String[][]{{"x-correlation-id", "correlationId"}, {"x-flow-id", "flowId"}}) {
                String value = single(request, hint[0]); if (value != null && HINT.matcher(value).matches()) state.fields.put(hint[1], value);
            }
            String operation = single(request, "X-PCM-Operation-Id");
            if (operation != null && operation.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) state.fields.put("operationId", operation);
            state.fields.put("detailCollection", detailState()); emit(state, "HAPI_REQUEST", Map.of("outcome", "received"));
        }
        Map<String, String> previous = MDC.getCopyOfContextMap();
        try {
            MDC.clear();
            for (String key : new String[]{"traceId", "spanId", "parentSpanId", "flowId", "correlationId", "requestId"}) if (state.fields.get(key) instanceof String value) MDC.put(key, value);
            chain.doFilter(input, output);
        } catch (IOException | ServletException | RuntimeException failure) { state.error = failure; throw failure; }
        finally {
            if (previous == null) MDC.clear(); else MDC.setContextMap(previous);
            if (request.isAsyncStarted()) {
                State observed = state;
                try { request.getAsyncContext().addListener(new AsyncListener() {
                    @Override public void onComplete(AsyncEvent event) { terminal(observed, response); }
                    @Override public void onTimeout(AsyncEvent event) { observed.timeoutObserved = true; emit(observed, "HAPI_ASYNC_TIMEOUT", Map.of("outcome", "unknown", "completionObserved", false)); }
                    @Override public void onError(AsyncEvent event) { observed.asyncErrorObserved = true; observed.error = event.getThrowable(); }
                    @Override public void onStartAsync(AsyncEvent event) { event.getAsyncContext().addListener(this); }
                }); } catch (IllegalStateException completed) { terminal(state, response); }
            } else terminal(state, response);
        }
    }
    private static String single(HttpServletRequest request, String name) {
        var values = request.getHeaders(name); if (values == null || !values.hasMoreElements()) return null;
        String value = values.nextElement(); return values.hasMoreElements() ? null : value;
    }
    private static String randomHex() { return UUID.randomUUID().toString().replace("-", ""); }
    private void terminal(State state, HttpServletResponse response) {
        if (!state.terminal.compareAndSet(false, true)) return;
        Map<String, Object> result = new LinkedHashMap<>();
        boolean statusUnknown = !response.isCommitted() && (state.transportAborted || state.asyncErrorObserved
                || state.error != null && !(state.error instanceof ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException));
        result.put("status", statusUnknown ? null : response.getStatus());
        if (statusUnknown) { result.put("serverStatusBeforeFailure", response.getStatus()); result.put("statusUnavailableReason", "Response was not committed before an observed failure"); }
        result.put("responseCommitted", response.isCommitted());
        result.put("durationMs", (System.nanoTime() - state.started) / 1000000.0); result.put("completionObserved", true);
        result.put("outcome", state.transportAborted ? "abort-observed" : (state.error != null || state.asyncErrorObserved) ? "error" : response.getStatus() >= 400 ? "error-response" : "completed");
        result.put("abortObserved", state.transportAborted || state.error != null && state.error.getClass().getName().equals("org.apache.catalina.connector.ClientAbortException"));
        result.put("completionKind", "servlet-lifecycle"); result.put("nativeWorkState", state.nativeWorkState);
        if (state.error != null) { result.put("errorType", state.error.getClass().getName()); result.put("error", state.error.getMessage()); }
        state.budget.seal();
        String budgetStage = state.budget.stage();
        PcmBudgetFailure budget = state.budget.finish();
        if (budget != null && (response.getStatus() >= 400 || state.error != null || state.asyncErrorObserved || state.transportAborted)) {
            result.put("reasonCode", PcmBudgetFailure.REASON);
            result.put("budgetFailure", budget.fields()); result.put("budgetFailureStage", budgetStage);
            result.put("message", "HAPI_ERROR · " + PcmBudgetFailure.REASON + ": " + budget.message());
        }
        emit(state, "HAPI_RESULT_FILTER_SUMMARY", state.summary());
        emit(state, !state.transportAborted && !state.asyncErrorObserved && state.error == null && response.getStatus() < 400 ? "HAPI_RESPONSE" : "HAPI_ERROR", result);
    }
    /** Bind the native interaction only after HAPI has parsed it; pre-context failures still have receipt. */
    @Hook(value = Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED, order = -10000)
    public void parsed(RequestDetails request) {
        State state = state(request); if (!enabled || state == null) return;
        state.fields.put("interaction", request.getRestOperationType() == null ? "unknown" : request.getRestOperationType().name());
        if (request.getResourceName() != null) state.fields.put("resourceType", request.getResourceName());
    }
    /** Observe HAPI-handled exceptions even when the servlet chain returns normally. */
    @Hook(Pointcut.SERVER_HANDLE_EXCEPTION)
    public void error(RequestDetails request, ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException failure) { State state = state(request); if (state != null) { state.budget.seal(); state.error = failure; } }
    /** Record the existing native connection observer's actual transport failure, without inferring DB cancellation. */
    static void transportFailure(RequestDetails request, Throwable error, boolean abortObserved) {
        State state = state(request); if (state == null) return;
        state.budget.seal(); state.error = error; if (abortObserved) state.transportAborted = true;
    }
    static void nativeWorkStarted(RequestDetails request) { State state = state(request); if (state != null) state.nativeWorkState = "in-flight"; }
    static void nativeWorkFinished(RequestDetails request) {
        State state = state(request); if (state == null) return; state.nativeWorkState = "finished";
        if (state.terminal.get() || state.transportAborted || state.timeoutObserved) {
            state.owner.emit(state, "HAPI_NATIVE_WORK_FINISHED", Map.of("afterHttpCompletion", state.terminal.get(),
                    "afterObservedTimeout", state.timeoutObserved, "nativeWorkState", "finished",
                    "durationMs", (System.nanoTime() - state.started) / 1000000.0));
        }
    }
    /** Bind only the actual request state around existing worker execution; restore pooled threads. */
    static MdcScope attach(RequestDetails request) { return new MdcScope(state(request)); }
    static final class MdcScope implements AutoCloseable {
        final Map<String,String> previous = MDC.getCopyOfContextMap();
        MdcScope(State state) {
            MDC.clear();
            if (state != null) for (String key : new String[]{"traceId", "spanId", "parentSpanId", "flowId", "correlationId", "requestId"})
                if (state.fields.get(key) instanceof String value) MDC.put(key, value);
        }
        @Override public void close() { if (previous == null) MDC.clear(); else MDC.setContextMap(previous); }
    }
    static State state(RequestDetails request) {
        if (request == null) return null;
        try {
            Map<Object,Object> data = request.getUserData();
            if (data != null && data.get(ATTRIBUTE) instanceof State cached) return cached;
            if (request instanceof ServletRequestDetails servlet && servlet.getServletRequest() != null
                    && servlet.getServletRequest().getAttribute(ATTRIBUTE) instanceof State observed) {
                if (data != null) data.put(ATTRIBUTE, observed); return observed;
            }
        } catch (RuntimeException recycled) { /* A completed/recycled servlet cannot break native cleanup. */ }
        return null;
    }
    /** Emit a stage outcome from the actual owning enforcement path. */
    void decision(RequestDetails request, String event, String outcome, String reason, Map<String, Object> facts) {
        State state = state(request); if (!enabled || state == null) return;
        Map<String, Object> value = new LinkedHashMap<>(facts); value.put("outcome", outcome); value.put("reasonCode", reason); emit(state, event, value);
    }
    /** Coalesce resource-phase guard verdicts; primary admission remains one distinct event. */
    void admission(RequestDetails request, ca.uhn.fhir.interceptor.api.Pointcut pointcut, String outcome, String reason) {
        State state = state(request); if (state == null) return;
        String hook = pointcut == null ? "unknown" : pointcut.name();
        if (pointcut == Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED) {
            decision(request, "HAPI_ADMISSION", outcome, reason, Map.of("hook", hook, "stage", "admission"));
        } else synchronized (state) {
            if (state.guards.containsKey(hook) || state.guards.size() < 16) {
                Map<String,Long> counts = state.guards.computeIfAbsent(hook, key -> new LinkedHashMap<>());
                counts.merge(outcome, 1L, Long::sum);
            } else state.omittedGuardObservations++;
        }
    }
    /** Record a grant only where the existing result-rule builder has actually admitted its applicability. */
    static void applicableGrant(RequestDetails request, PcmReadGrant grant) {
        State state = state(request); if (state == null) return;
        Map<String,Object> value = new LinkedHashMap<>(); value.put("resourceType", grant.resourceType()); value.put("filter", grant.filter());
        value.put("patientId", grant.patientId()); value.put("interactions", grant.interactions().stream().sorted().map(String::valueOf).toList());
        try {
            String id = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(PcmBoundedJson.encode(value,65536)));
            value.put("ruleId", id);
            synchronized (state) { if (state.grants.size() < 100 || state.grants.containsKey(id)) state.grants.put(id,value); else state.omittedGrants++; }
        } catch (Exception unavailable) { synchronized (state) { state.omittedGrants++; } }
    }
    /** Attach bounded planner facts to the existing correlated filter summary without identity lists. */
    static void pageSelection(RequestDetails request, PcmRequestContext.Kind scenario, String reason) {
        State state = state(request); if (state == null) return;
        state.fields.put("nativeSelection", Map.of("contextClass", scenario.name(), "reason", reason));
    }

    /** Record actual request-owned work, including speculative native prefetch and residual visits. */
    static void pageWork(RequestDetails request, long ids, long bodies, int refills, long allocation,
            boolean completed, boolean cancelled) {
        State state = state(request); if (state == null) return;
        state.fields.put("pageWork", Map.of("candidateIdVisits", ids, "bodyVisits", bodies,
                "refills", refills, "allocatedBytes", allocation, "completed", completed, "cancelled", cancelled));
    }
    /** Count only the actual outgoing serialization boundary; never infer population totals. */
    static void outgoing(RequestDetails request, IBaseResource resource, boolean projected) {
        State state = state(request); if (state == null || resource == null) return;
        long returned = request.getRequestType() == ca.uhn.fhir.rest.api.RequestTypeEnum.HEAD ? 0 : resource instanceof org.hl7.fhir.r4.model.Bundle bundle ? bundle.getEntry().stream().filter(entry -> entry.getResource() != null).count() : 1;
        synchronized (state) { state.returned = returned; state.transformed = projected ? returned : 0; }
    }
    /** Scope actual native predicate observations to one existing resource evaluation. */
    static Evaluation beginEvaluation() { return beginEvaluation(true); }
    Evaluation beginResourceEvaluation() { return beginEvaluation(detailEnabled()); }
    private static Evaluation beginEvaluation(boolean collect) { Evaluation prior = EVALUATION.get(); EVALUATION.set(new Evaluation(prior, collect)); return EVALUATION.get(); }
    static void endEvaluation(Evaluation value) { if (value.prior == null) EVALUATION.remove(); else EVALUATION.set(value.prior); }
    static void predicate(String expression, String stage, boolean matched) {
        Evaluation value = EVALUATION.get(); if (value == null || !value.collect) return;
        if (value.predicates.size() >= 64) { value.omitted++; return; }
        String id;
        try { id = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(String.valueOf(expression).getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException unavailable) { return; }
        value.predicates.add(Map.of("ruleId", id, "expression", expression == null ? "none" : expression, "stage", stage, "matched", matched));
    }
    static final class Evaluation {
        final Evaluation prior; final boolean collect; final List<Map<String,Object>> predicates = new ArrayList<>(); int omitted;
        Evaluation(Evaluation prior, boolean collect) { this.prior = prior; this.collect = collect; }
    }
    /** Called exactly once after the existing Consent matcher; never repeats matching. */
    void resource(RequestDetails request, IBaseResource resource, boolean allowed, Evaluation evaluation) {
        State state = state(request); if (!enabled || state == null) return;
        synchronized (state) { state.examined++; if (allowed) state.allowed++; else state.removed++; }
        if (!detailEnabled()) return;
        Map<String, Object> facts = new LinkedHashMap<>(); facts.put("resourceType", resource.fhirType()); facts.put("resourceId", resource.getIdElement().getIdPart());
        facts.put("outcome", allowed ? "allow" : "remove"); facts.put("reasonCode", allowed ? "RESULT_ALLOWED" : "RESULT_REMOVED");
        facts.put("testedPredicates", evaluation.predicates); facts.put("omittedPredicates", evaluation.omitted);
        facts.put("preciseReasonAvailable", false); facts.put("unavailableReason", "Native authorization verdict does not expose every compartment/clause predicate");
        try {
            Map<String,Object> event = new LinkedHashMap<>(state.fields); event.putAll(facts); event.put("type", "HAPI_RESOURCE_DECISION");
            // Reserve bounded envelope/logger/thread overhead as well as the full explanation fields.
            byte[] encoded = PcmBoundedJson.encode(event, PcmBoundedJson.EXPLANATION_LIMIT - 2048);
            int accountedBytes = encoded.length + 2048;
            synchronized (state) {
                if (state.detailCount >= 100 || state.detailBytes + accountedBytes > 256 * 1024) { state.omitted++; state.omittedBytes += accountedBytes; return; }
                state.detailCount++; state.detailBytes += accountedBytes;
            }
            emit(state, "HAPI_RESOURCE_DECISION", facts);
        } catch (IOException tooLarge) { synchronized (state) { state.omitted++; state.omittedBytes += PcmBoundedJson.EXPLANATION_LIMIT + 1; } }
    }
    private void emit(State state, String event, Map<String, Object> fields) {
        try { Map<String, Object> value = new LinkedHashMap<>(state.fields); value.putAll(fields); value.put("type", event); value.put("visibility", "default"); sink.accept(value); }
        catch (RuntimeException unavailable) { /* Diagnostics must never affect clinical handling. */ }
    }
    static final class State {
        final PcmBudgetFailure.Capture budget = new PcmBudgetFailure.Capture();
        final PcmRuntimeObservability owner; State(PcmRuntimeObservability owner) { this.owner = owner; }
        final long started = System.nanoTime(); final Map<String, Object> fields = new java.util.concurrent.ConcurrentHashMap<>(); final AtomicBoolean terminal = new AtomicBoolean();
        volatile Throwable error; volatile boolean transportAborted, timeoutObserved, asyncErrorObserved; volatile String nativeWorkState = "not-observed"; long examined, allowed, removed, detailCount, detailBytes, omitted, omittedBytes, omittedGrants;
        long omittedGuardObservations; final Map<String,Map<String,Long>> guards = new LinkedHashMap<>();
        Long returned, transformed; final Map<String,Map<String,Object>> grants = new LinkedHashMap<>();
        synchronized Map<String, Object> summary() {
            Map<String, Object> value = new LinkedHashMap<>(); value.put("hook", "RuleFilteringConsentService.canSeeResource");
            value.put("filterHookObserved", examined > 0); value.put("examined", examined > 0 ? examined : null); value.put("allowed", examined > 0 ? allowed : null); value.put("removed", examined > 0 ? removed : null); value.put("returned", returned); value.put("transformed", transformed);
            value.put("applicableGrants", new ArrayList<>(grants.values())); value.put("omittedApplicableGrants", omittedGrants);
            value.put("nativeResourceGuardVerdicts", new LinkedHashMap<>(guards)); value.put("omittedGuardObservations", omittedGuardObservations);
            value.put("reasonCounts", Map.of("RESULT_ALLOWED", allowed, "RESULT_REMOVED", removed));
            value.put("grantApplicability", "r permits the existing read/history path; s permits primary search/page results. Includes use their actual applicable result rules.");
            value.put("returnedUnavailableReason", returned == null ? "Outgoing serialization cardinality was not observed" : "available at outgoing serialization hook");
            value.put("semantics", "Independent applicable grants form a union; predicates within one grant are conjunctive");
            value.put("detailByteAccounting", "encoded fields plus 2048-byte envelope reserve"); value.put("detailCount", detailCount); value.put("detailBytes", detailBytes); value.put("omittedCount", omitted); value.put("omittedBytes", omittedBytes); value.put("omittedBytesExact", false); value.put("omittedBytesNote", "Bounded encoded-byte accounting; an oversized item contributes a 65537-byte lower bound"); return value;
        }
    }
}
