package org.hl7.hdp.pcm.hapi;

import org.junit.jupiter.api.Test;
import java.util.Map;
import java.util.List;
import static org.assertj.core.api.Assertions.*;

/** Explicit count aliases, ambiguity and unchanged conjunction regression cases. */
class PcmCountRequestPolicyTest {
    @Test void acceptsAccurateSummaryAndZeroAliasesIncludingPositivePageSizeHint() {
        assertThat(PcmCountRequestPolicy.isCount(Map.of("_summary", new String[]{"count"}))).isTrue();
        assertThat(PcmCountRequestPolicy.isCount(Map.of("_count", new String[]{"0"}))).isTrue();
        assertThat(PcmCountRequestPolicy.isCount(Map.of("_summary", new String[]{"count"}, "_count", new String[]{"25"}, "_total", new String[]{"accurate"}))).isTrue();
        assertThat(PcmCountRequestPolicy.isCount(Map.of("_count", new String[]{"25"}))).isFalse();
    }

    @Test void rejectsDuplicatesContradictoryTotalsAndMalformedControls() {
        for (Map<String, String[]> parameters : List.of(
                Map.of("_summary", new String[]{"count", "count"}),
                Map.of("_count", new String[]{"0", "1"}),
                Map.of("_summary", new String[]{"count"}, "_total", new String[]{"estimate"}),
                Map.of("_summary", new String[]{"count"}, "_total", new String[]{"none"}),
                Map.of("_count", new String[]{"0"}, "_summary", new String[]{"text"}),
                Map.of("_count", new String[]{"-1"}), Map.of("_count", new String[]{"00"}),
                Map.of("_summary", new String[]{"count, true"}))) {
            assertThatThrownBy(() -> PcmCountRequestPolicy.isCount(parameters))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        }
    }

    @Test void retainsEveryClientPredicateAndOmitsReferenceExpansion() {
        assertThat(PcmCountRequestPolicy.predicates(Map.of("status", new String[]{"final", "amended"},
                "date", new String[]{"ge2026-01-01", "le2026-12-31"}, "_include", new String[]{"Observation:performer"},
                "_summary", new String[]{"count"})))
                .containsExactlyInAnyOrderEntriesOf(Map.of("status", List.of("final", "amended"),
                        "date", List.of("ge2026-01-01", "le2026-12-31")));
    }
}
