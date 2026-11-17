package org.hl7.hdp.pcm.hapi;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.LoggingEvent;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Producer regressions exercise lifecycle, exact bytes, bounds and failure isolation. */
class PcmRuntimeObservabilityTest {
    @TempDir Path directory;
    @Test void pageSelectionAndActualWorkStayWithTheirOwnRequestWithoutIdentityLists() throws Exception {
        List<Map<String,Object>> events = new ArrayList<>();
        var observer = new PcmRuntimeObservability(events::add, Clock.systemUTC(), null, null);
        var first = request(); var response = mock(HttpServletResponse.class); when(response.getStatus()).thenReturn(200);
        observer.doFilter(first, response, (r, s) -> {
            var nativeRequest = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails();
            nativeRequest.setServletRequest(first);
            PcmRuntimeObservability.pageSelection(nativeRequest, PcmRequestContext.Kind.DATA_SOURCE_ACCESS, "native-compartment-union");
            PcmRuntimeObservability.pageWork(nativeRequest, 32, 20, 1, 12345, true, false);
        });
        var summary = events.stream().filter(value -> "HAPI_RESULT_FILTER_SUMMARY".equals(value.get("type"))).findFirst().orElseThrow();
        assertThat(summary.get("nativeSelection")).isEqualTo(Map.of("contextClass", "DATA_SOURCE_ACCESS", "reason", "native-compartment-union"));
        assertThat(summary.get("pageWork")).isEqualTo(Map.of("candidateIdVisits", 32L, "bodyVisits", 20L,
                "refills", 1, "allocatedBytes", 12345L, "completed", true, "cancelled", false));
        events.clear(); observer.doFilter(request(), response, (r, s) -> { });
        assertThat(events).allSatisfy(event -> assertThat(event).doesNotContainKeys("nativeSelection", "pageWork"));
    }
    @Test void earlyFailureHasReceiptOneTerminalAndRestoresThreadContext() throws Exception {
        List<Map<String,Object>> events = new ArrayList<>();
        var observer = new PcmRuntimeObservability(events::add, Clock.systemUTC(), null, null);
        var request = request(); var response = mock(HttpServletResponse.class); when(response.getStatus()).thenReturn(401);
        org.slf4j.MDC.put("previous", "preserved");
        assertThatThrownBy(() -> observer.doFilter(request, response, (r,s) -> { throw new ServletException("native failure"); })).isInstanceOf(ServletException.class);
        assertThat(events.stream().map(value -> value.get("type"))).containsExactly("HAPI_REQUEST", "HAPI_RESULT_FILTER_SUMMARY", "HAPI_ERROR");
        assertThat(events.get(0).get("url")).isEqualTo("/fhir/Patient?identifier=exact%7Cvalue");
        assertThat(events.get(2)).containsEntry("serverStatusBeforeFailure",401).containsEntry("status",null).containsEntry("completionObserved",true).containsEntry("abortObserved",false);
        assertThat(org.slf4j.MDC.get("previous")).isEqualTo("preserved"); org.slf4j.MDC.clear();
    }
    @Test void asyncTimeoutIsUnknownUntilActualCompletionAndDuplicateCompletionIsIgnored() throws Exception {
        List<Map<String,Object>> events = new ArrayList<>(); var observer = new PcmRuntimeObservability(events::add, Clock.systemUTC(), null,null);
        var request = request(); var response = mock(HttpServletResponse.class); when(response.getStatus()).thenReturn(200);
        var async = mock(AsyncContext.class); when(request.isAsyncStarted()).thenReturn(true); when(request.getAsyncContext()).thenReturn(async);
        observer.doFilter(request,response,(r,s)->{}); var capture = org.mockito.ArgumentCaptor.forClass(AsyncListener.class); verify(async).addListener(capture.capture());
        AsyncListener listener = capture.getValue(); listener.onTimeout(new AsyncEvent(async));
        assertThat(events.get(events.size()-1)).containsEntry("outcome","unknown").containsEntry("completionObserved",false);
        listener.onComplete(new AsyncEvent(async)); listener.onComplete(new AsyncEvent(async));
        assertThat(events.stream().filter(value -> "HAPI_RESPONSE".equals(value.get("type"))).count()).isEqualTo(1);
    }
    @Test void boundedStreamingEncodingDropsWholeOversizeCyclesAndDeepExceptions() throws Exception {
        assertThatThrownBy(() -> PcmBoundedJson.encode(Map.of("huge","x".repeat(300000)),262144)).isInstanceOf(java.io.IOException.class);
        Map<String,Object> cyclic=new HashMap<>();cyclic.put("cycle",cyclic);
        assertThatThrownBy(() -> PcmBoundedJson.encode(cyclic,262144)).isInstanceOf(java.io.IOException.class);
        Object deep="leaf";for(int i=0;i<35;i++) deep=List.of(deep);Object value=deep;
        assertThatThrownBy(() -> PcmBoundedJson.encode(value,262144)).isInstanceOf(java.io.IOException.class);
        var hostile=new IllegalStateException("bounded message");
        hostile.setStackTrace(new StackTraceElement[]{new StackTraceElement("x".repeat(300000),"method","file",1)});
        var proxy=new ch.qos.logback.classic.spi.ThrowableProxy(hostile);
        assertThatThrownBy(()->PcmBoundedJson.encode(Map.of("exception",proxy),262144)).isInstanceOf(java.io.IOException.class);
        String exact="FHIR token query patient|value"; assertThat(new String(PcmBoundedJson.encode(Map.of("value",exact),1000))).contains(exact);
        assertThat(new String(PcmBoundedJson.encode(Map.of("AWS_SECRET_ACCESS_KEY","canary-secret","nested",List.of("AKIAIOSFODNN7EXAMPLE")),1000))).doesNotContain("canary-secret","AKIAIOSFODNN7EXAMPLE").contains("AWS_CREDENTIAL_BLOCKED");
    }
    @Test void detailLifetimeIsAbsoluteAndHardBounded() {
        Instant now=Instant.parse("2026-11-14T12:00:00Z");
        var active=new PcmRuntimeObservability(value->{},Clock.fixed(now,ZoneOffset.UTC),now.toString(),now.plusSeconds(900).toString());
        assertThat(active.detailState()).containsEntry("enabled",true).containsEntry("remainingMs",900000L);
        var expired=new PcmRuntimeObservability(value->{},Clock.fixed(now.plusSeconds(900),ZoneOffset.UTC),now.toString(),now.plusSeconds(900).toString());
        assertThat(expired.detailState()).containsEntry("enabled",false);
        assertThatThrownBy(()->new PcmRuntimeObservability(value->{},Clock.fixed(now,ZoneOffset.UTC),now.toString(),now.plusSeconds(3601).toString())).isInstanceOf(IllegalArgumentException.class);
    }
    @Test void appenderRetainsNativeErrorStackAndDisclosesWholeOversizeLoss() throws Exception {
        var appender=new PcmRuntimeAppender();appender.setDirectory(directory.toString());appender.start();
        LoggingEvent event=event("native exception");event.setThrowableProxy(new ch.qos.logback.classic.spi.ThrowableProxy(new IllegalStateException("AWS_SECRET_ACCESS_KEY=canary")));appender.doAppend(event);
        appender.doAppend(event("x".repeat(300000))); appender.stop();
        String contents=Files.readString(directory.resolve("current.log"));
        assertThat(contents).contains("HAPI_NATIVE_DIAGNOSTIC","IllegalStateException","stack","HAPI_LOG_LOSS","LOG_OVERSIZE").doesNotContain("canary");
        assertThat(appender.health()).containsEntry("dropped",1L);
    }
    @Test void invalidParentStartsUnlinkedAndCallerCannotEnableDetail() throws Exception {
        List<Map<String,Object>> events=new ArrayList<>();var observer=new PcmRuntimeObservability(events::add,Clock.systemUTC(),null,null);
        var request=request();when(request.getHeaders("traceparent")).thenReturn(Collections.enumeration(List.of("00-"+"0".repeat(32)+"-"+"1".repeat(16)+"-01")));
        var response=mock(HttpServletResponse.class);observer.doFilter(request,response,(r,s)->{});
        assertThat(events.get(0)).containsEntry("traceParent","invalid-unlinked").doesNotContainKey("parentSpanId");
        assertThat(((Map<?,?>)events.get(0).get("detailCollection")).get("enabled")).isEqualTo(false);
    }
    @Test void resourceAndPredicateOmissionsStayWithinIndependentBudgets() throws Exception {
        Instant now=Instant.now(); List<Map<String,Object>> events=new ArrayList<>();
        var observer=new PcmRuntimeObservability(events::add,Clock.fixed(now,ZoneOffset.UTC),now.toString(),null);
        var input=request();var output=mock(HttpServletResponse.class);when(output.getStatus()).thenReturn(200);
        var request=new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails(); request.setServletRequest(input);
        observer.doFilter(input,output,(r,s)->{
            for(int i=0;i<120;i++){
                var evaluation=PcmRuntimeObservability.beginEvaluation();
                try {for(int rule=0;rule<70;rule++)PcmRuntimeObservability.predicate("Observation?status=final&code="+rule,"native-expression",rule%2==0);
                    observer.resource(request,new org.hl7.fhir.r4.model.Observation().setId("Observation/owned-"+i),i%2==0,evaluation);
                }finally{PcmRuntimeObservability.endEvaluation(evaluation);}
            }
        });
        var details=events.stream().filter(value->"HAPI_RESOURCE_DECISION".equals(value.get("type"))).toList();
        assertThat(details.size()).isBetween(1,100);
        for(var detail:details){assertThat(PcmBoundedJson.encode(detail,65536).length).isLessThanOrEqualTo(65536);assertThat(detail.get("omittedPredicates")).isEqualTo(6);}
        var summary=events.stream().filter(value->"HAPI_RESULT_FILTER_SUMMARY".equals(value.get("type"))).findFirst().orElseThrow();
        assertThat(summary.get("examined")).isEqualTo(120L);assertThat(summary.get("omittedCount")).isEqualTo(120L-details.size());
        assertThat(((Number)summary.get("detailBytes")).longValue()).isLessThanOrEqualTo(262144);
    }
    @Test void emittedVisibilityUsesExactPurposeAndKeepsWarningsAndSummariesOrdinary() throws Exception {
        var appender = new PcmRuntimeAppender(); appender.setDirectory(directory.toString()); appender.start();
        var types = java.util.List.of("HAPI_STARTUP_READY", "HAPI_RESOURCE_DECISION", "HAPI_RESULT_FILTER_SUMMARY", "HAPI_ERROR", "HAPI_STARTUP_FAILED", "HAPI_FUTURE");
        for (String type : types) {
            var value = event("PCM_EVENT"); value.setLoggerName("org.hl7.hdp.pcm.hapi.PcmRuntimeObservability");
            value.setArgumentArray(new Object[]{Map.of("type", type)}); appender.doAppend(value);
        }
        appender.doAppend(event("ordinary warning")); appender.stop();
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        var lines = Files.readAllLines(directory.resolve("current.log")); assertThat(lines).hasSize(7);
        for (int i = 0; i < lines.size(); i++) assertThat(mapper.readTree(lines.get(i)).at("/details/visibility").asText()).isEqualTo(i < 2 ? "diagnostic" : "default");
    }

