package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.model.api.Include;
import ca.uhn.fhir.model.api.ResourceMetadataKeyEnum;
import ca.uhn.fhir.model.valueset.BundleEntrySearchModeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.SearchTotalModeEnum;
import ca.uhn.fhir.rest.api.SortOrderEnum;
import ca.uhn.fhir.rest.api.SortSpec;
import ca.uhn.fhir.rest.api.server.IBundleProvider;
import ca.uhn.fhir.rest.api.server.IPreResourceAccessDetails;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import ca.uhn.fhir.rest.server.exceptions.ResourceGoneException;
import ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException;
import ca.uhn.fhir.rest.server.method.ResponsePage;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Resource;
import org.slf4j.LoggerFactory;

/** Bounded retrieval over HAPI's own Consent-filtered, persisted native search membership. */
public final class PcmPageExecutor implements AutoCloseable {
    static final int MAX_ID_VISITS = 5_000;
    static final int MAX_BODY_VISITS = 5_000;
    static final int MAX_REFILLS = 32;
    static final int MAX_INCLUDES = 100;
    static final int MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
    // An extra row proves that client-first enumeration is incomplete; never collect a broad set.
    static final int MAX_SELECTIVE_PROBE_IDS = 32;
    private static final String PREPARED = PcmPageExecutor.class.getName() + ".prepared";
    private static final String BUDGET = PcmPageExecutor.class.getName() + ".budget";
    static final ThreadLocal<Budget> CURRENT = new ThreadLocal<>();
    private final DaoRegistry registry;
    private final org.springframework.transaction.PlatformTransactionManager transactions;
    private final jakarta.persistence.EntityManager entityManager;
    private final ca.uhn.fhir.context.FhirContext fhir;
    private PcmAuthorizedMatchExecutor counter;
    final PcmSearchGeneration generation = new PcmSearchGeneration();
    private final PcmPageState states = new PcmPageState();
    private final java.util.concurrent.ScheduledThreadPoolExecutor deadlines =
            new java.util.concurrent.ScheduledThreadPoolExecutor(1, runnable -> {
                Thread thread = new Thread(runnable, "pcm-page-deadline"); thread.setDaemon(true); return thread;
            });
    record Prepared(PcmPageState.Continuation continuation, int count, String self, boolean accurate) { }

    /** Reuse COUNT's persistence services, never a separate search engine. */
    public PcmPageExecutor(DaoRegistry registry, org.springframework.transaction.PlatformTransactionManager transactions,
            jakarta.persistence.EntityManager entityManager, ca.uhn.fhir.context.FhirContext fhir) {
        this.registry = registry; this.transactions = transactions; this.entityManager = entityManager; this.fhir = fhir;
        deadlines.setRemoveOnCancelPolicy(true);
    }

    /** Reuse COUNT's exact executor; no second count algorithm or unrestricted cache is introduced. */
    public PcmPageExecutor(DaoRegistry registry, org.springframework.transaction.PlatformTransactionManager transactions,
            jakarta.persistence.EntityManager entityManager, ca.uhn.fhir.context.FhirContext fhir,
            PcmAuthorizedMatchExecutor counter) {
        this(registry, transactions, entityManager, fhir);
        this.counter = counter;
    }

    /** Native create, update and delete hooks include transaction/batch imports and private maintenance. */
    @Hook(Pointcut.STORAGE_PRECOMMIT_RESOURCE_CREATED)
    public void clinicalCreated() { generation.writing(); }
    /** Update and patch both enter the native updated-resource lifecycle. */
    @Hook(Pointcut.STORAGE_PRECOMMIT_RESOURCE_UPDATED)
    public void clinicalUpdated() { generation.writing(); }
    /** Deletion, including transaction deletes, invalidates retained accurate searches. */
    @Hook(Pointcut.STORAGE_PRECOMMIT_RESOURCE_DELETED)
    public void clinicalDeleted() { generation.writing(); }

