package org.hl7.hdp.pcm.hapi;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Executable admission matrix for the non-deferred matcher vocabulary. */
class PcmFilterSupportTest {
    @Test
    void acceptsMeasuredBaselineExpressions() {
        assertThat(PcmFilterSupport.isSupported("Observation", "_security=http://labels|normal")).isTrue();
        assertThat(PcmFilterSupport.isSupported("Observation", "_security:not=http://labels|restricted")).isTrue();
        assertThat(PcmFilterSupport.isSupported("Patient", "identifier=http://mrn|123")).isTrue();
        assertThat(PcmFilterSupport.isSupported("Observation", "status=final&subject=Patient/123")).isTrue();
        assertThat(PcmFilterSupport.isSupported("Observation", "date=ge2026-01-01")).isTrue();
        assertThat(PcmFilterSupport.isSupported("Encounter", null)).isTrue();
    }

    @Test
    void rejectsEveryDeferredExpressionClass() {
        assertThat(PcmFilterSupport.isSupported("Observation", "subject.identifier=123")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "_has:Provenance:target:agent=Practitioner/1")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "_filter=status eq final")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "_lastUpdated=ge2026-01-01")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "code-value-quantity=loinc$5|mg")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "status:missing=false")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "_sort=date")).isFalse();
        assertThat(PcmFilterSupport.isSupported("Observation", "unknown=value")).isFalse();
        assertThat(PcmFilterSupport.isSupported("observation", "status=final")).isFalse();
    }
}
