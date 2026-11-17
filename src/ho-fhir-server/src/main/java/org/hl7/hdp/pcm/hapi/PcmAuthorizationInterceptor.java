package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.model.primitive.IdDt;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.AuthorizationInterceptor;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRule;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRuleBuilder;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRuleFinished;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.RuleBuilder;

import java.util.List;

/** Deny-first HAPI authorization interceptor driven by verified PCM context. */
public final class PcmAuthorizationInterceptor extends AuthorizationInterceptor {
    private final SignedRequestContextVerifier verifier;

    /** Create the interceptor with the production verifier seam and HAPI matcher. */
    public PcmAuthorizationInterceptor(
            SignedRequestContextVerifier verifier,
            IAuthorizationSearchParamMatcher searchParamMatcher) {
        super(PolicyEnum.DENY);
        this.verifier = verifier;
        setAuthorizationSearchParamMatcher(searchParamMatcher);
    }

    /** Build one allow rule per grant and a terminal deny-all rule. */
    @Override
    public List<IAuthRule> buildRuleList(RequestDetails requestDetails) {
        if (PcmDiscoveryMatcher.isInternalLookup(requestDetails)) {
            return new RuleBuilder().allow("Bounded internal relationship lookup").read()
                    .resourcesOfType("RelatedPerson").withAnyId().build();
        }
        if (HapiPatientIdentifierResolver.isInternalResolution(requestDetails)) {
            return new RuleBuilder().allow("Exact internal Patient lookup").read()
                    .resourcesOfType("Patient").withAnyId().build();
        }
        final PcmRequestContext context;
        try {
            context = verifier.verify(requestDetails);
        } catch (RuntimeException rejected) {
            return new RuleBuilder().denyAll("PCM context missing or invalid").build();
        }

        if (context.importAccess()) {
            return new RuleBuilder().allowAll("Private clinical-data import").build();
        }
        if (context.kind() == PcmRequestContext.Kind.ONLINE_PRESENCE
                || context.kind() == PcmRequestContext.Kind.BATCH_PRESENCE) {
            return new RuleBuilder().allowAll("Pre-authorized count-only presence").build();
        }

        IAuthRuleBuilder rules = new RuleBuilder();
        if (requestDetails.getRestOperationType() == RestOperationTypeEnum.METADATA) {
            return rules.allow("PCM limited capability statement").metadata().build();
        }
        List<PcmReadGrant> effectiveGrants = context.readGrants();
        for (PcmReadGrant originalGrant : effectiveGrants) {
            PcmReadGrant grant = originalGrant;
            if (grant.masterRead() && requestDetails.getRequestType() != null
                    && requestDetails.getRequestType() != ca.uhn.fhir.rest.api.RequestTypeEnum.GET) continue;
            PcmEverythingPolicy.Target operationTarget = PcmEverythingPolicy.target(requestDetails);
            if (operationTarget != null && grant.isPatientGrant() && !operationTarget.patient().equals(grant.patientId())) continue;
            if (operationTarget != null && !java.util.Set.of("Practitioner", "Organization", "PractitionerRole", "Location").contains(grant.resourceType())) {
                grant = new PcmReadGrant(grant.resourceType(), grant.filter(), operationTarget.patient(), grant.interactions());
            }
            if (!PcmFilterSupport.isSupported(grant.resourceType(), grant.filter())) {
                return new RuleBuilder().denyAll("Unsupported PCM scope expression").build();
            }
            if (PcmEverythingPolicy.target(requestDetails) != null && !grant.interactions().contains('s')) continue;
            if (PcmEverythingPolicy.target(requestDetails) == null && !PcmInteractionGate.permitsResult(
                    grant,
                    context.kind() == PcmRequestContext.Kind.DEPENDENT_DISCOVERY
                            && requestDetails.getRestOperationType() == RestOperationTypeEnum.TRANSACTION
                            ? RestOperationTypeEnum.SEARCH_TYPE : requestDetails.getRestOperationType(),
                    requestDetails.getResourceName())) {
                continue;
            }
            PcmRuntimeObservability.applicableGrant(requestDetails, grant);
            IAuthRuleFinished rule;
            if (grant.isPatientGrant() && !grant.masterRead()) {
                IdDt patientId = new IdDt("Patient", grant.patientId());
                rule = grant.filter() == null || grant.filter().isBlank()
                        ? rules.allow("PCM Patient read").read().resourcesOfType(grant.resourceType())
                                .inCompartment("Patient", patientId)
                        : rules.allow("PCM Patient filtered read").read().resourcesOfType(grant.resourceType())
                                .inCompartmentWithFilter("Patient", patientId, grant.filter());
            } else {
                rule = grant.filter() == null || grant.filter().isBlank()
                        ? rules.allow("PCM system read").read().resourcesOfType(grant.resourceType()).withAnyId()
                        : rules.allow("PCM system filtered read").read().resourcesOfType(grant.resourceType())
                                .withFilter(grant.filter());
            }
            rules = rule.andThen();
        }
        return rules.denyAll("PCM default deny").build();
    }
}
