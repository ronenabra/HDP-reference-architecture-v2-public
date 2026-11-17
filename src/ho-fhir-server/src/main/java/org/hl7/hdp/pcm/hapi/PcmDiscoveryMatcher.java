package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.param.ReferenceParam;
import ca.uhn.fhir.rest.param.TokenParam;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.RelatedPerson;

import java.util.function.BiPredicate;

/** Exact discovery reverse-chain enforcement for each returned Patient, including pages. */
public final class PcmDiscoveryMatcher implements IAuthorizationSearchParamMatcher {
    private static final String PREFIX = "Patient?_has:RelatedPerson:patient:identifier=";
    private static final String INTERNAL = PcmDiscoveryMatcher.class.getName() + ".relationshipLookup";
    private final IAuthorizationSearchParamMatcher ordinary;
    private final BiPredicate<PcmPatientIdentifier, String> related;

    /** Use a bounded native DAO lookup with both restrictions on the same RelatedPerson. */
    public PcmDiscoveryMatcher(IAuthorizationSearchParamMatcher ordinary, DaoRegistry registry) {
        this(ordinary, (identifier, patientId) -> {
            SearchParameterMap query = new SearchParameterMap()
                    .add(RelatedPerson.SP_IDENTIFIER, new TokenParam(identifier.system(), identifier.value()))
                    .add(RelatedPerson.SP_PATIENT, new ReferenceParam("Patient/" + patientId))
                    .setCount(1).setLoadSynchronous(true);
            SystemRequestDetails internal = new SystemRequestDetails();
            internal.getUserData().put(INTERNAL, Boolean.TRUE);
            return !registry.getResourceDao(RelatedPerson.class).searchForResources(query, internal).isEmpty();
        });
    }

    /** Injectable relationship predicate for deterministic policy tests. */
    PcmDiscoveryMatcher(IAuthorizationSearchParamMatcher ordinary, BiPredicate<PcmPatientIdentifier, String> related) {
        this.ordinary = ordinary;
        this.related = related;
    }

    @Override
    public MatchResult match(String expression, IBaseResource resource) {
        MatchResult result = matchObserved(expression, resource);
        PcmRuntimeObservability.predicate(expression, "native-expression", result.match == Match.MATCH);
        return result;
    }

    private MatchResult matchObserved(String expression, IBaseResource resource) {
        if (!PcmSensitivityPolicy.permits(expression, resource)) {
            PcmRuntimeObservability.predicate(expression, "sensitivity-policy", false);
            return MatchResult.buildUnmatched();
        }
        if (expression == null || !expression.startsWith(PREFIX)) return ordinary.match(expression, resource);
        if (!(resource instanceof Patient patient) || patient.getIdElement().getIdPart() == null
                || !PcmFilterSupport.isSupported("Patient", expression.substring("Patient?".length()))) {
            return MatchResult.buildUnmatched();
        }
        String[] clauses = expression.substring(PREFIX.length()).split("&", -1);
        if (clauses.length > 1 && ordinary.match("Patient?" + clauses[1], resource).match != Match.MATCH) return MatchResult.buildUnmatched();
        String[] identifier = clauses[0].split("\\|", -1);
        try {
            return related.test(new PcmPatientIdentifier(identifier[0], identifier[1]), patient.getIdElement().getIdPart())
                    ? MatchResult.buildMatched() : MatchResult.buildUnmatched();
        } catch (RuntimeException failedLookup) {
            return MatchResult.buildUnmatched();
        }
    }

    /** The exception exists only for an in-process, bounded relationship lookup. */
    static boolean isInternalLookup(RequestDetails request) {
        return request != null && Boolean.TRUE.equals(request.getUserData().get(INTERNAL));
    }
}