    /** Verify original controls before restoring the retained primary type for GET_PAGE authorization. */
    void prepare(RequestDetails request, PcmRequestContext context) {
        int count = PcmPageRequestPolicy.count(request.getParameters());
        boolean accurate = PcmPageRequestPolicy.accurate(request.getParameters());
        boolean everything = PcmEverythingPolicy.isPath(request.getRequestPath());
        PcmPageState.Continuation continuation = null;
        if (request.getRestOperationType() == RestOperationTypeEnum.GET_PAGE) {
            if (!Set.of("_getpages", "_count").containsAll(request.getParameters().keySet())) throw denied();
            String[] cursor = request.getParameters().get("_getpages");
            if (cursor == null || cursor.length != 1) throw denied();
            continuation = states.resolve(cursor[0], context, policy(request), PcmQueryLimits.from(request));
            if (count != continuation.search().count()) throw denied();
            request.setResourceName(continuation.search().type());
            accurate = continuation.search().total() != null;
            everything = PcmEverythingPolicy.retained(continuation.search().query());
            if (everything) PcmEverythingPolicy.prepare(request, context, continuation.search().query());
        } else {
            for (String parameter : request.getParameters().keySet()) {
                if (parameter.startsWith("_getpages") || Set.of("_offset", "_maxresults", "_loadSynchronous").contains(parameter)) throw denied();
            }
            if (!everything && context.kind() == PcmRequestContext.Kind.DATA_SOURCE_ACCESS
                    && context.readGrants().stream().noneMatch(grant -> grant.resourceType().equals(request.getResourceName())
                        && PcmInteractionGate.permits(grant, RestOperationTypeEnum.SEARCH_TYPE))) throw denied();
        }
        String original = request.getHeader("X-PCM-Request-URI");
        if (original == null) throw new InvalidRequestException("PCM query exceeds maxQueryUriCharacters=" + PcmQueryLimits.from(request).maxQueryUriCharacters());
        if (original.length() > PcmQueryLimits.from(request).maxQueryUriCharacters()) { PcmQueryLimits.exceeded(request, "page", "maxQueryUriCharacters", PcmQueryLimits.from(request).maxQueryUriCharacters(), original.length()); throw new InvalidRequestException("PCM query exceeds maxQueryUriCharacters=" + PcmQueryLimits.from(request).maxQueryUriCharacters()); };
        String self = request.getFhirServerBase() + original.substring("/fhir".length());
        if (everything && continuation == null) PcmEverythingPolicy.prepare(request, context, self);
        request.getUserData().put(PREPARED, new Prepared(continuation, count, self, accurate));
    }

    /** Run native search/loading with COUNT's cancellation and a verified authorization deadline. */
    Bundle page(RequestDetails request, PcmRequestContext context, PcmCountCancellation cancellation) {
        Object expiry = request.getUserData().get(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE);
        if (!(expiry instanceof Instant instant)) throw denied();
        long remaining = (PcmQueryLimits.deadline(request, instant) - System.nanoTime()) / 1_000_000;
        if (remaining <= 0) { PcmQueryLimits.timedOut(request, "page"); throw incomplete(); }
        Budget budget = new Budget(remaining, cancellation, PcmQueryLimits.from(request), PcmQueryLimits.deadline(request, instant));
        budget.request = request;
        request.getUserData().put(BUDGET, budget);
        CURRENT.set(budget);
        try {
            budget.watchDeadline(deadlines);
            budget.check();
            Prepared prepared = (Prepared) request.getUserData().get(PREPARED);
            boolean continuation = prepared.continuation != null;
            long stamp = prepared.accurate ? (continuation ? prepared.continuation.search().generation() : generation.begin()) : 0;
            if (prepared.accurate) generation.verify(stamp, continuation);
            Integer total = null;
            if (prepared.accurate) {
                if (continuation) total = prepared.continuation.search().total();
                else {
                    if (counter == null) throw incomplete();
                    // COUNT retains its independently measured ID/body limits. The PAGE timer
                    // remains active across both branches and cancels their shared native work.
                    CURRENT.remove();
                    try { total = counter.count(request, context, cancellation); }
                    finally { CURRENT.set(budget); }
                }
            }
            budget.check();
            Bundle bundle = retrieve(request, context, budget, total, stamp);
            if (prepared.accurate) {
                generation.verify(stamp, continuation);
                bundle.setTotal(total);
                request.getUserData().put(PcmAuthorizedMatchExecutor.VERIFIED_PAGE_TOTAL, total);
            }
            budget.check();
            checkPayload(request, bundle, budget.limits.maxPagePayloadBytes());
            budget.check();
            budget.completed = true;
            return bundle;
        } catch (RuntimeException failed) {
            // Native drivers usually throw when Statement.cancel interrupts a fetch;
            // the owning timer has already measured/captured its cause. Do not discover
            // a new cause during cleanup of an unrelated driver failure.
            if (cancellation.isCancelled()) throw incomplete();
            throw failed;
        } finally {
            budget.close();
            cancellation.unbind();
            CURRENT.remove();
            PcmRuntimeObservability.pageWork(request, budget.ids.get(), budget.bodies.get(), budget.refills,
                    budget.metrics.allocatedBytes(), budget.completed, cancellation.isCancelled());
            LoggerFactory.getLogger(PcmPageExecutor.class).info(
                    "PCM_PAGE_METRICS elapsed_ms={} native_id_visits={} body_visits={} refills={} allocated_bytes={} cancelled={} completed={}",
                    (System.nanoTime() - budget.started) / 1_000_000, budget.ids, budget.bodies, budget.refills,
                    budget.metrics.allocatedBytes(), cancellation.isCancelled(), budget.completed);
            request.getUserData().remove(BUDGET);
        }
    }

