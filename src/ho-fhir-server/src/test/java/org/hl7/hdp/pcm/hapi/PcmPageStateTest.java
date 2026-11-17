package org.hl7.hdp.pcm.hapi;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

/** Effective-authority equivalence, cursor integrity, fixed bounds and positive-count controls. */
class PcmPageStateTest {
    private PcmRequestContext context(String ho, String patient, String filter) {
        return new PcmRequestContext(ho, "client", List.of(new PcmReadGrant("Observation", filter, patient, Set.of('s'))));
    }
    @Test void positiveCountsAreStrictCappedAndDefaulted() {
        assertThat(PcmPageRequestPolicy.count(Map.of())).isEqualTo(20);
        assertThat(PcmPageRequestPolicy.count(Map.of("_count", new String[]{"999999999"}))).isEqualTo(100);
        for (String invalid : List.of("0", "-1", "1.5", "2147483648", "00", "+1", " 1")) {
            assertThatThrownBy(() -> PcmPageRequestPolicy.count(Map.of("_count", new String[]{invalid})))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        }
        assertThatThrownBy(() -> PcmPageRequestPolicy.count(Map.of("_count", new String[]{"1", "1"})))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
    }
    @Test void equivalentFreshAuthorityCanContinueButOtherPatientSourceClientAndGrantCannot() {
        PcmPageState states = new PcmPageState();
        var initial = context("ho-a", "p", "status=final&date=ge2026");
        var search = states.create(java.util.UUID.randomUUID().toString(), "Observation", 1, initial, "query");
        String cursor = states.cursor(search, 15);
        assertThat(states.resolve(cursor, context("ho-a", "p", "date=ge2026&status=final")).offset()).isEqualTo(15);
        for (var other : List.of(context("ho-b", "p", "status=final&date=ge2026"),
                context("ho-a", "q", "status=final&date=ge2026"), context("ho-a", "p", "status=final"),
                new PcmRequestContext("ho-a", "other", initial.readGrants()))) {
            assertThatThrownBy(() -> states.resolve(cursor, other)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
        }
        assertThatThrownBy(() -> states.resolve(cursor.replace(".15.", ".16."), initial))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
    }
    @Test void retainedParsedFormPredicatesAreImmutableAndNeverBecomeThePublicUrl() {
        var states = new PcmPageState(); var context = context("ho-a", "p", null);
        String[] repeated = {"a|b", "c|d"};
        var parameters = new java.util.HashMap<String, String[]>();
        parameters.put("code", repeated); parameters.put("_count", new String[]{"1"});
        var search = states.create(java.util.UUID.randomUUID().toString(), "Observation", 1, context,
                "https://ho/fhir/Observation/_search?status=final", "policy", null, 0, PcmQueryLimits.DEFAULTS, parameters);
        repeated[0] = "tampered"; parameters.clear();
        var retained = states.resolve(states.cursor(search, 1), context, "policy").search();
        assertThat(retained.predicates()).containsEntry("code", List.of("a|b", "c|d")).doesNotContainKey("_count");
        assertThat(retained.query()).isEqualTo("https://ho/fhir/Observation/_search?status=final");
        assertThatThrownBy(() -> retained.predicates().get("code").add("tampered")).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> retained.predicates().clear()).isInstanceOf(UnsupportedOperationException.class);
    }

    @Test void duplicateAndReorderedGrantsAreEquivalent() {
        var a = new PcmReadGrant("Observation", "status=final", "p");
        var b = new PcmReadGrant("Practitioner", null, null, Set.of('r'));
        assertThat(PcmPageState.authority(new PcmRequestContext("ho-a", "client", List.of(a,b,a))))
                .isEqualTo(PcmPageState.authority(new PcmRequestContext("ho-a", "client", List.of(b,a))));
    }
    @Test void boundedCapacityEvictsOldSearchAndRestartInvalidatesItsAuthenticator() {
        var states = new PcmPageState(); var context = context("ho-a", "p", null);
        var first = states.create(java.util.UUID.randomUUID().toString(), "Observation", 1, context, "q");
        String cursor = states.cursor(first, 1);
        for (int n = 0; n < PcmPageState.MAX_SEARCHES; n++) states.create(java.util.UUID.randomUUID().toString(), "Observation", 1, context, "q");
        assertThatThrownBy(() -> states.resolve(cursor, context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
        assertThatThrownBy(() -> new PcmPageState().resolve(cursor, context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
    }
    @Test void expiredStateIsGoneWithoutWaiting() {
        class MutableClock extends Clock {
            Instant now = Instant.EPOCH;
            public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
            public Clock withZone(java.time.ZoneId zone) { return this; }
            public Instant instant() { return now; }
        }
        MutableClock clock = new MutableClock(); var states = new PcmPageState(clock); var context = context("ho-a", "p", null);
        var search = states.create(java.util.UUID.randomUUID().toString(), "Observation", 1, context, "q");
        String cursor = states.cursor(search, 1);
        clock.now = clock.now.plusMillis(PcmPageState.TTL_MILLIS);
        assertThatThrownBy(() -> states.resolve(cursor, context)).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ResourceGoneException.class);
    }
    @Test void equivalentGrantCannotContinueAcrossDifferentVerifiedSourcePolicyRevision() {
        var states = new PcmPageState(); var context = context("ho-a", "p", null);
        var search = states.create(java.util.UUID.randomUUID().toString(), "Observation", 1, context, "query", "policy-one");
        String cursor = states.cursor(search, 1);
        assertThat(states.resolve(cursor, context, "policy-one").offset()).isEqualTo(1);
        assertThatThrownBy(() -> states.resolve(cursor, context, "policy-two"))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
    }

}
