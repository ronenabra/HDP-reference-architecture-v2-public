package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.IPreResourceAccessDetails;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentInterceptor;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentOperationStatusEnum;
import ca.uhn.fhir.rest.server.interceptor.consent.IConsentContextServices;
import ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService;

/** Apply the existing Consent result rules to a POST search as a read interaction. */
final class PcmSearchConsentInterceptor extends ConsentInterceptor {
    private final RuleFilteringConsentService service;

    /** Retain the same single ordinary rule service and all upstream Consent lifecycle hooks. */
    PcmSearchConsentInterceptor(RuleFilteringConsentService service) { super(service); this.service = service; }

    /** HAPI 8.10 classifies all POST rejections as writes; searches must instead omit denied results. */
    @Override @Hook(Pointcut.STORAGE_PREACCESS_RESOURCES)
    public void interceptPreAccess(RequestDetails request, IPreResourceAccessDetails resources) {
        boolean postSearch = request.getRequestType() == RequestTypeEnum.POST
                && request.getRestOperationType() == RestOperationTypeEnum.SEARCH_TYPE
                && (request.getResourceName() + "/_search").equals(request.getRequestPath());
        if (!postSearch) { super.interceptPreAccess(request, resources); return; }
        if (isSkipServiceForRequest(request) || !service.shouldProcessCanSeeResource(request, IConsentContextServices.NULL_IMPL)) return;
        // Use the unchanged native rule service with the actual POST RequestDetails.
        // No request mutation, GET delegate, skip flag or alternate authorization engine.
        for (int index = 0; index < resources.size(); index++) {
            var outcome = java.util.Objects.requireNonNull(service.canSeeResource(request, resources.getResource(index), IConsentContextServices.NULL_IMPL));
            if (outcome.getResource() != null) throw new IllegalStateException("Consent canSeeResource cannot replace a resource");
            if (java.util.Objects.requireNonNull(outcome.getStatus()) == ConsentOperationStatusEnum.REJECT) resources.setDontReturnResourceAtIndex(index);
        }
    }
}