    /** Preflight exactly HAPI's negotiated parser settings before any successful response headers/body. */
    void checkPayload(RequestDetails request, Bundle bundle, int limit) {
        if (bundle == null) throw incomplete();
        var sink = new PayloadSize(limit);
        try (var writer = new java.io.OutputStreamWriter(sink, java.nio.charset.StandardCharsets.UTF_8)) {
            ca.uhn.fhir.rest.server.RestfulServerUtils.getNewParser(fhir, bundle.getStructureFhirVersionEnum(), request)
                    .encodeResourceToWriter(bundle, writer);
        } catch (Exception failed) {
            if (sink.exceeded) { PcmQueryLimits.exceeded(request, "page", "maxPagePayloadBytes", limit, sink.observed); throw incomplete(); }
            if (failed instanceof RuntimeException runtime) throw runtime;
            throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("PCM page encoding failed", failed);
        }
    }

    /** Count UTF-8 bytes without retaining a second encoded clinical payload; abort on the first excess byte. */
    private static final class PayloadSize extends java.io.OutputStream {
        private final int limit;
        private int bytes;
        private boolean exceeded;
        private long observed;
        PayloadSize(int limit) { this.limit = limit; }
        @Override public void write(int value) throws java.io.IOException { add(1); }
        @Override public void write(byte[] values, int offset, int length) throws java.io.IOException { add(length); }
        private void add(int length) throws java.io.IOException {
            observed = (long) bytes + length;
            if (length > limit - bytes) { exceeded = true; throw new java.io.IOException("PCM page payload limit"); }
            bytes += length;
        }
    }

    /** Release the one bounded deadline facility with the shared clinical worker lifecycle. */
    @Override public void close() { deadlines.shutdownNow(); }

