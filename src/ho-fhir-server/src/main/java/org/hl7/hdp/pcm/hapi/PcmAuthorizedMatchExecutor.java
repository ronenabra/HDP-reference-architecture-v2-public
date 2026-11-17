package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.SummaryEnum;
import ca.uhn.fhir.rest.api.SearchTotalModeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InternalErrorException;
import ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import jakarta.persistence.EntityManager;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

/** Reuses native DAO query parsing and the ordinary HAPI grant matcher for exact current matches. */
public final class PcmAuthorizedMatchExecutor {
    static final String VERIFIED_TOTAL = PcmAuthorizedMatchExecutor.class.getName() + ".total";
    static final String VERIFIED_PAGE_TOTAL = PcmAuthorizedMatchExecutor.class.getName() + ".pageTotal";
    static final int MAX_CANDIDATES = 100_000;
    static final long MAX_MILLIS = 10_000;
    private final DaoRegistry registry;
    private final RuleFilteringConsentService matcher;
    private final PlatformTransactionManager transactions;
    private final EntityManager entityManager;
    private final java.util.function.Supplier<PcmCountMetrics> metricsFactory;
    private PcmNativeMatchQueries nativeQueries;
    static final int MAX_NATIVE_ID_VISITS = 2_000_000;
    private final PcmQueryAdmission concurrent = new PcmQueryAdmission();

    /** Construct the executor with the same result matcher used by ordinary searches. */
    public PcmAuthorizedMatchExecutor(DaoRegistry registry, RuleFilteringConsentService matcher,
            PlatformTransactionManager transactions, EntityManager entityManager) {
        this(registry, matcher, transactions, entityManager, PcmCountMetrics::new);
    }

    /** Enable native predicate compilation using the same HAPI parser and compartment metadata. */
    public PcmAuthorizedMatchExecutor(DaoRegistry registry, RuleFilteringConsentService matcher,
            PlatformTransactionManager transactions, EntityManager entityManager,
            ca.uhn.fhir.context.FhirContext fhir, ca.uhn.fhir.jpa.searchparam.MatchUrlService translator) {
        this(registry, matcher, transactions, entityManager);
        nativeQueries = new PcmNativeMatchQueries(fhir, translator);
    }

    /** Inject request allocation counters for deterministic execution-budget tests. */
    PcmAuthorizedMatchExecutor(DaoRegistry registry, RuleFilteringConsentService matcher,
            PlatformTransactionManager transactions, EntityManager entityManager,
            java.util.function.Supplier<PcmCountMetrics> metricsFactory) {
        this.registry = registry;
        this.matcher = matcher;
        this.transactions = transactions;
        this.entityManager = entityManager;
        this.metricsFactory = metricsFactory;
    }

    /** Count only after proving search permission; every incomplete execution throws. */
    public int count(RequestDetails request, PcmRequestContext context) {
        return count(request, context, new PcmCountCancellation());
    }

    /** Share COUNT's effective-grant view and native compiler without running an exact count. */
    PcmNativeMatchQueries.PageSelection pageSelection(RequestDetails request, PcmRequestContext context,
            SearchParameterMap client,
            java.util.function.Function<PcmNativeMatchQueries.ReferenceSelection, Set<String>> referenceIds) {
        if (nativeQueries == null) return new PcmNativeMatchQueries.PageSelection(client, context.readGrants(), client,
                "native-compiler-unavailable");
        return nativeQueries.pageSelection(new PcmAuthorizedMatchPlan(request, context, matcher), client,
                request.getResourceName(), referenceIds);
    }

