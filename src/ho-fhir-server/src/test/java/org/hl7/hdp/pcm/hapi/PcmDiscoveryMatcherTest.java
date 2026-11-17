package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher;
import org.hl7.fhir.r4.model.Patient;
import org.junit.jupiter.api.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.assertThat;

/** The exact reverse chain is an authorization predicate, independent of caller search filters. */
class PcmDiscoveryMatcherTest {
    @Test
    void matchesOnlyTheSamePatientAndRepresentativeAndFailsClosedOnLookupFailure() {
        AtomicInteger calls = new AtomicInteger();
        PcmDiscoveryMatcher matcher = new PcmDiscoveryMatcher(
                (expression, resource) -> IAuthorizationSearchParamMatcher.MatchResult.buildUnsupported("ordinary"),
                (identifier, patient) -> {
                    calls.incrementAndGet();
                    return identifier.token().equals("http://example.test/id|001") && patient.equals("dependent");
                });
        Patient dependent = new Patient(); dependent.setId("Patient/dependent");
        Patient other = new Patient(); other.setId("Patient/other");
        String scope = "Patient?_has:RelatedPerson:patient:identifier=http://example.test/id|001";
        assertThat(matcher.match(scope, dependent).match).isEqualTo(IAuthorizationSearchParamMatcher.Match.MATCH);
        assertThat(matcher.match(scope, other).match).isEqualTo(IAuthorizationSearchParamMatcher.Match.NO_MATCH);
        assertThat(matcher.match(scope.replace("001", "002"), dependent).match).isEqualTo(IAuthorizationSearchParamMatcher.Match.NO_MATCH);
        assertThat(matcher.match(scope + "&active=true", dependent).match).isEqualTo(IAuthorizationSearchParamMatcher.Match.NO_MATCH);
        assertThat(calls.get()).isEqualTo(3);
        PcmDiscoveryMatcher failed = new PcmDiscoveryMatcher(matcher, (identifier, patient) -> { throw new IllegalStateException("timeout"); });
        assertThat(failed.match(scope, dependent).match).isEqualTo(IAuthorizationSearchParamMatcher.Match.NO_MATCH);
    }

    @Test
    void unrelatedReverseChainsRemainUnsupported() {
        assertThat(PcmFilterSupport.isSupported("Patient", "_has:RelatedPerson:patient:identifier=http://example.test/id|001")).isTrue();
        assertThat(PcmFilterSupport.isSupported("Patient", "_has:RelatedPerson:patient:active=true")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "_has:RelatedPerson:patient:identifier=http://example.test/id|001")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Patient", "_has:RelatedPerson:patient:identifier=http://example.test/id|001,other")).isFalse();
    }
}