    @Test void queueIsBoundedAndSummaryEvictsVerboseBeforeBeingDropped() throws Exception {
        var appender=new PcmRuntimeAppender();appender.setDirectory(directory.toString());
        var entered=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);
        appender.setBeforeWrite(()->{entered.countDown();try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}});
        appender.start();appender.doAppend(event("first"));assertThat(entered.await(2,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        for(int i=0;i<1024;i++){
            var value=event("PCM_EVENT");value.setLoggerName("org.hl7.hdp.pcm.hapi.PcmRuntimeObservability");
            value.setArgumentArray(new Object[]{Map.of("type","HAPI_RESOURCE_DECISION","resourceId","owned-"+i)});appender.doAppend(value);
        }
        appender.doAppend(event("priority native error"));
        assertThat(appender.health()).containsEntry("queuedEntries",1024).containsEntry("dropped",1L);
        assertThat(((Number)appender.health().get("queuedBytes")).intValue()).isLessThanOrEqualTo(8*1024*1024);
        release.countDown();appender.stop();
        assertThat(Files.readString(directory.resolve("current.log"))).contains("priority native error","HAPI_LOG_LOSS");
    }
    @Test void writerReportsDiskFailureRecoveryAndKeepsOtherSourceUntouched() throws Exception {
        var appender=new PcmRuntimeAppender();appender.setDirectory(directory.resolve("owned").toString());
        Path other=directory.resolve("other");Files.createDirectory(other);Files.writeString(other.resolve("current.log"),"keep other source");
        var fail=new java.util.concurrent.atomic.AtomicBoolean(true);
        appender.setBeforeWrite(()->{if(fail.get())throw new java.io.UncheckedIOException(new java.io.IOException("injected disk failure"));});
        appender.start();appender.doAppend(event("lost during disk failure"));
        await(()->((Number)appender.health().get("writeFailures")).longValue()>0);
        fail.set(false);appender.doAppend(event("recovered native error"));
        await(()->((Number)appender.health().get("lastSuccessEpochMs")).longValue()>0);appender.stop();
        assertThat(Files.readString(directory.resolve("owned/current.log"))).contains("HAPI_LOG_RECOVERY","recovered native error").doesNotContain("lost during disk failure");
        assertThat(Files.readString(other.resolve("current.log"))).isEqualTo("keep other source");
    }
    @Test void encodedByteBudgetSaturatesBeforeEntryBudgetAndRecoversWithoutProducerDiskWait() throws Exception {
        var appender=new PcmRuntimeAppender();appender.setDirectory(directory.toString());
        var entered=new java.util.concurrent.CountDownLatch(1);var release=new java.util.concurrent.CountDownLatch(1);
        appender.setBeforeWrite(()->{entered.countDown();try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}});
        appender.start();appender.doAppend(event("first"));assertThat(entered.await(2,java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        var threads=java.lang.management.ManagementFactory.getThreadMXBean();
        long cpuBefore=threads.getCurrentThreadCpuTime(),started=System.nanoTime();
        long heapBefore=java.lang.management.ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed();
        for(int i=0;i<180;i++)appender.doAppend(event("bounded native warning "+"x".repeat(60000)));
        var saturated=appender.health();
        assertThat(((Number)saturated.get("queuedBytes")).intValue()).isBetween(7*1024*1024,8*1024*1024);
        assertThat(((Number)saturated.get("queuedEntries")).intValue()).isLessThan(1024);
        assertThat(((Number)saturated.get("dropped")).longValue()).isPositive();
        // Completing all offers while the actual writer remains blocked proves no producer disk/capacity wait.
        System.out.println("PCM_DIAGNOSTIC_SATURATION "+Map.of("offers",180,"elapsedMs",(System.nanoTime()-started)/1e6,
                "producerCpuMs",(threads.getCurrentThreadCpuTime()-cpuBefore)/1e6,"heapBefore",heapBefore,
                "heapAfter",java.lang.management.ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed(),"health",saturated));
        release.countDown();await(()->((Number)appender.health().get("queuedEntries")).intValue()==0);appender.stop();
        assertThat(appender.health()).containsEntry("pendingLoss",0L);
        assertThat(Files.readString(directory.resolve("current.log"))).contains("HAPI_LOG_LOSS");
    }
    @Test void utcDayBoundaryRotatesAnOtherwiseSmallCurrentFile() throws Exception {
        Instant start=Instant.now();var now=new java.util.concurrent.atomic.AtomicReference<>(start);
        Clock clock=new Clock(){public java.time.ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(java.time.ZoneId zone){return this;}public Instant instant(){return now.get();}};
        var appender=new PcmRuntimeAppender();appender.setDirectory(directory.toString());appender.setClock(clock);appender.start();
        appender.doAppend(event("before UTC day"));await(()->((Number)appender.health().get("lastSuccessEpochMs")).longValue()>0);
        now.set(start.plusSeconds(86400));appender.doAppend(event("after UTC day"));
        await(()->{try{return Files.readString(directory.resolve("current.log")).contains("after UTC day");}catch(Exception ignored){return false;}});appender.stop();
        try(var paths=Files.list(directory.resolve("history"))){var archives=paths.toList();assertThat(archives).hasSize(1);assertThat(Files.readString(archives.get(0).resolve("app.log"))).contains("before UTC day");}
        assertThat(Files.readString(directory.resolve("current.log"))).doesNotContain("before UTC day");
    }
    @Test void emittedNativeEnvelopeMatchesSharedCrossLanguageCatalog() throws Exception {
        var mapper=new com.fasterxml.jackson.databind.ObjectMapper();
        var contract=mapper.readTree(getClass().getResourceAsStream("/pcm-observability-event-contract.json"));
        var appender=new PcmRuntimeAppender();appender.setDirectory(directory.toString());appender.start();appender.doAppend(event("native contract"));appender.stop();
        var record=mapper.readTree(Files.readAllLines(directory.resolve("current.log")).get(0));
        assertThat(record.path("event").path("schemaVersion").asText()).isEqualTo(contract.path("schemaVersion").asText());
        assertThat(record.path("event").path("source").path("role").asText()).isEqualTo("hapi");
        assertThat(contract.path("eventNames").toString()).contains(record.path("details").path("type").asText());
        assertThat(record.path("processId").asText()).isNotEmpty();assertThat(record.path("sequence").asLong()).isPositive();
    }
    @Test void rotationRetentionRestartAndClearStayInsideOwnedSource() throws Exception {
        Path owned=directory.resolve("source"),other=directory.resolve("other");Files.createDirectories(other);Files.writeString(other.resolve("keep"),"unchanged");
        var appender=new PcmRuntimeAppender();appender.setDirectory(owned.toString());appender.start();
        String payload="preserved non-AWS "+"x".repeat(230000);
        for(int i=0;i<50;i++)appender.doAppend(event(payload));appender.stop();
        assertThat(Files.size(owned.resolve("current.log"))).isLessThanOrEqualTo(PcmRuntimeAppender.ROTATE_BYTES);
        try(var paths=Files.list(owned.resolve("history"))){assertThat(paths.count()).isGreaterThanOrEqualTo(1);}
        Path expired=owned.resolve("history/2000-01-01/app.log");Files.createDirectories(expired.getParent());Files.writeString(expired,"expired");Files.setLastModifiedTime(expired,java.nio.file.attribute.FileTime.from(Instant.now().minusSeconds(6*86400)));
        Path oldest=owned.resolve("history/2001-01-01/app.log");Files.createDirectories(oldest.getParent());
        try(var huge=new java.io.RandomAccessFile(oldest.toFile(),"rw")){huge.setLength(PcmRuntimeAppender.RETAIN_BYTES);}
        Files.setLastModifiedTime(oldest,java.nio.file.attribute.FileTime.from(Instant.now().minusSeconds(60)));
        var restarted=new PcmRuntimeAppender();restarted.setDirectory(owned.toString());restarted.start();restarted.doAppend(event("after restart"));
        await(()->!Files.exists(expired)&&!Files.exists(oldest));
        Files.writeString(owned.resolve("current.log"),"",StandardOpenOption.TRUNCATE_EXISTING);
        restarted.doAppend(event("after active clear"));await(()->{try{return Files.readString(owned.resolve("current.log")).contains("after active clear");}catch(Exception ignored){return false;}});restarted.stop();
        assertThat(Files.readString(owned.resolve("current.log"))).contains("after active clear").doesNotContain("preserved non-AWS");
        assertThat(Files.readString(other.resolve("keep"))).isEqualTo("unchanged");
    }
    @Test void resourceGuardVerdictsAreSummarizedWithoutDuplicateAdmissionEvents() throws Exception {
        List<Map<String,Object>> events=new ArrayList<>();var observer=new PcmRuntimeObservability(events::add,Clock.systemUTC(),null,null);
        var input=request();var output=mock(HttpServletResponse.class);when(output.getStatus()).thenReturn(200);
        var request=new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails();request.setServletRequest(input);request.setRequestType(ca.uhn.fhir.rest.api.RequestTypeEnum.HEAD);
        observer.doFilter(input,output,(r,s)->{
            for(int i=0;i<4;i++)observer.admission(request,ca.uhn.fhir.interceptor.api.Pointcut.STORAGE_PRESHOW_RESOURCES,"pass","ADMISSION_ALLOWED");
            observer.admission(request,ca.uhn.fhir.interceptor.api.Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED,"pass","ADMISSION_ALLOWED");
            PcmRuntimeObservability.outgoing(request,new org.hl7.fhir.r4.model.Observation(),false);
        });
        assertThat(events.stream().filter(value->"HAPI_ADMISSION".equals(value.get("type"))).count()).isEqualTo(1);
        var summary=events.stream().filter(value->"HAPI_RESULT_FILTER_SUMMARY".equals(value.get("type"))).findFirst().orElseThrow();
        assertThat(summary.get("nativeResourceGuardVerdicts")).isEqualTo(Map.of("STORAGE_PRESHOW_RESOURCES",Map.of("pass",4L)));
        assertThat(summary.get("returned")).isEqualTo(0L);
    }
    @Test void nativeAbortRetainsUnknownDeliveryAndLateWorkCompletionWithoutAnotherHttpTerminal() throws Exception {
        List<Map<String,Object>> events=new ArrayList<>();var observer=new PcmRuntimeObservability(events::add,Clock.systemUTC(),null,null);
        var input=request();var response=mock(HttpServletResponse.class);when(response.getStatus()).thenReturn(200);
        var async=mock(AsyncContext.class);when(input.isAsyncStarted()).thenReturn(true);when(input.getAsyncContext()).thenReturn(async);
        var request=new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails();request.setServletRequest(input);
        observer.doFilter(input,response,(r,s)->{PcmRuntimeObservability.nativeWorkStarted(request);PcmRuntimeObservability.transportFailure(request,new java.io.IOException("native connection closed"),true);});
        var capture=org.mockito.ArgumentCaptor.forClass(AsyncListener.class);verify(async).addListener(capture.capture());capture.getValue().onComplete(new AsyncEvent(async));
        var terminal=events.stream().filter(value->"HAPI_ERROR".equals(value.get("type"))).findFirst().orElseThrow();
        assertThat(terminal).containsEntry("outcome","abort-observed").containsEntry("status",null).containsEntry("nativeWorkState","in-flight");
        when(input.getAttribute(anyString())).thenThrow(new IllegalStateException("recycled"));
        PcmRuntimeObservability.nativeWorkFinished(request);
        assertThat(events.stream().filter(value->java.util.Set.of("HAPI_RESPONSE","HAPI_ERROR").contains(value.get("type"))).count()).isEqualTo(1);
        assertThat(events.get(events.size()-1)).containsEntry("type","HAPI_NATIVE_WORK_FINISHED").containsEntry("afterHttpCompletion",true);
    }
    private static void await(java.util.function.BooleanSupplier condition) throws Exception {
        long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
        while(!condition.getAsBoolean()&&System.nanoTime()<until)Thread.sleep(5);
        assertThat(condition.getAsBoolean()).isTrue();
    }
    private LoggingEvent event(String message) {
        var event=new LoggingEvent();event.setLoggerName("ca.uhn.fhir.runtime");event.setLevel(Level.ERROR);event.setMessage(message);event.setThreadName("native-test");event.setMDCPropertyMap(Map.of());return event;
    }
    private HttpServletRequest request() {
        var request=mock(HttpServletRequest.class);Map<String,Object> attrs=new HashMap<>();
        when(request.getAttribute(anyString())).thenAnswer(call->attrs.get(call.getArgument(0)));
        doAnswer(call->{attrs.put(call.getArgument(0),call.getArgument(1));return null;}).when(request).setAttribute(anyString(),any());
        when(request.getMethod()).thenReturn("GET");when(request.getRequestURI()).thenReturn("/fhir/Patient");when(request.getQueryString()).thenReturn("identifier=exact%7Cvalue");return request;
    }
    @Test void finalErrorAloneRetainsExactCauseAndAppenderMessageWithoutTheWarning() throws Exception {
        var appender = new PcmRuntimeAppender(); appender.setDirectory(directory.toString()); appender.start();
        List<Map<String,Object>> events = new ArrayList<>();
        var observer = new PcmRuntimeObservability(value -> {
            events.add(value);
            var nativeEvent = event("PCM_EVENT"); nativeEvent.setLoggerName(PcmRuntimeObservability.class.getName());
            nativeEvent.setArgumentArray(new Object[]{value}); appender.doAppend(nativeEvent);
        }, Clock.systemUTC(), null, null);
        var input = request(); var response = mock(HttpServletResponse.class); when(response.getStatus()).thenReturn(503);
        observer.doFilter(input, response, (r, s) -> {
            var nativeRequest = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails(); nativeRequest.setServletRequest(input);
            // The warning has no writer attached: terminal correctness cannot depend on a log join.
            PcmQueryLimits.exceeded(nativeRequest, "maxAllocatedBytes", 2147483648L, 2159627600L);
            observer.error(nativeRequest, new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("wrapped native failure"));
            PcmQueryLimits.exceeded(nativeRequest, "maxPageIdVisits", 1, 2);
        });
        appender.stop();
        var terminal = events.stream().filter(value -> "HAPI_ERROR".equals(value.get("type"))).findFirst().orElseThrow();
        assertThat(terminal).containsEntry("reasonCode", PcmBudgetFailure.REASON).containsEntry("status", 503);
        assertThat(terminal.get("budgetFailure")).isEqualTo(PcmBudgetFailure.of("maxAllocatedBytes", 2147483648L, 2159627600L).fields());
        var records = Files.readAllLines(directory.resolve("current.log")).stream().map(line -> {
            try { return new com.fasterxml.jackson.databind.ObjectMapper().readTree(line); } catch (Exception failed) { throw new RuntimeException(failed); }
        }).toList();
        var row = records.stream().filter(value -> "HAPI_ERROR".equals(value.path("details").path("type").asText())).findFirst().orElseThrow();
        assertThat(row.path("message").asText()).isEqualTo("HAPI_ERROR · QUERY_BUDGET_EXCEEDED: maxAllocatedBytes limit=2147483648 bytes observed=2159627600 bytes");
        assertThat(row.path("details").path("budgetFailure").path("observed").longValue()).isEqualTo(2159627600L);
        assertThat(events.stream().filter(value -> "HAPI_ERROR".equals(value.get("type"))).count()).isEqualTo(1);
    }

    @Test void nativeWarningUsesSameBoundedFormatterAndUnrelatedErrorsStayGeneric() throws Exception {
        var appender = new PcmRuntimeAppender(); appender.setDirectory(directory.toString()); appender.start();
        var warning = new LoggingEvent(); warning.setMessage(PcmBudgetFailure.WARNING); warning.setLevel(Level.WARN); warning.setThreadName("budget-test"); warning.setMDCPropertyMap(Map.of()); warning.setLoggerName(PcmQueryLimits.class.getName());
        warning.setArgumentArray(new Object[]{PcmBudgetFailure.of("maxPageIdVisits", 5000, 5001)}); appender.doAppend(warning);
        assertThat(new String(new PcmSafeConsoleEncoder().encode(warning), java.nio.charset.StandardCharsets.UTF_8))
                .contains("PCM query budget exceeded: maxPageIdVisits limit=5000 visits observed=5001 visits", "budgetFailure").doesNotContain("LOG_OVERSIZE");
        appender.doAppend(event("unrelated failure")); appender.stop();
        var rows = Files.readAllLines(directory.resolve("current.log"));
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        assertThat(mapper.readTree(rows.get(0)).path("message").asText()).isEqualTo("PCM query budget exceeded: maxPageIdVisits limit=5000 visits observed=5001 visits");
        assertThat(mapper.readTree(rows.get(1)).path("details").has("budgetFailure")).isFalse();
    }

    @Test void successfulAndAbortedRequestsCannotAcquireLateCleanupCauseAndThreadStateDoesNotLeak() throws Exception {
        var events = new ArrayList<Map<String,Object>>();
        var observer = new PcmRuntimeObservability(events::add, Clock.systemUTC(), null, null);
        var response = mock(HttpServletResponse.class); when(response.getStatus()).thenReturn(200);
        var input = request(); var nativeRequest = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails(); nativeRequest.setServletRequest(input);
        observer.doFilter(input, response, (r, s) -> { });
        PcmQueryLimits.exceeded(nativeRequest, "maxPageIdVisits", 1, 2);
        assertThat(PcmBudgetFailure.capture(nativeRequest).first()).isNull();
        assertThat(events).allSatisfy(value -> assertThat(value).doesNotContainKeys("budgetFailure", "reasonCode"));
        events.clear(); var next = request();
        observer.doFilter(next, response, (r, s) -> {
            var aborted = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails(); aborted.setServletRequest(next);
            PcmRuntimeObservability.transportFailure(aborted, new java.io.IOException("client left"), true);
            PcmQueryLimits.exceeded(aborted, "maxAllocatedBytes", 1, 2);
        });
        assertThat(events).allSatisfy(value -> assertThat(value).doesNotContainKey("budgetFailure"));
    }

    @Test void timerWarningUsesExplicitRequestIdentityAndRestoresItsOwnThreadContext() throws Exception {
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(PcmQueryLimits.class);
        var seen = new java.util.concurrent.atomic.AtomicReference<Map<String,String>>();
        var capture = new ch.qos.logback.core.AppenderBase<ch.qos.logback.classic.spi.ILoggingEvent>() {
            @Override protected void append(ch.qos.logback.classic.spi.ILoggingEvent event) { seen.set(Map.copyOf(event.getMDCPropertyMap())); }
        };
        var priorLevel = logger.getLevel(); logger.setLevel(Level.WARN);
        capture.start(); logger.addAppender(capture);
        var events = new ArrayList<Map<String,Object>>();
        var observer = new PcmRuntimeObservability(events::add, Clock.systemUTC(), null, null);
        var input = request(); when(input.getHeaders("x-correlation-id")).thenReturn(Collections.enumeration(List.of("budget-timer-a")));
        var response = mock(HttpServletResponse.class); when(response.getStatus()).thenReturn(503);
        try {
            observer.doFilter(input, response, (r, output) -> {
                var nativeRequest = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails(); nativeRequest.setServletRequest(input);
                java.util.concurrent.CompletableFuture.runAsync(() -> {
                    org.slf4j.MDC.put("prior", "timer-context");
                    PcmQueryLimits.exceeded(nativeRequest, "timeoutMilliseconds", 1200, 200);
                    assertThat(org.slf4j.MDC.get("prior")).isEqualTo("timer-context"); org.slf4j.MDC.clear();
                }).join();
            });
            assertThat(seen.get()).containsEntry("correlationId", "budget-timer-a");
            assertThat(seen.get().get("requestId")).isEqualTo(events.get(0).get("requestId"));
        } finally { logger.detachAppender(capture); capture.stop(); logger.setLevel(priorLevel); }
    }

}
