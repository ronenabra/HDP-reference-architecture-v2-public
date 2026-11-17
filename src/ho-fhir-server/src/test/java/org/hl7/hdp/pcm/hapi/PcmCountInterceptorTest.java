package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** The aggregate delegate cannot turn non-search routes or special contexts into clinical counts. */
class PcmCountInterceptorTest {
    final PcmRequestContext context = new PcmRequestContext("ho-a", "client", List.of(new PcmReadGrant("Observation", null, "patient")));
    final PcmAuthorizedMatchExecutor executor = mock(PcmAuthorizedMatchExecutor.class);
    final SignedRequestContextVerifier verifier = request -> context;
    final PcmCountConnection connection = mock(PcmCountConnection.class);
    final PcmCountInterceptor interceptor = new PcmCountInterceptor(verifier, new PcmRoutePolicyInterceptor(verifier), executor,
            request -> connection);

    PcmCountInterceptorTest() {
        when(connection.lock()).thenReturn(new java.util.concurrent.locks.ReentrantLock());
    }

    private SystemRequestDetails request(String path, RequestTypeEnum method, RestOperationTypeEnum operation) {
        SystemRequestDetails request = new SystemRequestDetails();
        request.setRequestPath(path); request.setResourceName("Observation"); request.setRequestType(method);
        request.setRestOperationType(operation); request.setParameters(Map.of("_summary", new String[]{"count"}));
        return request;
    }

    @Test void rejectsReadHistoryPostAndAdvancedShapesBeforeDaoExecution() {
        for (SystemRequestDetails request : List.of(
                request("Observation/one", RequestTypeEnum.GET, RestOperationTypeEnum.READ),
                request("Observation/_history", RequestTypeEnum.GET, RestOperationTypeEnum.HISTORY_TYPE),
                request("Observation", RequestTypeEnum.POST, RestOperationTypeEnum.SEARCH_TYPE),
                request("Observation/$everything", RequestTypeEnum.GET, RestOperationTypeEnum.EXTENDED_OPERATION_TYPE))) {
            assertThatThrownBy(() -> interceptor.count(request)).isInstanceOf(ForbiddenOperationException.class);
        }
        verifyNoInteractions(executor);
    }

