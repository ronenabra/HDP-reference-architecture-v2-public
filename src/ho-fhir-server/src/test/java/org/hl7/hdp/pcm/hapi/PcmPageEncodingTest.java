package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.rest.api.EncodingEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.RestfulServerUtils;
import ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Observation;
import org.hl7.fhir.r4.model.StringType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterEach;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Exact negotiated UTF-8 byte limits, without clinical storage, HTTP or a large fixture. */
class PcmPageEncodingTest {
    final FhirContext fhir = FhirContext.forR4Cached();
    final PcmPageExecutor executor = new PcmPageExecutor(null, null, null, fhir);
    @AfterEach void closeDeadlineFacility() { executor.close(); }

    private SystemRequestDetails request(Map<String, String[]> parameters, String accept) {
        var request = spy(new SystemRequestDetails());
        var server = new RestfulServer(fhir); server.setDefaultResponseEncoding(EncodingEnum.JSON);
        doReturn(server).when(request).getServer();
        doReturn(accept == null ? List.of() : List.of(accept)).when(request).getHeaders("Accept");
        doReturn("https://source.example/fhir").when(request).getFhirServerBase();
        request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE); request.setResourceName("Observation");
        request.setParameters(parameters); return request;
    }
    private Bundle bundle(String value) {
        var observation = new Observation().setStatus(Observation.ObservationStatus.FINAL).setValue(new StringType(value));
        observation.setId("one");
        var bundle = new Bundle().setType(Bundle.BundleType.SEARCHSET);
        bundle.addEntry().setResource(observation).getSearch().setMode(Bundle.SearchEntryMode.MATCH); return bundle;
    }
    private int bytes(SystemRequestDetails request, Bundle bundle) {
        return RestfulServerUtils.getNewParser(fhir, bundle.getStructureFhirVersionEnum(), request)
                .encodeResourceToString(bundle).getBytes(StandardCharsets.UTF_8).length;
    }
    private void rejects(SystemRequestDetails request, Bundle bundle, int limit) {
        assertThatThrownBy(() -> executor.checkPayload(request, bundle, limit))
                .isInstanceOf(BaseServerResponseException.class)
                .extracting(failure -> ((BaseServerResponseException) failure).getStatusCode()).isEqualTo(503);
        verify(request, never()).getResponse();
        var captured = PcmBudgetFailure.capture(request).first();
        assertThat(captured.setting()).isEqualTo("maxPagePayloadBytes");
        assertThat(captured.threshold()).isEqualTo(limit); assertThat(captured.observed()).isGreaterThan(limit);
        assertThat(captured.unit()).isEqualTo("bytes");
    }
    @Test void xmlEscapingCannotBypassTheCompactJsonBudget() {
        Bundle bundle = bundle("<".repeat(600_000));
        var json = request(Map.of(), null); var xml = request(Map.of("_format", new String[]{"xml"}), null);
        assertThat(bytes(json, bundle)).isLessThan(PcmPageExecutor.MAX_PAYLOAD_BYTES);
        assertThat(bytes(xml, bundle)).isGreaterThan(PcmPageExecutor.MAX_PAYLOAD_BYTES);
        executor.checkPayload(json, bundle, PcmPageExecutor.MAX_PAYLOAD_BYTES);
        rejects(xml, bundle, PcmPageExecutor.MAX_PAYLOAD_BYTES);
    }
    @Test void negotiatedFormatAndAcceptRetainExactUtf8Boundaries() {
        Bundle bundle = bundle("<&\"\n שלום 🙂");
        assertThat(bytes(request(Map.of(), "application/fhir+xml"), bundle))
                .isEqualTo(bytes(request(Map.of("_format", new String[]{"xml"}), null), bundle));
        assertThat(bytes(request(Map.of("_format", new String[]{"json"}), "application/fhir+xml"), bundle))
                .isEqualTo(bytes(request(Map.of(), null), bundle));
        for (var request : List.of(request(Map.of(), null), request(Map.of(), "application/fhir+xml"),
                request(Map.of("_format", new String[]{"json"}), "application/fhir+xml"),
                request(Map.of("_format", new String[]{"xml"}, "_pretty", new String[]{"true"}), null))) {
            int size = bytes(request, bundle);
            executor.checkPayload(request, bundle, size);
            rejects(request, bundle, size - 1);
        }
    }
    @Test void prettyPrintExpansionUsesTheSameNegotiatedHapiSettingsAsOutput() {
        Bundle bundle = bundle("small");
        var compact = request(Map.of("_format", new String[]{"json"}), null);
        var pretty = request(Map.of("_format", new String[]{"json"}, "_pretty", new String[]{"true"}), null);
        int limit = bytes(compact, bundle); assertThat(bytes(pretty, bundle)).isGreaterThan(limit);
        executor.checkPayload(compact, bundle, limit); rejects(pretty, bundle, limit);
    }

    @Test void oversizedXmlUsesTheAsyncCompleteRetryableOutcomeBeforeAnySuccessWriter() throws Exception {
        var request = mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
        var requestData = new java.util.HashMap<Object, Object>();
        requestData.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, java.time.Instant.now().plusSeconds(30));
        when(request.getUserData()).thenReturn(requestData);
        var servlet = mock(jakarta.servlet.http.HttpServletRequest.class);
        var servletResponse = mock(jakarta.servlet.http.HttpServletResponse.class);
        var response = mock(ca.uhn.fhir.rest.api.server.IRestfulResponse.class);
        var async = mock(jakarta.servlet.AsyncContext.class);
        var input = mock(jakarta.servlet.ServletInputStream.class);
        var server = new RestfulServer(fhir); server.setDefaultResponseEncoding(EncodingEnum.JSON);
        when(request.getServer()).thenReturn(server); when(request.getResponse()).thenReturn(response);
        when(request.getServletRequest()).thenReturn(servlet); when(request.getServletResponse()).thenReturn(servletResponse);
        when(request.getResourceName()).thenReturn("Observation"); when(request.getRequestPath()).thenReturn("Observation");
        when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE);
        when(request.getRequestType()).thenReturn(ca.uhn.fhir.rest.api.RequestTypeEnum.GET);
        when(request.getParameters()).thenReturn(Map.of("_format", new String[]{"xml"}));
        when(request.getFhirServerBase()).thenReturn("https://source.example/fhir");
        when(servlet.isAsyncSupported()).thenReturn(true); when(servlet.startAsync()).thenReturn(async);
        when(servlet.getInputStream()).thenReturn(input); when(input.isFinished()).thenReturn(true);
        var output = new java.io.StringWriter();
        when(response.getResponseWriter(eq(503), anyString(), anyString(), eq(false))).thenReturn(output);
        var finished = new java.util.concurrent.CountDownLatch(1);
        doAnswer(call -> { finished.countDown(); return null; }).when(async).complete();
        var pages = mock(PcmPageExecutor.class);
        Bundle oversized = bundle("<".repeat(600_000));
        when(pages.page(eq(request), any(), any())).thenAnswer(call -> {
            executor.checkPayload(request, oversized, PcmPageExecutor.MAX_PAYLOAD_BYTES); return oversized;
        });
        var context = new PcmRequestContext("ho-a", "client", List.of(new PcmReadGrant("Observation", null, "p")));
        SignedRequestContextVerifier verifier = ignored -> context;
        var connection = mock(PcmCountConnection.class);
        when(connection.lock()).thenReturn(new java.util.concurrent.locks.ReentrantLock());
        try (var transport = mockStatic(PcmCountTomcatProtocol.class);
                var delegate = new PcmCountInterceptor(verifier, new PcmRoutePolicyInterceptor(verifier),
                        mock(PcmAuthorizedMatchExecutor.class), pages)) {
            transport.when(() -> PcmCountTomcatProtocol.connection(servlet)).thenReturn(connection);
            assertThat(delegate.count(request)).isFalse();
            assertThat(finished.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            verify(response, never()).getResponseWriter(eq(200), any(), any(), anyBoolean());
            verify(response).commitResponse(output); verify(servletResponse).setHeader("Retry-After", "1");
            var outcome = fhir.newXmlParser().parseResource(org.hl7.fhir.r4.model.OperationOutcome.class, output.toString());
            assertThat(outcome.getIssueFirstRep().getSeverity()).isEqualTo(org.hl7.fhir.r4.model.OperationOutcome.IssueSeverity.ERROR);
            assertThat(output.toString()).doesNotContain("<Bundle");
        }
    }
}
