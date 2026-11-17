package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.searchparam.matcher.AuthorizationSearchParamMatcher;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthorizationSearchParamMatcher;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Verifies the probe's supported/deferred classification contract. */
class PcmMatcherProbeTest {
    @Test
    void recordsRequiredMatchesAndDeferredFailures() {
        AuthorizationSearchParamMatcher matcher = mock(AuthorizationSearchParamMatcher.class);
        for (String expression : new String[]{
                "Observation?_security=", "Observation?_security:not=", "Patient?identifier=",
                "Observation?status=", "Observation?subject=", "Observation?date="}) {
            when(matcher.match(startsWith(expression), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(IAuthorizationSearchParamMatcher.MatchResult.buildMatched());
        }
        when(matcher.match(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(IAuthorizationSearchParamMatcher.MatchResult.buildUnsupported("deferred"));
        // Restub supported forms after the general fail-closed default.
        for (String expression : new String[]{
                "Observation?_security=http", "Observation?_security:not=http", "Patient?identifier=http",
                "Observation?status=final", "Observation?subject=Patient", "Observation?date=ge"}) {
            when(matcher.match(startsWith(expression), org.mockito.ArgumentMatchers.any()))
                    .thenReturn(IAuthorizationSearchParamMatcher.MatchResult.buildMatched());
        }

        Map<String, IAuthorizationSearchParamMatcher.Match> results = PcmMatcherProbe.probe(matcher);

        assertThat(results).containsEntry("status", IAuthorizationSearchParamMatcher.Match.MATCH);
        assertThat(results).containsEntry("_has", IAuthorizationSearchParamMatcher.Match.UNSUPPORTED);
    }
}
