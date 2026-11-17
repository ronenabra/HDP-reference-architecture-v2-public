package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

/** Target identity and operation controls cannot confer result authority. */
class PcmEverythingPolicyTest {
    final PcmRequestContext clinical = context(PcmRequestContext.Kind.DATA_SOURCE_ACCESS, "one");
    private PcmRequestContext context(PcmRequestContext.Kind kind, String patient) {
        return new PcmRequestContext("ho-a", "client", List.of(
                new PcmReadGrant("Patient", null, "one", Set.of('s')),
                new PcmReadGrant("Observation", "status=final", "one", Set.of('s')),
                new PcmReadGrant("Practitioner", null, null, Set.of('r'))), kind, null, List.of(), null, false, null, patient);
    }
    private SystemRequestDetails request(Map<String, String[]> parameters) {
        var request = new SystemRequestDetails(); request.setParameters(parameters);
        request.setRestOperationType(RestOperationTypeEnum.EXTENDED_OPERATION_TYPE); return request;
    }
    @Test void bothFormsRequireIndependentSingleTargetAndDeriveOnlySearchableTypes() {
        var first = PcmEverythingPolicy.prepare(request(Map.of()), clinical, "https://a/fhir/Patient/$everything");
        var second = PcmEverythingPolicy.prepare(request(Map.of()), clinical, "https://a/fhir/Patient/one/$everything");
        assertThat(first).isEqualTo(second); assertThat(first.types()).containsExactlyInAnyOrder("Patient", "Observation");
        assertThatThrownBy(() -> PcmEverythingPolicy.prepare(request(Map.of()), clinical, "https://a/fhir/Patient/two/$everything"))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
        assertThatThrownBy(() -> PcmEverythingPolicy.prepare(request(Map.of()), context(PcmRequestContext.Kind.DATA_SOURCE_ACCESS, null), "https://a/fhir/Patient/$everything"))
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
    }
    @Test void typesIntersectWithoutDroppingAnEmptyRestriction() {
        var selected = PcmEverythingPolicy.prepare(request(Map.of("_type", new String[]{"Observation,Binary"})), clinical,
                "https://a/fhir/Patient/$everything?_type=Observation,Binary");
        assertThat(selected.types()).containsExactly("Observation");
        assertThatThrownBy(() -> PcmEverythingPolicy.prepare(request(Map.of("_type", new String[]{"Binary"})), clinical,
                "https://a/fhir/Patient/$everything?_type=Binary")).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
    }
    @Test void everyUnsupportedControlFailsBeforeNativeWork() {
        for (String control : List.of("start", "end", "_since", "_filter", "_mdm", "_id", "code", "_total", "_summary", "_include", "_offset", "_format")) {
            assertThatThrownBy(() -> PcmEverythingPolicy.prepare(request(Map.of(control, new String[]{"x"})), clinical,
                    "https://a/fhir/Patient/$everything?" + control + "=x"))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.InvalidRequestException.class);
        }
    }
    @Test void unrelatedContextKindsNeverGainOperation() {
        for (var kind : List.of(PcmRequestContext.Kind.ONLINE_PRESENCE, PcmRequestContext.Kind.BATCH_PRESENCE,
                PcmRequestContext.Kind.PATIENT_AUTHENTICATION, PcmRequestContext.Kind.DEPENDENT_DISCOVERY, PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE)) {
            assertThatThrownBy(() -> PcmEverythingPolicy.prepare(request(Map.of()), context(kind, "one"), "https://a/fhir/Patient/$everything"))
                    .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException.class);
        }
    }
    @Test void retiredSimulationIsRejectedAtConstructionAndClinicalTypesRemainFinite() {
        for (String patient : new String[]{null, "one"}) {
            assertThatThrownBy(() -> context(PcmRequestContext.Kind.UNFILTERED_SIMULATION, patient))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(PcmEverythingPolicy.prepare(request(Map.of()), clinical, "https://a/fhir/Patient/$everything").types())
                .containsExactlyInAnyOrder("Patient", "Observation");
    }
    @Test void cursorAuthorityIncludesTargetAndRetainsRequestedTypeRestriction() {
        assertThat(PcmPageState.authority(clinical)).isNotEqualTo(PcmPageState.authority(context(PcmRequestContext.Kind.DATA_SOURCE_ACCESS, "two")));
        var request = request(Map.of("_count", new String[]{"1"})); request.setRestOperationType(RestOperationTypeEnum.GET_PAGE);
        for (String name : List.of("_type", "%5Ftype")) {
            assertThat(PcmEverythingPolicy.prepare(request, clinical, "https://a/fhir/Patient/$everything?" + name + "=Observation&_count=1").types())
                    .containsExactly("Observation");
        }
    }
    @Test void exactPathMatchingDoesNotAdmitOtherOperationsOrEncodedIds() {
        assertThat(PcmEverythingPolicy.isPath("Patient/$everything")).isTrue();
        for (String path : List.of("Patient/one/$everything/extra", "Patient/%6Fne/$everything", "Observation/one/$everything", "Patient/$export"))
            assertThat(PcmEverythingPolicy.isPath(path)).isFalse();
    }
}
