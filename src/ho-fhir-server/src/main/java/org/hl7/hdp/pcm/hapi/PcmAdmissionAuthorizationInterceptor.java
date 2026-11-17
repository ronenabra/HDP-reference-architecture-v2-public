package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.AuthorizationInterceptor;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRule;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRuleBuilder;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.RuleBuilder;

import java.util.List;

/** Admits only declared read interactions; exact resource filtering remains in Consent. */
public final class PcmAdmissionAuthorizationInterceptor extends AuthorizationInterceptor {
    private final SignedRequestContextVerifier verifier;

    private static final String REASON = PcmAdmissionAuthorizationInterceptor.class.getName() + ".reason";
    private final PcmRuntimeObservability observations;
    public PcmAdmissionAuthorizationInterceptor(SignedRequestContextVerifier verifier) { this(verifier, null); }
    PcmAdmissionAuthorizationInterceptor(SignedRequestContextVerifier verifier, PcmRuntimeObservability observations) {
        super(PolicyEnum.DENY); this.verifier = verifier; this.observations = observations;
    }

    /** Native verdict is observed after rule execution, never reconstructed by another policy pass. */
    @Override public Verdict applyRulesAndReturnDecision(RestOperationTypeEnum operation, RequestDetails request,
            org.hl7.fhir.instance.model.api.IBaseResource input, org.hl7.fhir.instance.model.api.IIdType id,
            org.hl7.fhir.instance.model.api.IBaseResource output, ca.uhn.fhir.interceptor.api.Pointcut pointcut) {
        Verdict result = super.applyRulesAndReturnDecision(operation, request, input, id, output, pointcut);
        if (observations != null) observations.admission(request, pointcut, result.getDecision() == PolicyEnum.ALLOW ? "pass" : "fail",
                result.getDecision() == PolicyEnum.ALLOW ? "ADMISSION_ALLOWED" : String.valueOf(request.getUserData().getOrDefault(REASON, "DEFAULT_DENY")));
        return result;
    }

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
        if (context.importAccess()) return new RuleBuilder().allowAll("Private clinical-data import").build();
        if (context.kind() == PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE) {
            return new RuleBuilder().allow("Fixed local sandbox Patient search").read()
                    .resourcesOfType("Patient").withAnyId().build();
        }
        if ((context.kind() == PcmRequestContext.Kind.ONLINE_PRESENCE
                || context.kind() == PcmRequestContext.Kind.DEPENDENT_DISCOVERY)
                && requestDetails.getRestOperationType() == RestOperationTypeEnum.TRANSACTION) {
            return new RuleBuilder().allowAll("Validated read-only system batch provider").build();
        }
        if (context.kind() == PcmRequestContext.Kind.ONLINE_PRESENCE) {
            return new RuleBuilder().allow("Exact online Patient count").read()
                    .resourcesOfType("Patient").withAnyId().build();
        }
        if (context.kind() == PcmRequestContext.Kind.BATCH_PRESENCE) {
            return new RuleBuilder().allowAll("Validated read-only batch presence provider").build();
        }
        if (requestDetails.getRestOperationType() == RestOperationTypeEnum.METADATA) {
            return new RuleBuilder().allow("PCM limited capability statement").metadata().build();
        }
        IAuthRuleBuilder rules = new RuleBuilder();
        boolean admitted = false, resourceGrant = false;
        for (PcmReadGrant grant : context.readGrants()) {
            if (grant.masterRead() && requestDetails.getRequestType() != null
                    && requestDetails.getRequestType() != ca.uhn.fhir.rest.api.RequestTypeEnum.GET) continue;
            if (!PcmFilterSupport.isSupported(grant.resourceType(), grant.filter())) {
                requestDetails.getUserData().put(REASON, "UNSUPPORTED_SCOPE");
                return new RuleBuilder().denyAll("Unsupported PCM scope expression").build();
            }
            if (grant.resourceType().equals(requestDetails.getResourceName())) resourceGrant = true;
            if (PcmInteractionGate.permitsAdmission(
                    grant, requestDetails.getRestOperationType(), requestDetails.getResourceName())) {
                admitted = true;
                rules = rules.allow("PCM admitted read interaction").read()
                        .resourcesOfType(grant.resourceType()).withAnyId().andThen();
            }
        }
        if (!admitted && resourceGrant) requestDetails.getUserData().put(REASON, "UNSUPPORTED_INTERACTION");
        return rules.denyAll("PCM interaction default deny").build();
    }
}
