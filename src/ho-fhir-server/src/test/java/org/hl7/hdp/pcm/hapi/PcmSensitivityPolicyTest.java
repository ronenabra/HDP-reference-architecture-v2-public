package org.hl7.hdp.pcm.hapi;

import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

/** Unsupported mixed and unknown sensitivity records fail closed without affecting full access. */
class PcmSensitivityPolicyTest {
    private static final String FILTER = "_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests"
            + "&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V";
    private static final String LOCAL = "http://fhir.health.gov.il/cs/il-core-sensitivity-labels";

    @Test
    void ordinaryAndSingleKnownCategoriesReachNativeAlternativesButUnknownAndMixedNeverDo() {
        Observation record = new Observation();
        assertThat(PcmSensitivityPolicy.permits(FILTER, record)).isTrue();
        record.getMeta().addSecurity(LOCAL, "genetics", null);
        assertThat(PcmSensitivityPolicy.permits(FILTER, record)).isTrue();
        record.getMeta().addSecurity(LOCAL, "unknown", null);
        assertThat(PcmSensitivityPolicy.permits(FILTER, record)).isFalse();
        record.getMeta().getSecurity().clear();
        record.getMeta().addSecurity(LOCAL, "unknown", null);
        assertThat(PcmSensitivityPolicy.permits(FILTER, record)).isFalse();
        record.getMeta().getSecurity().clear();
        record.getMeta().addSecurity(LOCAL, "genetics", null);
        record.getMeta().addSecurity(LOCAL, "mental-health", null);
        assertThat(PcmSensitivityPolicy.permits(FILTER, record)).isFalse();
        // Full-access grants and unbucketed Patient identity have no compiled guard.
        assertThat(PcmSensitivityPolicy.permits(null, record)).isTrue();
        assertThat(PcmSensitivityPolicy.permits("identifier=http://example.test/id|1", record)).isTrue();
    }

    @Test
    void supportedPositiveOrAndOrdinaryExclusionsKeepCompleteAlternativeSyntax() {
        String or = "_security=" + LOCAL + "|genetics," + LOCAL + "|mental-health";
        assertThat(PcmFilterSupport.isSupported("Observation", FILTER + "&" + or)).isTrue();
        assertThat(PcmSmartScopeParser.parse("patient/Observation.s?" + FILTER + "&" + or, "one"))
                .singleElement().satisfies(grant -> assertThat(grant.filter()).contains(or));
    }
}