    /** Advance native offsets exactly; refill only current-body reauthorization holes. */
    private Bundle retrieve(RequestDetails request, PcmRequestContext context, Budget budget, Integer total, long stamp) {
        Prepared prepared = (Prepared) request.getUserData().get(PREPARED);
        IBundleProvider provider;
        PcmPageState.Search state;
        int offset;
        if (prepared.continuation == null) {
            // Native search reuse predating the generation fence is not a common state.
            RequestDetails nativeRequest = new PcmNativeSearchRequest(request);
            PcmEverythingPolicy.Target target = PcmEverythingPolicy.target(request);
            if (target != null) {
                // Native graph discovery remains entirely HAPI-owned. Both public forms
                // enter this instance-only DAO method with the independently resolved ID.
                nativeRequest = new PcmNativeSearchRequest(request);
                nativeRequest.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
                var parameters = new ca.uhn.fhir.jpa.api.dao.PatientEverythingParameters();
                parameters.setCount(new org.hl7.fhir.r4.model.IntegerType(prepared.count));
                parameters.setTypes(new ca.uhn.fhir.rest.param.StringAndListParam()
                        .addAnd(new ca.uhn.fhir.rest.param.StringOrListParam().addOr(new ca.uhn.fhir.rest.param.StringParam(String.join(",", new java.util.TreeSet<>(target.types()))))));
                provider = ((ca.uhn.fhir.jpa.api.dao.IFhirResourceDaoPatient<?>) resourceDao("Patient"))
                        .patientInstanceEverything(null, nativeRequest, parameters, new org.hl7.fhir.r4.model.IdType("Patient", target.patient()));
            } else provider = resourceDao(request.getResourceName()).search(nativeQuery(request, context, prepared.count, budget), nativeRequest);
            String nativeId = provider.getUuid();
            if (nativeId == null || !nativeId.matches("[a-f0-9-]{36}")) throw incomplete();
            state = states.create(nativeId, request.getResourceName(), prepared.count, context, prepared.self, policy(request), total, stamp, budget.limits, request.getParameters());
            offset = 0;
        } else {
            state = prepared.continuation.search(); offset = prepared.continuation.offset();
            provider = request.getServer().getPagingProvider().retrieveResultList(request, state.nativeId());
            if (provider == null) throw new ResourceGoneException("PCM native search expired; start a new search");
        }
        Bundle result = new Bundle().setType(Bundle.BundleType.SEARCHSET);
        result.addLink().setRelation("self").setUrl(prepared.self);
        boolean more;
        do {
            budget.check();
            if (++budget.refills > budget.limits.maxPageRefills()) { PcmQueryLimits.exceeded(budget.request, "page", "maxPageRefills", budget.limits.maxPageRefills(), budget.refills); throw incomplete(); }
            Progress progress = new Progress();
            var resources = provider.getResources(offset, Math.addExact(offset, prepared.count), progress);
            budget.check();
            if (progress.fetched < 0) throw incomplete();
            more = progress.fetched > prepared.count;
            java.util.Map<String, IBaseResource> currentMatches = currentMatches(resources, state, request);
            Set<String> seen = new HashSet<>();
            int primaries = 0;
            int includes = 0;
            int outcomes = 0;
            boolean changedPrimary = false;
            for (IBaseResource resource : resources) {
                if (!(resource instanceof Resource r4)) throw incomplete();
                if (resource instanceof org.hl7.fhir.r4.model.OperationOutcome) {
                    if (++outcomes > budget.limits.maxPageIncludes()) { PcmQueryLimits.exceeded(budget.request, "page", "maxPageIncludes", budget.limits.maxPageIncludes(), outcomes); throw incomplete(); }
                    var outcome = new org.hl7.fhir.r4.model.OperationOutcome();
                    outcome.addIssue().setSeverity(org.hl7.fhir.r4.model.OperationOutcome.IssueSeverity.WARNING)
                            .setCode(org.hl7.fhir.r4.model.OperationOutcome.IssueType.PROCESSING).setDiagnostics("PCM search outcome");
                    result.addEntry().setResource(outcome).getSearch().setMode(Bundle.SearchEntryMode.OUTCOME);
                    continue;
                }
                String id = resource.fhirType() + "/" + resource.getIdElement().getIdPart();
                if (!seen.add(id)) continue;
                boolean included = ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.get(resource) == BundleEntrySearchModeEnum.INCLUDE;
                PcmEverythingPolicy.Target target = PcmEverythingPolicy.target(request);
                if (target != null && ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.get(resource) != BundleEntrySearchModeEnum.MATCH) throw incomplete();
                if (target != null && (!target.types().contains(resource.fhirType())
                        || "Patient".equals(resource.fhirType()) && !target.patient().equals(resource.getIdElement().getIdPart()))) continue;
                Resource selected = r4;
                if (!included) {
                    IBaseResource current = currentMatches.get(PcmEverythingPolicy.target(request) != null ? id : resource.getIdElement().getIdPart());
                    if (current == null) { changedPrimary = true; continue; }
                    if (!(current instanceof Resource currentR4)) throw incomplete();
                    changedPrimary |= !java.util.Objects.equals(r4.getMeta().getVersionId(), currentR4.getMeta().getVersionId());
                    selected = currentR4;
                }
                if (included && ++includes > budget.limits.maxPageIncludes()) {
                    PcmQueryLimits.exceeded(budget.request, "page", "maxPageIncludes", budget.limits.maxPageIncludes(), includes); throw incomplete();
                }
                if (!included && ++primaries > prepared.count) throw incomplete();
                var entry = result.addEntry().setResource(selected).setFullUrl(request.getFhirServerBase() + "/" + id);
                entry.getSearch().setMode(included ? Bundle.SearchEntryMode.INCLUDE : Bundle.SearchEntryMode.MATCH);
            }
            offset = Math.addExact(offset, prepared.count);
            if (primaries == 0) {
                result.getEntry().clear();
                if (!more) break;
            } else {
                if (includes > 0 && changedPrimary) throw incomplete();
                break;
            }
        } while (true);
        if (more) result.addLink().setRelation("next").setUrl(request.getFhirServerBase()
                + "?_getpages=" + states.cursor(state, offset) + "&_count=" + prepared.count);
        return result;
    }

