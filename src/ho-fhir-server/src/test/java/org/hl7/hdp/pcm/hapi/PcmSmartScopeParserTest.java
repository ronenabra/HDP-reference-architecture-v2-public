package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Matrix coverage for strict SMART scope parsing and interaction letters. */
class PcmSmartScopeParserTest {
    @Test
    void preservesIndependentScopeUnionAndInScopeConjunction() {
        List<PcmReadGrant> grants = PcmSmartScopeParser.parse(
                "patient/Observation.rs?status=final&date=ge2026-01-01 patient/Observation.s?status=preliminary",
                "patient-1");

        assertThat(grants).hasSize(2);
        assertThat(grants.get(0).filter()).isEqualTo("status=final&date=ge2026-01-01");
        assertThat(grants.get(1).filter()).isEqualTo("status=preliminary");
        assertThat(PcmInteractionGate.permits(grants.get(0), RestOperationTypeEnum.READ)).isTrue();
        assertThat(PcmInteractionGate.permits(grants.get(1), RestOperationTypeEnum.READ)).isFalse();
        assertThat(PcmInteractionGate.permits(grants.get(1), RestOperationTypeEnum.SEARCH_TYPE)).isTrue();
    }

    @Test
    void explicitMasterReadsRetainPatientContextButOnlyPermitLogicalIdRead() {
        for (String type : List.of("Organization", "Practitioner", "PractitionerRole", "Location")) {
            PcmReadGrant grant = PcmSmartScopeParser.parse("patient/" + type + ".r?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V", "patient-1").get(0);
            assertThat(grant.masterRead()).isTrue();
            assertThat(grant.patientId()).isEqualTo("patient-1");
            assertThat(PcmInteractionGate.permitsResult(grant, RestOperationTypeEnum.READ, type)).isTrue();
            for (RestOperationTypeEnum operation : List.of(RestOperationTypeEnum.SEARCH_TYPE, RestOperationTypeEnum.GET_PAGE,
                    RestOperationTypeEnum.VREAD, RestOperationTypeEnum.HISTORY_INSTANCE, RestOperationTypeEnum.HISTORY_TYPE,
                    RestOperationTypeEnum.CREATE, RestOperationTypeEnum.UPDATE, RestOperationTypeEnum.DELETE)) {
                assertThat(PcmInteractionGate.permitsResult(grant, operation, type)).as(operation.name()).isFalse();
            }
            assertThat(PcmInteractionGate.permitsResult(grant, RestOperationTypeEnum.SEARCH_TYPE, "Observation")).isFalse();
        }
        for (String type : List.of("PractitionerRole", "Location")) {
            for (String scope : List.of("patient/" + type + ".s", "patient/" + type + ".rs", "system/" + type + ".r")) {
                assertThatThrownBy(() -> PcmSmartScopeParser.parse(scope, "patient-1")).isInstanceOf(SecurityException.class);
            }
            assertThat(PcmSmartScopeParser.parse("system/*.rs", null)).noneMatch(grant -> type.equals(grant.resourceType()));
        }
        assertThat(PcmSmartScopeParser.parse("patient/*.r", "patient-1")).allMatch(grant -> !grant.masterRead());
        assertThat(PcmSmartScopeParser.parse("system/Organization.r", null).get(0).masterRead()).isFalse();
        assertThatThrownBy(() -> PcmSmartScopeParser.parse("patient/Organization.r system/Practitioner.r", "patient-1")).isInstanceOf(SecurityException.class);
        assertThatThrownBy(() -> PcmSmartScopeParser.parse("patient/Organization.r", null)).isInstanceOf(SecurityException.class);
    }

    @Test
    void expandsWildcardOnlyToTheDeclaredNonBinarySurface() {
        List<PcmReadGrant> grants = PcmSmartScopeParser.parse("patient/*.rs", "patient-1");
        assertThat(grants).extracting(PcmReadGrant::resourceType)
                .containsExactlyInAnyOrderElementsOf(PcmSmartScopeParser.declaredResourceTypes().stream().filter(type -> !java.util.Set.of("Organization", "Practitioner", "PractitionerRole", "Location").contains(type)).toList())
                .doesNotContain("Binary", "DocumentReference", "Organization", "Practitioner", "PractitionerRole", "Location");
        assertThat(grants).allMatch(grant -> grant.filter() == null && grant.patientId().equals("patient-1") && grant.interactions().equals(java.util.Set.of('r', 's')) && !grant.masterRead());
    }

    @Test
    void rejectsMissingPatientAndEveryDeferredExpressionClass() {
        assertThatThrownBy(() -> PcmSmartScopeParser.parse("patient/Observation.rs", null))
                .isInstanceOf(SecurityException.class);
        for (String scope : List.of(
                "patient/Observation.rs?subject.identifier=123",
                "patient/Observation.rs?_has:Provenance:target:agent=x",
                "patient/Observation.rs?_filter=status%20eq%20final",
                "patient/Observation.rs?_lastUpdated=ge2026-01-01",
                "patient/Observation.rs?code-value-quantity=loinc$5",
                "patient/Observation.rs?status:missing=false",
                "patient/Observation.rs?_sort=date",
                "patient/Binary.r")) {
            assertThatThrownBy(() -> PcmSmartScopeParser.parse(scope, "patient-1"))
                    .as(scope).isInstanceOf(SecurityException.class);
        }
    }
}