    /** Execute with servlet-originated cancellation, preserving the same matching semantics. */
    public int count(RequestDetails request, PcmRequestContext context, PcmCountCancellation cancellation) {
        PcmAuthorizedMatchPlan plan = new PcmAuthorizedMatchPlan(request, context, matcher);
        PcmQueryLimits limits = PcmQueryLimits.from(request);
        long remaining = limits.timeoutMilliseconds();
        Object expiry = request.getUserData().get(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE);
        if (!(expiry instanceof Instant instant)) throw new ForbiddenOperationException("PCM verified expiry required");
        remaining = Math.min(remaining, instant.toEpochMilli() - System.currentTimeMillis());
        // Leave time for transaction completion and serialization before authority expires.
        if (remaining <= 1000) throw incomplete();
        var reservation = concurrent.acquire(limits.maxConcurrentQueries(), request);
        if (reservation == null) throw incomplete();
        long deadline = PcmQueryLimits.deadline(request, instant);
        long workMillis = Math.max(1, (deadline - System.nanoTime()) / 1_000_000);
        final PcmCountMetrics metrics;
        try { metrics = metricsFactory.get(); metrics.limits = limits; metrics.request = request; }
        catch (RuntimeException unavailable) { reservation.close(); throw unavailable; }
        try {
            TransactionTemplate transaction = new TransactionTemplate(transactions);
            transaction.setReadOnly(true);
            transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            transaction.setTimeout(Math.max(1, (int) (workMillis / 1000)));
            Integer total = transaction.execute(status -> {
                org.hibernate.Session session = entityManager.unwrap(org.hibernate.Session.class);
                session.addEventListeners(metrics);
                cancellation.bind(session::cancelQuery);
                check(deadline, cancellation, metrics);
                // Pinned Starter's connection-release mode rejects Spring custom isolation.
                // Set characteristics before the first native search within this isolated transaction.
                entityManager.createNativeQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").executeUpdate();
                entityManager.createNativeQuery("SELECT set_config('statement_timeout', :timeout, true)")
                        .setParameter("timeout", workMillis + "ms").getSingleResult();
                return execute(request, plan, deadline, cancellation, metrics);
            });
            check(deadline, cancellation, metrics);
            if (total == null) throw incomplete();
            metrics.authorized = total;
            metrics.completed = true;
            return total;
        } finally {
            cancellation.unbind();
            try { metrics.record(cancellation); } finally { reservation.close(); }
        }
    }

    /** Evaluate one synchronous native query within the enclosing database snapshot. */
    private int execute(RequestDetails request, PcmAuthorizedMatchPlan plan, long deadline,
            PcmCountCancellation cancellation, PcmCountMetrics metrics) {
        var dao = resourceDao(request.getResourceName());
        SearchParameterMap query = new SearchParameterMap();
        dao.translateRawParameters(PcmCountRequestPolicy.predicates(request.getParameters()), query);
        query.setLoadSynchronous(true);
        // A type-wide system search grant proves the complete query is authorized.
        // All other shapes use the authoritative resource matcher, never a guessed predicate.
        boolean nativeCount = plan.nativeComplete();
        metrics.nativeCount = nativeCount;
        if (nativeCount) {
            query.setSummaryMode(SummaryEnum.COUNT);
            query.setSearchTotalMode(SearchTotalModeEnum.ACCURATE);
            check(deadline, cancellation, metrics);
            Integer total = dao.search(query, request).size();
            check(deadline, cancellation, metrics);
            if (total == null || total < 0) throw incomplete();
            return total;
        }
        if (nativeQueries != null) {
            var alternatives = nativeQueries.compile(plan, query, request.getResourceName());
            if (!alternatives.isEmpty()) return executeNativeAlternatives(request, plan, alternatives, deadline, cancellation, metrics);
        }
        query.setLoadSynchronousUpTo(metrics.limits.maxCountCandidates() + 1);
        check(deadline, cancellation, metrics);
        Set<String> matches = new HashSet<>();
        int examined = 0;
        try (var candidates = dao.searchForIdStream(query, request, null)) {
            var iterator = candidates.iterator();
            while (true) {
                check(deadline, cancellation, metrics);
                if (!iterator.hasNext()) break;
                metrics.candidates = ++examined;
                if (examined > metrics.limits.maxCountCandidates()) { PcmQueryLimits.exceeded(metrics.request, "count", "maxCountCandidates", metrics.limits.maxCountCandidates(), examined); throw incomplete(); }
                IBaseResource resource = dao.readByPid(iterator.next());
                metrics.materialized++;
                entityManager.clear();
                check(deadline, cancellation, metrics);
                if (resource == null) throw incomplete();
                if (!request.getResourceName().equals(resource.fhirType())) throw incomplete();
                if (plan.permits(resource)) {
                    String id = resource.getIdElement().getIdPart();
                    if (id == null || id.isBlank()) throw incomplete();
                    if (matches.add(resource.fhirType() + "/" + id)) metrics.authorized++;
                }
            }
        }
        check(deadline, cancellation, metrics);
        return matches.size();
    }