    /** Reapply the retained client predicates to current bodies using native READ COMMITTED semantics, using native DAO semantics. */
    private java.util.Map<String, IBaseResource> currentMatches(java.util.List<IBaseResource> resources, PcmPageState.Search state, RequestDetails request) {
        var ids = resources.stream().filter(resource -> ResourceMetadataKeyEnum.ENTRY_SEARCH_MODE.get(resource) != BundleEntrySearchModeEnum.INCLUDE)
                .map(resource -> resource.getIdElement().getIdPart()).distinct().toList();
        if (PcmEverythingPolicy.target(request) != null) return currentOperationMatches(resources, request);
        if (ids.isEmpty()) return java.util.Map.of();
        java.util.Map<String, java.util.List<String>> predicates = new java.util.LinkedHashMap<>();
        state.predicates().forEach((name, values) -> predicates.put(name, new java.util.ArrayList<>(values)));
        predicates.computeIfAbsent("_id", ignored -> new java.util.ArrayList<>()).add(String.join(",", ids));
        SearchParameterMap query = new SearchParameterMap();
        resourceDao(state.type()).translateRawParameters(predicates, query);
        query.setLoadSynchronous(true); query.setCount(ids.size()); query.setSearchTotalMode(SearchTotalModeEnum.NONE);
        var snapshot = new org.springframework.transaction.support.TransactionTemplate(transactions);
        snapshot.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        snapshot.setReadOnly(true);
        snapshot.setTimeout(Math.max(1, (PcmQueryLimits.from(request).timeoutMilliseconds() - 1000) / 1000));
        var matches = snapshot.execute(status -> {
            // Synchronous bounded retrieval uses no persisted search cache writes;
            // unlike enclosing native SearchTask collection, this narrow snapshot is safe.
            entityManager.createNativeQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").executeUpdate();
            java.util.Map<String, IBaseResource> selected = new java.util.LinkedHashMap<>();
            for (IBaseResource resource : resourceDao(state.type()).searchForResources(query, request)) {
                if (!state.type().equals(resource.fhirType())) throw incomplete();
                selected.put(resource.getIdElement().getIdPart(), resource);
            }
            return selected;
        });
        if (matches == null) throw incomplete();
        return matches;
    }

    /** Refresh only native graph candidate IDs; HAPI still owns discovery, expansion and persisted membership. */
    private java.util.Map<String, IBaseResource> currentOperationMatches(java.util.List<IBaseResource> resources, RequestDetails request) {
        java.util.Map<String, java.util.Set<String>> groups = new java.util.LinkedHashMap<>();
        for (IBaseResource resource : resources) {
            if (resource instanceof org.hl7.fhir.r4.model.OperationOutcome) continue;
            groups.computeIfAbsent(resource.fhirType(), ignored -> new java.util.LinkedHashSet<>()).add(resource.getIdElement().getIdPart());
        }
        if (groups.isEmpty()) return java.util.Map.of();
        var snapshot = new org.springframework.transaction.support.TransactionTemplate(transactions);
        snapshot.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        snapshot.setReadOnly(true); snapshot.setTimeout(Math.max(1, (PcmQueryLimits.from(request).timeoutMilliseconds() - 1000) / 1000));
        var result = snapshot.execute(status -> {
            entityManager.createNativeQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").executeUpdate();
            java.util.Map<String, IBaseResource> current = new java.util.HashMap<>();
            for (var group : groups.entrySet()) {
                SearchParameterMap query = new SearchParameterMap();
                resourceDao(group.getKey()).translateRawParameters(java.util.Map.of("_id", java.util.List.of(String.join(",", group.getValue()))), query);
                query.setLoadSynchronous(true); query.setCount(group.getValue().size()); query.setSearchTotalMode(SearchTotalModeEnum.NONE);
                for (IBaseResource resource : resourceDao(group.getKey()).searchForResources(query, new PcmNativeSearchRequest(request))) {
                    if (!group.getKey().equals(resource.fhirType()) || !group.getValue().contains(resource.getIdElement().getIdPart())) throw incomplete();
                    current.put(resource.fhirType() + "/" + resource.getIdElement().getIdPart(), resource);
                }
            }
            return current;
        });
        if (result == null) throw incomplete();
        return result;
    }