    @Test void formCountUsesTheSameWorkerAfterNativeParsing() throws Exception {
        var request = mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
        var data = new java.util.HashMap<Object, Object>();
        data.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, java.time.Instant.now().plusSeconds(30));
        when(request.getUserData()).thenReturn(data);
        var input = mock(jakarta.servlet.http.HttpServletRequest.class);
        var async = mock(jakarta.servlet.AsyncContext.class);
        when(request.getServletRequest()).thenReturn(input);
        when(input.isAsyncSupported()).thenReturn(true); when(input.startAsync()).thenReturn(async);
        when(input.getContentType()).thenReturn("application/x-www-form-urlencoded; charset=UTF-8");
        when(request.getRequestType()).thenReturn(RequestTypeEnum.POST);
        when(request.getRequestPath()).thenReturn("Observation/_search"); when(request.getResourceName()).thenReturn("Observation");
        when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE);
        when(request.getParameters()).thenReturn(Map.of("_summary", new String[]{"count"}, "status", new String[]{"final", "final"}));
        try {
            assertThat(interceptor.count(request)).isFalse();
            verify(executor, timeout(2000)).count(eq(request), eq(context), any(PcmCountCancellation.class));
            verify(request).loadRequestContents();
        } finally { interceptor.close(); }
    }

    @Test void leavesOrdinarySearchAndMaintenanceOnTheirExistingPaths() throws Exception {
        SystemRequestDetails ordinary = request("Observation", RequestTypeEnum.GET, RestOperationTypeEnum.SEARCH_TYPE);
        ordinary.setParameters(Map.of());
        assertThat(interceptor.count(ordinary)).isTrue();
        SignedRequestContextVerifier importer = request -> new PcmRequestContext("ho-a", "maintenance", List.of(), true);
        assertThat(new PcmCountInterceptor(importer, new PcmRoutePolicyInterceptor(importer), executor)
                .count(request("Observation", RequestTypeEnum.GET, RestOperationTypeEnum.SEARCH_TYPE))).isTrue();
        verifyNoInteractions(executor);
    }

    @Test void rejectsForgedContextBeforeParsingOrDaoExecution() {
        SignedRequestContextVerifier invalid = request -> { throw new SecurityException("invalid signature"); };
        assertThatThrownBy(() -> new PcmCountInterceptor(invalid, new PcmRoutePolicyInterceptor(invalid), executor)
                .count(request("Observation", RequestTypeEnum.GET, RestOperationTypeEnum.SEARCH_TYPE)))
                .isInstanceOf(ForbiddenOperationException.class);
        verifyNoInteractions(executor);
    }

    @Test void verifiedHeadKeepsNativeAuthorizationWithoutStartingCountOrPageWorkers() throws Exception {
        var pages = mock(PcmPageExecutor.class);
        var signed = mock(SignedRequestContextVerifier.class);
        when(signed.verify(any())).thenReturn(context);
        try (var delegate = new PcmCountInterceptor(signed, new PcmRoutePolicyInterceptor(signed), executor, pages)) {
            for (var parameters : List.of(Map.of("_count", new String[]{"1"}),
                    Map.of("_summary", new String[]{"count"}))) {
                var head = request("Observation", RequestTypeEnum.HEAD, RestOperationTypeEnum.SEARCH_TYPE);
                head.setParameters(parameters);
                var original = head.getParameters();
                assertThat(delegate.count(head)).isTrue();
                verify(signed).verify(head);
                assertThat(head.getParameters().keySet()).isEqualTo(original.keySet());
                original.forEach((name, values) -> assertThat(head.getParameters().get(name)).containsExactly(values));
            }
        }
        verify(pages).close(); verifyNoMoreInteractions(pages); verifyNoInteractions(executor);
    }

    @Test void headStillRejectsAnInvalidOriginalSignature() {
        var pages = mock(PcmPageExecutor.class);
        SignedRequestContextVerifier invalid = request -> { throw new SecurityException("wrong signed method"); };
        try (var delegate = new PcmCountInterceptor(invalid, new PcmRoutePolicyInterceptor(invalid), executor, pages)) {
            assertThatThrownBy(() -> delegate.count(request("Observation", RequestTypeEnum.HEAD,
                    RestOperationTypeEnum.SEARCH_TYPE))).isInstanceOf(ForbiddenOperationException.class);
        }
        verify(pages).close(); verifyNoMoreInteractions(pages); verifyNoInteractions(executor);
    }

    @Test void servletTransportErrorCancelsTheBoundedWorkerAndItsNativeToken() throws Exception {
        var request = mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
        var requestData = new java.util.HashMap<Object, Object>();
        requestData.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, java.time.Instant.now().plusSeconds(30));
        when(request.getUserData()).thenReturn(requestData);
        var servlet = mock(jakarta.servlet.http.HttpServletRequest.class);
        var async = mock(jakarta.servlet.AsyncContext.class);
        when(request.getServletRequest()).thenReturn(servlet);
        var stream = mock(jakarta.servlet.ServletInputStream.class);
        when(servlet.getInputStream()).thenReturn(stream); when(stream.isFinished()).thenReturn(true);
        when(servlet.isAsyncSupported()).thenReturn(true); when(servlet.startAsync()).thenReturn(async);
        when(request.getParameters()).thenReturn(Map.of("_summary", new String[]{"count"}));
        when(request.getResourceName()).thenReturn("Observation"); when(request.getRequestPath()).thenReturn("Observation");
        when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE);
        when(request.getRequestType()).thenReturn(RequestTypeEnum.GET);
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch stopped = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<PcmCountCancellation> token = new java.util.concurrent.atomic.AtomicReference<>();
        when(executor.count(eq(request), eq(context), any(PcmCountCancellation.class))).thenAnswer(invocation -> {
            PcmCountCancellation cancellation = invocation.getArgument(2); token.set(cancellation); entered.countDown();
            try {
                while (!cancellation.isCancelled()) Thread.sleep(5);
                throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("cancelled");
            } finally { stopped.countDown(); }
        });
        try {
            assertThat(interceptor.count(request)).isFalse();
            assertThat(entered.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            var listener = org.mockito.ArgumentCaptor.forClass(jakarta.servlet.AsyncListener.class);
            verify(async).addListener(listener.capture());
            listener.getValue().onError(mock(jakarta.servlet.AsyncEvent.class));
            assertThat(stopped.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(token.get().isCancelled()).isTrue();
            verify(async, atLeastOnce()).complete();
        } finally { interceptor.close(); }
    }

    @Test void realConnectionObservationCancelsWithoutAReportedServletError() throws Exception {
        var request = mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
        var requestData = new java.util.HashMap<Object, Object>();
        requestData.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, java.time.Instant.now().plusSeconds(30));
        when(request.getUserData()).thenReturn(requestData);
        var servlet = mock(jakarta.servlet.http.HttpServletRequest.class);
        var async = mock(jakarta.servlet.AsyncContext.class);
        var stream = mock(jakarta.servlet.ServletInputStream.class);
        when(request.getServletRequest()).thenReturn(servlet);
        when(servlet.getInputStream()).thenReturn(stream); when(stream.isFinished()).thenReturn(true);
        when(servlet.isAsyncSupported()).thenReturn(true); when(servlet.startAsync()).thenReturn(async);
        when(request.getParameters()).thenReturn(Map.of("_summary", new String[]{"count"}));
        when(request.getResourceName()).thenReturn("Observation"); when(request.getRequestPath()).thenReturn("Observation");
        when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE);
        when(request.getRequestType()).thenReturn(RequestTypeEnum.GET);
        var entered = new java.util.concurrent.CountDownLatch(1);
        var stopped = new java.util.concurrent.CountDownLatch(1);
        var observed = new java.util.concurrent.atomic.AtomicBoolean();
        var token = new java.util.concurrent.atomic.AtomicReference<PcmCountCancellation>();
        when(connection.hasAdditionalInput()).thenAnswer(invocation -> {
            if (observed.get()) throw new java.io.EOFException("closed peer");
            return false;
        });
        when(executor.count(eq(request), eq(context), any(PcmCountCancellation.class))).thenAnswer(invocation -> {
            token.set(invocation.getArgument(2)); entered.countDown();
            try { new java.util.concurrent.CountDownLatch(1).await(); return 123; }
            finally { stopped.countDown(); }
        });
        try {
            assertThat(interceptor.count(request)).isFalse();
            assertThat(entered.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            observed.set(true);
            assertThat(stopped.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(token.get().isCancelled()).isTrue();
            verify(async, org.mockito.Mockito.timeout(1000).atLeastOnce()).complete();
            verify(request, never()).getServer();
        } finally { interceptor.close(); }
    }

    @Test void countRejectsBodiesBeforeAsyncOrDaoExecution() throws Exception {
        var request = mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
        var requestData = new java.util.HashMap<Object, Object>();
        requestData.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, java.time.Instant.now().plusSeconds(30));
        when(request.getUserData()).thenReturn(requestData);
        var servlet = mock(jakarta.servlet.http.HttpServletRequest.class);
        when(request.getServletRequest()).thenReturn(servlet); when(servlet.isAsyncSupported()).thenReturn(true);
        when(request.getParameters()).thenReturn(Map.of("_summary", new String[]{"count"}));
        when(request.getResourceName()).thenReturn("Observation"); when(request.getRequestPath()).thenReturn("Observation");
        when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE);
        when(request.getRequestType()).thenReturn(RequestTypeEnum.GET); when(servlet.getContentLengthLong()).thenReturn(1L);
        assertThatThrownBy(() -> interceptor.count(request)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        verify(servlet, never()).startAsync(); verifyNoInteractions(executor);
    }
    @Test void workerBudgetFailureDoesNotInterruptItsOwnOperationOutcomeSerialization() throws Exception {
        var request = mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
        var requestData = new java.util.HashMap<Object, Object>();
        requestData.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE, java.time.Instant.now().plusSeconds(30));
        when(request.getUserData()).thenReturn(requestData);
        var servlet = mock(jakarta.servlet.http.HttpServletRequest.class);
        var async = mock(jakarta.servlet.AsyncContext.class);
        var stream = mock(jakarta.servlet.ServletInputStream.class);
        when(request.getServletRequest()).thenReturn(servlet);
        when(servlet.getInputStream()).thenReturn(stream); when(stream.isFinished()).thenReturn(true);
        when(servlet.isAsyncSupported()).thenReturn(true); when(servlet.startAsync()).thenReturn(async);
        when(request.getParameters()).thenReturn(Map.of("_summary", new String[]{"count"}));
        when(request.getResourceName()).thenReturn("Observation"); when(request.getRequestPath()).thenReturn("Observation");
        when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE);
        when(request.getRequestType()).thenReturn(RequestTypeEnum.GET);
        var entered = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var rendering = new java.util.concurrent.CountDownLatch(1);
        var interruptedAtSerializer = new java.util.concurrent.atomic.AtomicBoolean(true);
        when(executor.count(eq(request), eq(context), any(PcmCountCancellation.class))).thenAnswer(invocation -> {
            entered.countDown(); release.await();
            PcmQueryLimits.exceeded(request, "maxCountNativeIdVisits", 1, 2);
            throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("wrapped execution budget", new IllegalStateException("nested cause"));
        });
        when(request.getServer()).thenAnswer(invocation -> {
            interruptedAtSerializer.set(Thread.currentThread().isInterrupted()); rendering.countDown();
            throw new IllegalStateException("test stops at the serializer boundary");
        });
        try {
            assertThat(interceptor.count(request)).isFalse();
            assertThat(entered.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            release.countDown();
            assertThat(rendering.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(interruptedAtSerializer.get()).isFalse();
            assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxCountNativeIdVisits", 1, 2));
            PcmQueryLimits.exceeded(request, "timeoutMilliseconds", 10000, 12000);
            assertThat(PcmBudgetFailure.capture(request).first().setting()).isEqualTo("maxCountNativeIdVisits");
            verify(async, org.mockito.Mockito.timeout(1000).atLeastOnce()).complete();
        } finally { release.countDown(); interceptor.close(); }
    }

    /** Three simultaneous bounded fixtures prove runtime increases have no hidden two-worker cap. */
    @Test void configuredWorkerAdmissionIncreasesAndLoweringRefusesWithoutCancellingActiveWork() throws Exception {
        var entered = new java.util.concurrent.CountDownLatch(3);
        var release = new java.util.concurrent.CountDownLatch(1);
        var completed = new java.util.concurrent.CountDownLatch(3);
        when(executor.count(any(),eq(context),any())).thenAnswer(call -> {
            entered.countDown(); release.await(); return 0;
        });
        var requests = new java.util.ArrayList<ca.uhn.fhir.rest.server.servlet.ServletRequestDetails>();
        var completedListener = new java.util.concurrent.atomic.AtomicReference<jakarta.servlet.AsyncListener>();
        try {
            for (int index=0; index<5; index++) {
                var request=mock(ca.uhn.fhir.rest.server.servlet.ServletRequestDetails.class);
                var data=new java.util.HashMap<Object,Object>();
                data.put(LocalJwtRequestContextVerifier.EXPIRY_ATTRIBUTE,java.time.Instant.now().plusSeconds(30));
                data.put(PcmQueryLimits.ATTRIBUTE,PcmQueryLimitsTest.limits(index==4 ? "{\"maxConcurrentQueries\":1}" : "{\"maxConcurrentQueries\":3}"));
                when(request.getUserData()).thenReturn(data);
                var input=mock(jakarta.servlet.http.HttpServletRequest.class);
                var stream=mock(jakarta.servlet.ServletInputStream.class);
                var async=mock(jakarta.servlet.AsyncContext.class);
                var server=new ca.uhn.fhir.rest.server.RestfulServer(ca.uhn.fhir.context.FhirContext.forR4Cached());
                var response=mock(ca.uhn.fhir.rest.api.server.IRestfulResponse.class);
                when(request.getServer()).thenReturn(server); when(request.getResponse()).thenReturn(response);
                when(response.getResponseWriter(anyInt(),anyString(),anyString(),anyBoolean())).thenAnswer(call -> new java.io.StringWriter());
                when(request.getServletResponse()).thenReturn(mock(jakarta.servlet.http.HttpServletResponse.class));
                when(request.getServletRequest()).thenReturn(input); when(input.getInputStream()).thenReturn(stream);
                when(stream.isFinished()).thenReturn(true); when(input.isAsyncSupported()).thenReturn(true); when(input.startAsync()).thenReturn(async);
                when(request.getParameters()).thenReturn(Map.of("_summary",new String[]{"count"}));
                when(request.getResourceName()).thenReturn("Observation"); when(request.getRequestPath()).thenReturn("Observation");
                when(request.getRestOperationType()).thenReturn(RestOperationTypeEnum.SEARCH_TYPE); when(request.getRequestType()).thenReturn(RequestTypeEnum.GET);
                if (index>0 && index<4) doAnswer(call -> { completed.countDown(); return null; }).when(async).complete();
                if (index==1) doAnswer(call -> { completedListener.set(call.getArgument(0)); return null; }).when(async).addListener(any());
                if (index==0) doThrow(new IllegalStateException("fixture listener registration refused")).when(async).addListener(any());
                requests.add(request);
                assertThat(interceptor.count(request)).isFalse();
                if (index==3) assertThat(entered.await(3,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            }
            verify(executor,never()).count(eq(requests.get(0)),any(),any());
            verify(executor,never()).count(eq(requests.get(4)),any(),any());
            verify(requests.get(4).getServletResponse()).setHeader("Retry-After","1");
            assertThat(PcmBudgetFailure.capture(requests.get(4)).first()).isEqualTo(PcmBudgetFailure.of("maxConcurrentQueries", 1, 3));
            assertThat(PcmBudgetFailure.capture(requests.get(0)).first()).isNull();
            assertThat(release.getCount()).isEqualTo(1);
            release.countDown(); assertThat(completed.await(3,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            completedListener.get().onTimeout(mock(jakarta.servlet.AsyncEvent.class));
            assertThat(PcmBudgetFailure.capture(requests.get(1)).first()).isNull();
            verify(requests.get(1).getServletResponse(), never()).setHeader("Retry-After", "1");
            verify(executor,times(3)).count(any(),eq(context),any());
        } finally { release.countDown(); interceptor.close(); }
    }

}
