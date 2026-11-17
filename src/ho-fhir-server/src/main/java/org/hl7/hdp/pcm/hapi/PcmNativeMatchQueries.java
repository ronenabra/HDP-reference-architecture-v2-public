package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.context.RuntimeSearchParam;
import ca.uhn.fhir.jpa.searchparam.MatchUrlService;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.param.DateParam;
import ca.uhn.fhir.rest.param.TokenParamModifier;
import ca.uhn.fhir.model.api.IQueryParameterType;
import ca.uhn.fhir.rest.param.ReferenceParam;
import ca.uhn.fhir.rest.param.TokenParam;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import ca.uhn.fhir.rest.param.StringParam;

/** Native indexed alternatives, retaining authoritative matching for exceptional references. */
final class PcmNativeMatchQueries {
    private final FhirContext fhir;
    private final MatchUrlService translator;

    /** Share HAPI's compiled filter parser and the compartment metadata used by FhirTerser. */
    PcmNativeMatchQueries(FhirContext fhir, MatchUrlService translator) {
        this.fhir = fhir;
        this.translator = translator;
    }

    /** A local indexed membership query and the exceptional-reference residual partition. */
    record Alternative(SearchParameterMap base, List<SearchParameterMap> complete,
            List<ReferencePartition> references) { }

    /** Presence minus resolved local targets is safe only for a single-valued native path. */
    record ReferencePartition(SearchParameterMap present, SearchParameterMap localTargets) { }

    /** Scalar link cover request; only Patient needs local links projected to avoid HAPI's inner join. */
    record ReferenceSelection(Set<String> paths, Set<String> patients, boolean localLinks,
            SearchParameterMap predicates) {
        ReferenceSelection {
            paths = Set.copyOf(paths); patients = Set.copyOf(patients);
            predicates = org.apache.commons.lang3.SerializationUtils.clone(predicates);
        }
        @Override public SearchParameterMap predicates() {
            return org.apache.commons.lang3.SerializationUtils.clone(predicates);
        }
    }

    /** Candidate predicates are a conservative cover; the complete original grants remain authoritative. */
    record PageSelection(SearchParameterMap client, List<PcmReadGrant> grants,
            SearchParameterMap candidates, String reason) {
        PageSelection {
            // HAPI's clone copies AND/OR lists but shares mutable typed parameter values.
            client = org.apache.commons.lang3.SerializationUtils.clone(client);
            grants = List.copyOf(grants);
            candidates = org.apache.commons.lang3.SerializationUtils.clone(candidates);
        }
        @Override public SearchParameterMap client() { return org.apache.commons.lang3.SerializationUtils.clone(client); }
        @Override public SearchParameterMap candidates() { return org.apache.commons.lang3.SerializationUtils.clone(candidates); }
    }

    /**
     * Keep one native ordered search, rather than concatenating independently limited grant pages.
     * HAPI's reference OR expression uses the same link table for every compartment path. Every
     * potentially authorized non-Patient member has a link, including the exceptional-ID branch.
     * Patient self-membership has no such guarantee: project only matching link IDs, then use
     * one ID-only native stream containing self and those IDs. No Patient bodies are projected.
     * Only common proven scope predicates may be factored outside the grant union. Other scope
     * predicates and sensitivity guards remain with the existing ordinary result rules.
     */
    PageSelection pageSelection(PcmAuthorizedMatchPlan plan, SearchParameterMap client, String type,
            java.util.function.Function<ReferenceSelection, Set<String>> referenceIds) {
        SearchParameterMap candidates = client.clone();
        var grants = plan.grants();
        String reason = "bounded-grant-residual";
        String commonReason = "";
        String filter = grants.get(0).filter();
        if (filter != null && !filter.isBlank() && !PcmSensitivityPolicy.requiresGuard(filter)
                && grants.stream().allMatch(grant -> java.util.Objects.equals(filter, grant.filter()))) {
            var common = translator.translateMatchUrl(filter, fhir.getResourceDefinition(type));
            if (completeScopeFilter(common)) {
                candidates = conjunction(candidates, common);
                commonReason = "+common-native-scope";
            }
        }
        if (grants.stream().allMatch(PcmReadGrant::isPatientGrant)) {
            var parameters = compartmentParameters(type);
            if (!parameters.isEmpty()) {
                Set<String> clauses = new java.util.LinkedHashSet<>();
                boolean patient = "Patient".equals(type);
                for (var grant : grants) {
                    if (patient) clauses.add("_id eq " + literal(grant.patientId()));
                    else for (var parameter : parameters) {
                        clauses.add(parameter.getName() + " eq " + literal("Patient/" + grant.patientId()));
                    }
                }
                var paths = parameters.stream().flatMap(parameter -> parameter.getPathsSplit().stream())
                        .map(path -> path.replace(".where(resolve() is Patient)", ""))
                        .collect(java.util.stream.Collectors.toSet());
                var patients = grants.stream().map(PcmReadGrant::patientId).collect(java.util.stream.Collectors.toSet());
                for (String id : referenceIds.apply(new ReferenceSelection(paths, patients, patient, candidates))) {
                    clauses.add("_id eq " + literal(id));
                }
                candidates.add("_filter", new StringParam(clauses.stream()
                        .map(clause -> "(" + clause + ")").collect(java.util.stream.Collectors.joining(" or "))));
                reason = patient ? "native-patient-self-and-link-ids" : "native-compartment-union-with-reference-residual";
                if (patient && (!client.isEmpty() || !commonReason.isEmpty())) {
                    reason += "+bounded-native-client-probe";
                }
            }
        }
        return new PageSelection(client, grants, candidates, reason + commonReason);
    }