    /** Policy is installed only after the original adapter signature and current policy have been verified. */
    private static String policy(RequestDetails request) {
        Object policy = request.getUserData().get(LocalJwtRequestContextVerifier.POLICY_ATTRIBUTE);
        return policy instanceof String stamp ? stamp : "";
    }

    /** HAPI owns predicate parsing, ordering, include traversal, deduplication and persisted membership. */
    private SearchParameterMap nativeQuery(RequestDetails request, PcmRequestContext context, int count, Budget budget) {
        SearchParameterMap query = new SearchParameterMap();
        resourceDao(request.getResourceName()).translateRawParameters(PcmCountRequestPolicy.predicates(request.getParameters()), query);
        if (counter != null && context.kind() == PcmRequestContext.Kind.DATA_SOURCE_ACCESS) {
            var selection = counter.pageSelection(request, context, query, links -> referenceIds(request, budget, links));
            query = selection.candidates();
            PcmRuntimeObservability.pageSelection(request, context.kind(), selection.reason());
        }
        query.setCount(count); query.setSearchTotalMode(SearchTotalModeEnum.NONE);
        query.setSort(sort(request.getParameters().get("_sort")));
        addIncludes(query.getIncludes(), request.getParameters().get("_include"));
        addIncludes(query.getRevIncludes(), request.getParameters().get("_revinclude"));
        return query;
    }

    /**
     * Read only the pinned HAPI reference index's exceptional partition, before materialization.
     * Local target-PID links need no residual traversal. A foreign/unresolved link can coexist
     * with a local link on a repeated path, so select source IDs per exceptional link directly;
     * never subtract entire resources merely because another link resolves locally.
     * Path/target restrictions use the same pinned compartment metadata as COUNT. Patient alone
     * also projects local link IDs, because a native ID/reference OR loses link-free self rows.
     * Both bounded scalar projections feed one native ordered search with final authorization.
     */
    Set<String> referenceIds(RequestDetails request, Budget budget,
            PcmNativeMatchQueries.ReferenceSelection selection) {
        var transaction = new org.springframework.transaction.support.TransactionTemplate(transactions);
        transaction.setReadOnly(true);
        transaction.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.setTimeout(Math.max(1, (int) ((budget.deadline - System.nanoTime()) / 1_000_000_000)));
        Set<String> ids = transaction.execute(status -> {
            // Spring's configured pool rejects custom transaction isolation. As in currentMatches,
            // establish it on the actual REQUIRES_NEW connection before any selection SELECT.
            entityManager.createNativeQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").executeUpdate();
            Set<Long> sources = selection.localLinks() && !selection.predicates().isEmpty()
                    ? selectiveSources(request, budget, selection.predicates()) : null;
            if (sources != null && sources.isEmpty()) return Set.<String>of();
            Set<String> result = new java.util.LinkedHashSet<>();
            String base = "select distinct link.mySourceResource.myFhirId from ResourceLink link "
                    + "where link.mySourceResourceType = :type and link.mySourcePath in :paths and "
                    + (sources == null ? "" : "link.mySourceResourcePid in :sources and ");
            // Keep separate queries: joining a nullable target association into the URL branch
            // would discard foreign references beside unrelated local links.
            if (selection.localLinks()) {
                var local = entityManager.createQuery(base + "link.myTargetResource.myResourceType = 'Patient' "
                        + "and link.myTargetResource.myFhirId in :patients", String.class)
                        .setParameter("patients", selection.patients());
                if (sources != null) local.setParameter("sources", sources);
                collectReferenceIds(local, request, budget, selection, result);
            }
            // URL suffixes preserve FhirTerser's unqualified/versionless membership. A source
            // can have both a wrong local link and a matching foreign link on a repeated path.
            var clauses = new java.util.ArrayList<String>();
            int index = 0;
            for (String patient : selection.patients()) {
                clauses.add("(link.myTargetResourceUrl = :relative" + index
                        + " or link.myTargetResourceUrl like :absolute" + index
                        + " or link.myTargetResourceUrl like :versioned" + index + ")");
                index++;
            }
            var exceptional = entityManager.createQuery(base + "link.myTargetResourceUrl is not null and ("
                    + String.join(" or ", clauses) + ")", String.class);
            if (sources != null) exceptional.setParameter("sources", sources);
            index = 0;
            for (String patient : selection.patients()) {
                exceptional.setParameter("relative" + index, "Patient/" + patient);
                exceptional.setParameter("absolute" + index, "%/Patient/" + patient);
                exceptional.setParameter("versioned" + index, "%Patient/" + patient + "/_history/%");
                index++;
            }
            collectReferenceIds(exceptional, request, budget, selection, result);
            return result;
        });
        if (ids == null) throw incomplete();
        return ids;
    }

