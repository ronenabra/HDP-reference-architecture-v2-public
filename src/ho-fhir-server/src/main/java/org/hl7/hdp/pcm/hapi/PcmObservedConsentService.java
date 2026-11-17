package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.IRuleApplier;
import ca.uhn.fhir.rest.server.interceptor.consent.*;
import org.hl7.fhir.instance.model.api.IBaseResource;

/** Observe exactly the result of the native rule service used by ordinary and bounded executors. */
final class PcmObservedConsentService extends RuleFilteringConsentService {
    private final PcmRuntimeObservability observations;
    PcmObservedConsentService(IRuleApplier rules, PcmRuntimeObservability observations) { super(rules); this.observations = observations; }
    @Override public ConsentOutcome canSeeResource(RequestDetails request, IBaseResource resource, IConsentContextServices services) {
        var evaluation = observations.beginResourceEvaluation();
        try {
            ConsentOutcome result = super.canSeeResource(request, resource, services);
            observations.resource(request, resource, result.getStatus() != ConsentOperationStatusEnum.REJECT, evaluation);
            return result;
        } finally { PcmRuntimeObservability.endEvaluation(evaluation); }
    }
}