    /** Escape internal literals; no client expression is interpolated into the native union. */
    private static String literal(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** Reuse exactly the compartment alternatives used by COUNT, including generic aliases once. */
    private List<RuntimeSearchParam> compartmentParameters(String type) {
        var parameters = fhir.getResourceDefinition(type).getSearchParamsForCompartmentName("Patient");
        return parameters.stream().distinct().filter(parameter -> parameters.stream().noneMatch(other ->
                other != parameter && parameter.getPathsSplit().size() == 1 && other.getPathsSplit().size() == 1
                && parameter.getPathsSplit().get(0).equals(other.getPathsSplit().get(0)
                        + ".where(resolve() is Patient)"))).toList();
    }

    /** Compile supported complete token/date predicates, or explicitly retain the full matcher. */
    List<Alternative> compile(PcmAuthorizedMatchPlan plan, SearchParameterMap client, String type) {
        var definition = fhir.getResourceDefinition(type);
        List<Alternative> alternatives = new ArrayList<>();
        for (var grant : plan.grants()) {
            // An unsupported label combination cannot be proven safe by token indexes.
            // Retain native candidate traversal plus the same ordinary resource matcher.
            if (PcmSensitivityPolicy.requiresGuard(grant.filter())) return List.of();
            SearchParameterMap filter = grant.filter() == null || grant.filter().isBlank()
                    ? new SearchParameterMap() : translator.translateMatchUrl(grant.filter(), definition);
            // Reference filter equivalence (including foreign URL bases) is not asserted here.
            if (!completeScopeFilter(filter)) return List.of();
            SearchParameterMap base = conjunction(client, filter);
            if (!grant.isPatientGrant()) {
                alternatives.add(new Alternative(base, List.of(base), List.of()));
                continue;
            }
            List<SearchParameterMap> complete = new ArrayList<>();
            List<ReferencePartition> residual = new ArrayList<>();
            if ("Patient".equals(type)) complete.add(with(base, "_id", new TokenParam(grant.patientId())));
            for (var parameter : compartmentParameters(type)) {
                complete.add(with(base, parameter.getName(), new ReferenceParam("Patient/" + grant.patientId())));
                ReferenceParam exists = new ReferenceParam();
                exists.setMissing(false);
                SearchParameterMap present = with(base, parameter.getName(), exists);
                // A foreign absolute reference matches FhirTerser after base removal, but does
                // not match the local PID index. Keep it for the ordinary resource matcher.
                SearchParameterMap localTargets = singleValued(type, parameter)
                        ? with(base, parameter.getName(), new ReferenceParam(null, "_lastUpdated", "ge0001-01-01")) : null;
                residual.add(new ReferencePartition(present, localTargets));
            }
            alternatives.add(new Alternative(base, complete, residual));
        }
        return alternatives;
    }

    /**
     * Prove only scope predicates whose native and ordinary authorization semantics agree.
     * Client parameters keep native FHIR semantics; an unproven grant retains the entire
     * original client traversal so independent grants cannot accidentally become an AND.
     */
    private static boolean completeScopeFilter(SearchParameterMap filter) {
        for (var groups : filter.values()) {
            for (var group : groups) {
                for (IQueryParameterType value : group) {
                    if (value instanceof DateParam date) {
                        if (date.getPrefix() != null && !List.of("eq", "gt", "ge", "lt", "le")
                                .contains(date.getPrefix().getValue())) return false;
                    } else if (value instanceof TokenParam token) {
                        // Explicit empty systems and missing codes differ in HAPI's matcher.
                        if ("".equals(token.getSystem()) || token.getValue() == null
                                || token.getValue().isEmpty()) return false;
                        // In-memory security NOT uses different multi-value OR semantics.
                        if (token.getModifier() == TokenParamModifier.NOT && group.size() > 1) return false;
                    } else return false;
                }
            }
        }
        return true;
    }

    /** Restrict pruning to direct, single-valued paths; nested/repeated paths retain matching. */
    private boolean singleValued(String type, RuntimeSearchParam parameter) {
        var paths = parameter.getPathsSplit();
        if (paths.size() != 1 || !paths.get(0).matches(type + "\\.[A-Za-z]+")) return false;
        return fhir.newTerser().getDefinition(fhir.getResourceDefinition(type).getImplementingClass(), paths.get(0)).getMax() == 1;
    }

    /** Preserve every repeated client AND clause and each scope's independent OR groups. */
    static SearchParameterMap conjunction(SearchParameterMap client, SearchParameterMap filter) {
        SearchParameterMap result = client.clone();
        filter.entrySet().forEach(entry -> entry.getValue().forEach(or -> result.addOrList(entry.getKey(), or)));
        return result;
    }

    /** Add an internal typed native parameter without serializing a scope into an external URL. */
    private static SearchParameterMap with(SearchParameterMap base, String name,
            ca.uhn.fhir.model.api.IQueryParameterType value) {
        SearchParameterMap result = base.clone();
        result.add(name, value);
        return result;
    }
}