    /**
     * Let HAPI evaluate original client AND/OR and proven common predicates, without loading bodies.
     * A complete small native PID set safely restricts both link projections; empty differs from
     * absent. A 33rd ID explicitly discards the probe and retains the compartment-first cover.
     * HAPI's FOUND_ID hook charges probe visits, and its synchronous cap bounds SQL prefetch.
     */
    private Set<Long> selectiveSources(RequestDetails request, Budget budget, SearchParameterMap predicates) {
        predicates.setLoadSynchronousUpTo(MAX_SELECTIVE_PROBE_IDS + 1);
        predicates.setSearchTotalMode(SearchTotalModeEnum.NONE);
        Set<Long> sources = new java.util.LinkedHashSet<>();
        int before = budget.ids.get();
        budget.check();
        try (var stream = resourceDao(request.getResourceName()).searchForIdStream(predicates,
                new PcmNativeSearchRequest(request), null)) {
            var iterator = stream.iterator();
            for (int visited = 0; visited <= MAX_SELECTIVE_PROBE_IDS && iterator.hasNext(); visited++) {
                budget.check();
                var pid = iterator.next();
                if (pid == null || !(pid.getId() instanceof Long id)) throw incomplete();
                if (visited == MAX_SELECTIVE_PROBE_IDS) return null;
                sources.add(id);
            }
        }
        budget.check();
        // HAPI caps raw SQL rows before its in-memory PID deduplication. An exhausted
        // stream with fewer distinct PIDs is still unproven if that raw cap was reached.
        if (budget.ids.get() - before >= MAX_SELECTIVE_PROBE_IDS + 1) return null;
        return sources;
    }

    /** Every scalar ID, including duplicates between projections, consumes the original PAGE budget. */
    private void collectReferenceIds(jakarta.persistence.TypedQuery<String> query, RequestDetails request,
            Budget budget, PcmNativeMatchQueries.ReferenceSelection selection, Set<String> result) {
        query.setParameter("type", request.getResourceName()).setParameter("paths", selection.paths())
                .setMaxResults(budget.limits.maxPageIdVisits() + 1);
        budget.check();
        try (var stream = query.getResultStream()) {
            var iterator = stream.iterator();
            while (iterator.hasNext()) {
                foundId();
                String id = iterator.next();
                if (id == null || id.isBlank()) throw incomplete();
                result.add(id);
            }
        }
        budget.check();
    }

    /** Preserve requested ordering and add a deterministic logical-ID tie breaker. */
    private static SortSpec sort(String[] raw) {
        if (raw != null && (raw.length != 1 || raw[0] == null || raw[0].isBlank())) throw new InvalidRequestException("PCM sort is invalid");
        String[] names = raw == null ? new String[0] : raw[0].split(",", -1);
        SortSpec first = null; SortSpec last = null; boolean id = false;
        for (String name : names) {
            if (!name.matches("-?[A-Za-z_][A-Za-z0-9_-]*")) throw new InvalidRequestException("PCM sort is invalid");
            String field = name.startsWith("-") ? name.substring(1) : name;
            SortSpec next = new SortSpec(field, name.startsWith("-") ? SortOrderEnum.DESC : SortOrderEnum.ASC);
            if (first == null) first = next; else last.setChain(next);
            last = next; id |= "_id".equals(field);
        }
        if (!id) { SortSpec tie = new SortSpec("_id", SortOrderEnum.ASC); if (last == null) first = tie; else last.setChain(tie); }
        return first;
    }

    /** Includes have separate expansion and payload bounds, never consume primary slots. */
    private static void addIncludes(Set<Include> includes, String[] values) {
        if (values != null) for (String value : values) includes.add(new Include(value));
    }

    /** Count index visits before Consent so sparse authorization cannot hide work. */
    @Hook(Pointcut.JPA_PERFTRACE_SEARCH_FOUND_ID)
    public void foundId() {
        Budget budget = CURRENT.get();
        if (budget != null) {
            int observed = budget.ids.incrementAndGet();
            if (observed > budget.limits.maxPageIdVisits()) { PcmQueryLimits.exceeded(budget.request, "page", "maxPageIdVisits", budget.limits.maxPageIdVisits(), observed); throw incomplete(); }
            budget.check();
        }
    }