    /** Union complete native IDs and evaluate only the unproven reference partition. */
    private int executeNativeAlternatives(RequestDetails request, PcmAuthorizedMatchPlan plan,
            java.util.List<PcmNativeMatchQueries.Alternative> alternatives, long deadline,
            PcmCountCancellation cancellation, PcmCountMetrics metrics) {
        var dao = resourceDao(request.getResourceName());
        Set<Object> matches = new HashSet<>();
        java.util.Map<Object, ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?>> residual = new java.util.HashMap<>();
        Set<String> executed = new HashSet<>();
        for (var alternative : alternatives) {
            for (var complete : alternative.complete()) {
                String key = complete.toNormalizedQueryString();
                if (executed.add(key)) visitIds(complete, request, deadline, cancellation, metrics, pid -> matches.add(pid.getId()));
                if (matches.size() > metrics.limits.maxCountCandidates()) { PcmQueryLimits.exceeded(metrics.request, "count", "maxCountCandidates", metrics.limits.maxCountCandidates(), matches.size()); throw incomplete(); }
            }
        }
        for (var alternative : alternatives) {
            for (var partition : alternative.references()) {
                java.util.Map<Object, ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?>> exceptional = new java.util.HashMap<>();
                visitIds(partition.present(), request, deadline, cancellation, metrics, pid -> {
                    if (!matches.contains(pid.getId())) exceptional.put(pid.getId(), pid);
                });
                if (partition.localTargets() != null && !exceptional.isEmpty()) {
                    visitIds(partition.localTargets(), request, deadline, cancellation, metrics, pid -> exceptional.remove(pid.getId()));
                }
                residual.putAll(exceptional);
                if (residual.size() > metrics.limits.maxCountCandidates()) { PcmQueryLimits.exceeded(metrics.request, "count", "maxCountCandidates", metrics.limits.maxCountCandidates(), residual.size()); throw incomplete(); }
            }
        }
        metrics.candidates = matches.size() + residual.size();
        if (metrics.candidates > metrics.limits.maxCountCandidates()) { PcmQueryLimits.exceeded(metrics.request, "count", "maxCountCandidates", metrics.limits.maxCountCandidates(), metrics.candidates); throw incomplete(); }
        for (var pid : residual.values()) {
            check(deadline, cancellation, metrics);
            IBaseResource resource = dao.readByPid(pid);
            metrics.materialized++;
            entityManager.clear();
            if (resource == null || !request.getResourceName().equals(resource.fhirType())) throw incomplete();
            if (plan.permits(resource)) matches.add(pid.getId());
        }
        check(deadline, cancellation, metrics);
        return matches.size();
    }

    /** Bound streamed native index work separately from distinct candidate/body work. */
    private void visitIds(SearchParameterMap query, RequestDetails request, long deadline,
            PcmCountCancellation cancellation, PcmCountMetrics metrics,
            java.util.function.Consumer<ca.uhn.fhir.rest.api.server.storage.IResourcePersistentId<?>> consumer) {
        query.setLoadSynchronousUpTo(metrics.limits.maxCountCandidates() + 1);
        try (var stream = resourceDao(request.getResourceName()).searchForIdStream(query, request, null)) {
            var iterator = stream.iterator();
            int visited = 0;
            while (iterator.hasNext()) {
                check(deadline, cancellation, metrics);
                if (++visited > metrics.limits.maxCountCandidates()) { PcmQueryLimits.exceeded(metrics.request, "count", "maxCountCandidates", metrics.limits.maxCountCandidates(), visited); throw incomplete(); }
                if (++metrics.nativeIdVisits > metrics.limits.maxCountNativeIdVisits()) { PcmQueryLimits.exceeded(metrics.request, "count", "maxCountNativeIdVisits", metrics.limits.maxCountNativeIdVisits(), metrics.nativeIdVisits); throw incomplete(); }
                var pid = iterator.next();
                if (pid == null || pid.getId() == null) throw incomplete();
                consumer.accept(pid);
            }
        }
    }

    /** Cooperative checks supplement the transaction-local PostgreSQL statement timeout. */
    private static void check(long deadline, PcmCountCancellation cancellation, PcmCountMetrics metrics) {
        long allocated = metrics.allocatedBytes();
        if (allocated > metrics.limits.maxAllocatedBytes()) {
            PcmQueryLimits.exceeded(metrics.request, "count", "maxAllocatedBytes", metrics.limits.maxAllocatedBytes(), allocated); throw incomplete();
        }
        if (System.nanoTime() >= deadline) { PcmQueryLimits.timedOut(metrics.request, "count"); throw incomplete(); }
        if (Thread.currentThread().isInterrupted() || cancellation.isCancelled()) throw incomplete();
    }

    /** Access the DAO only after concrete resource type and grant validation. */
    @SuppressWarnings("unchecked")
    private ca.uhn.fhir.jpa.api.dao.IFhirResourceDao<IBaseResource> resourceDao(String type) {
        return registry.getResourceDao(type);
    }

    /** An incomplete traversal must never masquerade as an exact zero or partial total. */
    private static InternalErrorException incomplete() {
        return new InternalErrorException("PCM exact search could not complete within its execution budget");
    }
}
