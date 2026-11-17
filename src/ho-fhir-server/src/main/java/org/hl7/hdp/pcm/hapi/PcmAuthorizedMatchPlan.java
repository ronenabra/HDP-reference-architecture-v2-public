package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentOperationStatusEnum;
import ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService;
import org.hl7.fhir.instance.model.api.IBaseResource;

/** One reusable search-specific view of the existing effective grants and HAPI result matcher. */
public final class PcmAuthorizedMatchPlan {
    private final RequestDetails request;
    private final RuleFilteringConsentService matcher;
    private final boolean nativeComplete;
    private final java.util.List<PcmReadGrant> grants;

    /** Prove search applicability once without introducing a second authorization compiler. */
    public PcmAuthorizedMatchPlan(RequestDetails request, PcmRequestContext context, RuleFilteringConsentService matcher) {
        this.request = request;
        this.matcher = matcher;
        var applicable = context.readGrants().stream().filter(grant ->
                grant.resourceType().equals(request.getResourceName())
                && PcmInteractionGate.permits(grant, RestOperationTypeEnum.SEARCH_TYPE)).toList();
        if (context.kind() != PcmRequestContext.Kind.DATA_SOURCE_ACCESS || applicable.isEmpty()
                || context.readGrants().stream().anyMatch(grant ->
                !PcmFilterSupport.isSupported(grant.resourceType(), grant.filter()))) {
            throw new ForbiddenOperationException("PCM search permission required");
        }
        grants = applicable.stream().distinct().toList();
        nativeComplete = applicable.stream().anyMatch(grant -> !grant.isPatientGrant()
                && (grant.filter() == null || grant.filter().isBlank()));
    }

    /** True only when an unrestricted applicable system search grant covers the entire client query. */
    public boolean nativeComplete() { return nativeComplete; }

    /** Independent search-applicable alternatives from the existing effective-grant compiler. */
    java.util.List<PcmReadGrant> grants() { return grants; }

    /** Apply the same patient, grant-union and conjunctive resource rules as ordinary search. */
    public boolean permits(IBaseResource resource) {
        return matcher.canSeeResource(request, resource, null).getStatus() != ConsentOperationStatusEnum.REJECT;
    }
}