    /** Bound resources offered to authorization before the ordinary Consent hook. */
    @Hook(value = Pointcut.STORAGE_PREACCESS_RESOURCES, order = -100)
    public void preAccess(RequestDetails request, IPreResourceAccessDetails access) {
        if (request != null && request.getUserData().get(BUDGET) instanceof Budget budget) {
            int observed = budget.bodies.addAndGet(access.size());
            if (observed > budget.limits.maxPageBodyVisits()) { PcmQueryLimits.exceeded(budget.request, "page", "maxPageBodyVisits", budget.limits.maxPageBodyVisits(), observed); throw incomplete(); }
            budget.check();
        }
    }

    /** Retrieve only a previously validated concrete resource type. */
    @SuppressWarnings("unchecked")
    private ca.uhn.fhir.jpa.api.dao.IFhirResourceDao<IBaseResource> resourceDao(String type) { return registry.getResourceDao(type); }
    /** Retryable failures cannot claim terminal exhaustion. */
    private static UnclassifiedServerFailureException incomplete() { return new UnclassifiedServerFailureException(503, "PCM page could not complete within its execution budget"); }
    /** Cursor possession never supplies authority. */
    private static ForbiddenOperationException denied() { return new ForbiddenOperationException("PCM continuation denied"); }

    /** Capture native lookahead independently of filtered result length. */
    static final class Progress extends ResponsePage.ResponsePageBuilder {
        int fetched = -1;
        @Override public ResponsePage.ResponsePageBuilder setTotalRequestedResourcesFetched(int count) {
            fetched = count; return super.setTotalRequestedResourcesFetched(count);
        }
    }

    /** Per-worker work and allocation limits shared by synchronous native callbacks. */
    static final class Budget implements AutoCloseable {
        final PcmQueryLimits limits;
        RequestDetails request;
        final long started = System.nanoTime(); final long deadline;
        final PcmCountCancellation cancellation;
        final PcmCountMetrics metrics = new PcmCountMetrics();
        final AtomicInteger ids = new AtomicInteger(); final AtomicInteger bodies = new AtomicInteger();
        int refills; boolean completed;
        private java.util.concurrent.ScheduledFuture<?> expiry;
        private boolean closed;
        Budget(long millis, PcmCountCancellation cancellation) { this(millis, cancellation, PcmQueryLimits.DEFAULTS); }
        Budget(long millis, PcmCountCancellation cancellation, PcmQueryLimits limits) { this(millis, cancellation, limits, 0); }
        /** Production retains the exact shared monotonic boundary instead of truncating remaining milliseconds. */
        Budget(long millis, PcmCountCancellation cancellation, PcmQueryLimits limits, long absoluteDeadline) {
            this.limits = limits; deadline = absoluteDeadline == 0 ? started + millis * 1_000_000 : absoluteDeadline;
            this.cancellation = cancellation;
        }
        /** One registration per active worker covers execute and later streaming fetches at the same deadline. */
        synchronized void watchDeadline(java.util.concurrent.ScheduledExecutorService timer) {
            if (closed || expiry != null) throw new IllegalStateException("PAGE deadline already registered or closed");
            expiry = timer.schedule(this::expire, Math.max(0, deadline - System.nanoTime()), java.util.concurrent.TimeUnit.NANOSECONDS);
        }
        /** Serialize timer completion with cleanup so a completed worker cannot retain a live timer callback. */
        private synchronized void expire() { if (!closed && !completed) { timeout(); cancellation.cancel(); } }
        /** Eagerly remove queued expiry tasks; active callbacks finish before cleanup returns. */
        @Override public synchronized void close() { closed = true; if (expiry != null) expiry.cancel(false); }
        /** Timer and worker use the same request clock; authority-only deadlines carry no query cause. */
        private void timeout() { if (request != null) PcmQueryLimits.timedOut(request, "page"); }
        void check() {
            if (System.nanoTime() >= deadline) { timeout(); cancellation.cancel(); }
            long allocated = metrics.allocatedBytes();
            if (allocated > limits.maxAllocatedBytes()) { PcmQueryLimits.exceeded(request, "page", "maxAllocatedBytes", limits.maxAllocatedBytes(), allocated); throw incomplete(); }
            if (Thread.currentThread().isInterrupted() || cancellation.isCancelled()) throw incomplete();
        }
    }
}
