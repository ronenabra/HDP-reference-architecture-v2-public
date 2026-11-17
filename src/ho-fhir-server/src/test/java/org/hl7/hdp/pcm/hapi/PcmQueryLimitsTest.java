package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.databind.ObjectMapper;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

/** Parsed ownership, immutable capture, runtime admission and fixed paging lifetime. */
class PcmQueryLimitsTest {
    /** Reuse the existing parsed-document seam to vary a small validated row. */
    static PcmQueryLimits limits(String row) {
        try { return PcmQueryLimits.parse(new ObjectMapper().readTree("{\"clinicalQuery\":{\"defaults\":" + row + "}}"), "ho-a"); }
        catch (java.io.IOException error) { throw new IllegalArgumentException(error); }
    }
    @Test void defaultsAndEveryClosedBoundRejectInvalidRawUnits() throws Exception {
        for (var component : PcmQueryLimits.class.getRecordComponents()) {
            if (component.getName().equals("revision")) continue;
            String name = component.getName();
            long value = ((Number) component.getAccessor().invoke(PcmQueryLimits.DEFAULTS)).longValue();
            assertThat(((Number) component.getAccessor().invoke(limits("{}"))).longValue()).isEqualTo(value);
            for (String invalid : java.util.List.of("0", "1.5", "null", "\"4\"", "9223372036854775807")) {
                assertThatThrownBy(() -> limits("{\""+name+"\":"+invalid+"}")).isInstanceOf(SecurityException.class);
            }
        }
        assertThatThrownBy(() -> limits("{\"unknown\":1}")).isInstanceOf(SecurityException.class);
        assertThatThrownBy(() -> PcmQueryLimits.parse(new ObjectMapper().readTree("{\"clinicalQuery\":{\"sources\":{\"unknown\":{}}}}"), "ho-a")).isInstanceOf(SecurityException.class);
    }
    @Test void snapshotComesFromExistingPolicyReadAndOperationalEditsKeepAuthority() throws Exception {
        var config = new ObjectMapper().readTree(java.nio.file.Path.of("test/team-config.json").toFile());
        var object = (com.fasterxml.jackson.databind.node.ObjectNode)config;
        object.put("configVersion", "pcm-team-config/5");
        object.withObject("/conformance").put("policyVersion", "pcm-sandbox-policy/4");
        object.withObject("/security/dsFhirServer").put("enforceMappedPatients", true);
        object.putObject("runtime").put("revision",1).put("queryLimitsRevisionOffset",1);
        object.putObject("clinicalQuery").putObject("defaults").put("maxPageIdVisits",4);
        var file = java.nio.file.Files.createTempFile("query-limits-", ".json");
        try {
            java.nio.file.Files.writeString(file, config.toString());
            var first = PcmSimulationPolicy.load(file,"ho-a");
            java.nio.file.Files.delete(file);
            var request = new SystemRequestDetails(); request.getUserData().put(PcmQueryLimits.ATTRIBUTE,first.queryLimits());
            assertThat(PcmQueryLimits.from(request).maxPageIdVisits()).isEqualTo(4);
            ((com.fasterxml.jackson.databind.node.ObjectNode)config.path("runtime")).put("revision",2).put("queryLimitsRevisionOffset",2);
            ((com.fasterxml.jackson.databind.node.ObjectNode)config.path("clinicalQuery").path("defaults")).put("maxPageIdVisits",8);
            java.nio.file.Files.writeString(file,config.toString()); var next = PcmSimulationPolicy.load(file,"ho-a");
            assertThat(next.stamp()).isEqualTo(first.stamp()); assertThat(next.queryLimits().revision()).isEqualTo("2");
            assertThat(next.queryLimits().maxPageIdVisits()).isEqualTo(8); assertThat(PcmQueryLimits.from(request).maxPageIdVisits()).isEqualTo(4);
            PcmQueryLimits.exceeded(request, "maxPageIdVisits", PcmQueryLimits.from(request).maxPageIdVisits(), 5);
            assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxPageIdVisits", 4, 5));
            java.nio.file.Files.writeString(file,"malformed");
            assertThatThrownBy(() -> PcmSimulationPolicy.load(file,"ho-a")).isInstanceOf(SecurityException.class);
        } finally { java.nio.file.Files.deleteIfExists(file); }
    }
    @Test void noWaitAdmissionIncreasesAndDecreasesWithoutInterruptingOwnersAndReleasesOnce() {
        var gate = new PcmQueryAdmission(); var first = gate.acquire(2); var second = gate.acquire(2);
        assertThat(gate.acquire(2)).isNull(); var third = gate.acquire(3); assertThat(third).isNotNull();
        assertThat(gate.acquire(1)).isNull(); first.close(); first.close(); second.close();
        assertThat(gate.acquire(1)).isNull(); third.close(); var next = gate.acquire(1); assertThat(next).isNotNull(); next.close();
    }
    @Test void pagingUsesCurrentCapacityAndOriginalCreationTimeWithoutResurrection() {
        class MutableClock extends java.time.Clock {
            long now; public java.time.ZoneId getZone() { return java.time.ZoneOffset.UTC; }
            public java.time.Clock withZone(java.time.ZoneId zone) { return this; }
            public java.time.Instant instant() { return java.time.Instant.ofEpochMilli(now); }
        }
        var clock = new MutableClock(); var states = new PcmPageState(clock);
        var context = new PcmRequestContext("ho-a","client",java.util.List.of(new PcmReadGrant("Observation",null,"p")));
        var first = states.create(java.util.UUID.randomUUID().toString(),"Observation",1,context,"q");
        String cursor = states.cursor(first,1); clock.now=5;
        assertThat(states.resolve(cursor,context,"",limits("{\"searchTtlMilliseconds\":10}"))).isNotNull();
        clock.now=10;
        assertThatThrownBy(() -> states.resolve(cursor,context,"",limits("{\"searchTtlMilliseconds\":10}"))).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
        assertThatThrownBy(() -> states.resolve(cursor,context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
        first=states.create(java.util.UUID.randomUUID().toString(),"Observation",1,context,"q"); String evicted=states.cursor(first,1);
        var newer=states.create(java.util.UUID.randomUUID().toString(),"Observation",1,context,"q");
        assertThat(states.resolve(states.cursor(newer,1),context,"",limits("{\"maxRetainedSearches\":1}"))).isNotNull();
        assertThatThrownBy(() -> states.resolve(evicted,context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
    }
    @Test void deadlineIsCapturedOnceAndEarlierAuthorityExpiryStillWins() {
        var request=new SystemRequestDetails();request.getUserData().put(PcmQueryLimits.ATTRIBUTE,limits("{\"timeoutMilliseconds\":20000}"));
        long before=System.nanoTime(),deadline=PcmQueryLimits.deadline(request,java.time.Instant.now().plusSeconds(3));
        assertThat(deadline-before).isBetween(1_000_000_000L,2_100_000_000L);
        assertThat(PcmQueryLimits.deadline(request,java.time.Instant.now().plusSeconds(30))).isEqualTo(deadline);
    }
    @Test void exactLongCauseKeepsFirstFailureAcrossWorkersAndClosesBeforeLateTimers() throws Exception {
        var request = new SystemRequestDetails();
        var capture = PcmBudgetFailure.capture(request);
        PcmQueryLimits.exceeded(request, "maxAllocatedBytes", 2147483648L, 2159627600L);
        var first = capture.first();
        assertThat(first.fields()).containsEntry("threshold", 2147483648L).containsEntry("observed", 2159627600L).containsEntry("unit", "bytes");
        assertThat(first.message()).isEqualTo("maxAllocatedBytes limit=2147483648 bytes observed=2159627600 bytes");
        var workers = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var a = workers.submit(() -> PcmQueryLimits.exceeded(request, "maxPageIdVisits", 1, 2));
            var b = workers.submit(() -> PcmQueryLimits.exceeded(request, "maxAllocatedBytes", 2147483648L, 3000000000L));
            a.get(); b.get();
            assertThat(capture.first()).isSameAs(first);
            assertThat(capture.finish()).isSameAs(first);
            workers.submit(() -> PcmQueryLimits.exceeded(request, "maxPageBodyVisits", 1, 3)).get();
            assertThat(capture.first()).isNull();
            assertThat(workers.submit(() -> PcmBudgetFailure.capture(new SystemRequestDetails()).first()).get()).isNull();
        } finally { workers.shutdownNow(); }
        for (String invalid : java.util.List.of("unknown", "searchTtlMilliseconds", "maxRetainedSearches", "maxPrivateAuthorizationBytes"))
            assertThatThrownBy(() -> PcmBudgetFailure.of(invalid, 1, 2)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void measuredTimeoutSeparatesConfiguredBudgetFromAuthorityAndRetainsRequestSnapshot() throws Exception {
        var request = new SystemRequestDetails();
        var snapshot = limits("{\"timeoutMilliseconds\":1001}");
        request.getUserData().put(PcmQueryLimits.ATTRIBUTE, snapshot);
        PcmQueryLimits.deadline(request, java.time.Instant.now().plusSeconds(30));
        Thread.sleep(12);
        PcmQueryLimits.timedOut(request);
        var cause = PcmBudgetFailure.capture(request).first();
        assertThat(cause.setting()).isEqualTo("timeoutMilliseconds");
        assertThat(cause.threshold()).isEqualTo(1001);
        assertThat(cause.observed()).isBetween(10L, 500L);
        assertThat(limits("{\"timeoutMilliseconds\":20000}").timeoutMilliseconds()).isEqualTo(20000);
        assertThat(PcmQueryLimits.from(request)).isSameAs(snapshot);
        var authority = new SystemRequestDetails();
        PcmQueryLimits.deadline(authority, java.time.Instant.now().plusMillis(1001));
        PcmQueryLimits.timedOut(authority);
        assertThat(PcmBudgetFailure.capture(authority).first()).isNull();
    }

    @Test void admissionCapturesActualOccupancyAtRefusalAndSeparatesRequests() {
        var gate = new PcmQueryAdmission();
        var accepted = new SystemRequestDetails(); var refused = new SystemRequestDetails();
        var slot = gate.acquire(1, accepted);
        assertThat(gate.acquire(1, refused)).isNull();
        assertThat(PcmBudgetFailure.capture(refused).first().fields()).isEqualTo(java.util.Map.of(
                "setting", "maxConcurrentQueries", "threshold", 1L, "observed", 1L, "unit", "active queries"));
        assertThat(PcmBudgetFailure.capture(accepted).first()).isNull();
        slot.close(); var recovery = gate.acquire(1, new SystemRequestDetails()); assertThat(recovery).isNotNull(); recovery.close();
    }

    @Test void failedWarningAppenderCannotEraseCaptureOrChangeEnforcement() {
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(PcmQueryLimits.class);
        var broken = new ch.qos.logback.core.AppenderBase<ch.qos.logback.classic.spi.ILoggingEvent>() {
            @Override protected void append(ch.qos.logback.classic.spi.ILoggingEvent event) { throw new IllegalStateException("owned warning failure"); }
        };
        var priorLevel = logger.getLevel(); logger.setLevel(ch.qos.logback.classic.Level.WARN);
        broken.setContext(logger.getLoggerContext()); broken.start(); logger.addAppender(broken);
        var request = new SystemRequestDetails();
        try {
            PcmQueryLimits.exceeded(request, "maxAllocatedBytes", 2147483648L, 2159627600L);
            assertThat(PcmBudgetFailure.capture(request).first()).isEqualTo(PcmBudgetFailure.of("maxAllocatedBytes", 2147483648L, 2159627600L));
        } finally { logger.detachAppender(broken); broken.stop(); logger.setLevel(priorLevel); }
    }

}
