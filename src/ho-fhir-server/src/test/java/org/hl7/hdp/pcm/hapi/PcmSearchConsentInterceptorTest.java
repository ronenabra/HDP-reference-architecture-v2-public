package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.IPreResourceAccessDetails;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.interceptor.consent.*;
import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Read filtering for exact POST searches, with unchanged write rejection and request identity. */
class PcmSearchConsentInterceptorTest {
    @Test void mixedPostSearchFiltersDeniedRowsUsingTheSameActualRequest() {
        var service = mock(RuleFilteringConsentService.class);
        var request = new SystemRequestDetails(); request.setRequestType(RequestTypeEnum.POST);
        request.setResourceName("Observation"); request.setRequestPath("Observation/_search");
        request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        var allowed = new Observation(); var denied = new Observation();
        var rows = mock(IPreResourceAccessDetails.class); when(rows.size()).thenReturn(2);
        when(rows.getResource(0)).thenReturn(allowed); when(rows.getResource(1)).thenReturn(denied);
        when(service.shouldProcessCanSeeResource(request, IConsentContextServices.NULL_IMPL)).thenReturn(true);
        when(service.canSeeResource(request, allowed, IConsentContextServices.NULL_IMPL)).thenReturn(ConsentOutcome.PROCEED);
        when(service.canSeeResource(request, denied, IConsentContextServices.NULL_IMPL)).thenReturn(ConsentOutcome.REJECT);
        new PcmSearchConsentInterceptor(service).interceptPreAccess(request, rows);
        verify(rows).setDontReturnResourceAtIndex(1); verify(rows, never()).setDontReturnResourceAtIndex(0);
        assertThat(request.getRequestType()).isEqualTo(RequestTypeEnum.POST);
        assertThat(request.getRequestPath()).isEqualTo("Observation/_search");
    }

    @Test void failedRuleEvaluationCannotBecomeAnAllowedResult() {
        var service = mock(RuleFilteringConsentService.class);
        var request = new SystemRequestDetails(); request.setRequestType(RequestTypeEnum.POST);
        request.setResourceName("Observation"); request.setRequestPath("Observation/_search"); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        when(service.shouldProcessCanSeeResource(any(), any())).thenReturn(true);
        when(service.canSeeResource(any(), any(), any())).thenThrow(new IllegalStateException("matcher unavailable"));
        var rows = mock(IPreResourceAccessDetails.class); when(rows.size()).thenReturn(1); when(rows.getResource(0)).thenReturn(new Observation());
        assertThatThrownBy(() -> new PcmSearchConsentInterceptor(service).interceptPreAccess(request, rows)).isInstanceOf(IllegalStateException.class);
    }

    @Test void ordinaryPostWriteStillUsesUpstreamRejectionAndExplicitMaintenanceSkipIsPreserved() {
        var service = mock(RuleFilteringConsentService.class);
        when(service.shouldProcessCanSeeResource(any(), any())).thenReturn(true);
        when(service.canSeeResource(any(), any(), any())).thenReturn(ConsentOutcome.REJECT);
        var request = new SystemRequestDetails(); request.setRequestType(RequestTypeEnum.POST);
        request.setResourceName("Observation"); request.setRequestPath("Observation"); request.setRestOperationType(RestOperationTypeEnum.CREATE);
        var rows = mock(IPreResourceAccessDetails.class); when(rows.size()).thenReturn(1); when(rows.getResource(0)).thenReturn(new Observation());
        var interceptor = new PcmSearchConsentInterceptor(service);
        assertThatThrownBy(() -> interceptor.interceptPreAccess(request, rows)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
        request.setRequestPath("Observation/_search"); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        ConsentInterceptor.skipAllConsentForRequest(request); clearInvocations(service, rows);
        interceptor.interceptPreAccess(request, rows); verifyNoInteractions(service, rows);
    }
}
