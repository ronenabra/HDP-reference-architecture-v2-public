package org.hl7.hdp.pcm.hapi;

import java.util.List;
import java.util.Map;
import java.util.HashMap;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Patient;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Exact sampler query and result projection remain enforced independently of easy controls. */
class PcmSandboxSamplePolicyTest {
    private Map<String, String[]> query() { return new HashMap<>(Map.of(
            "identifier", new String[]{PcmSandboxSamplePolicy.SYSTEM + "|"}, "_count", new String[]{"10"},
            "_total", new String[]{"none"}, "_elements", new String[]{"identifier,name,birthDate"})); }
    @Test
    void exactSearchAdmitsAndAllWideningFails() {
        PcmRequestContext context = new PcmRequestContext("ho-a", "sampler", List.of(),
                PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE, null, List.of(), null, false);
        PcmRoutePolicyInterceptor policy = new PcmRoutePolicyInterceptor(request -> context);
        SystemRequestDetails request = new SystemRequestDetails(); request.setResourceName("Patient"); request.setRequestPath("Patient"); request.setParameters(query());
        policy.enforce(request, RestOperationTypeEnum.SEARCH_TYPE);
        for (String parameter : List.of("identifier", "_count", "_total", "_elements", "_include", "_offset")) {
            Map<String, String[]> widened = query(); widened.put(parameter, new String[]{"*"});
            assertThatThrownBy(() -> PcmSandboxSamplePolicy.validate(widened)).isInstanceOf(RuntimeException.class);
        }
        Map<String, String[]> repeated = query(); repeated.put("_count", new String[]{"10", "100"});
        assertThatThrownBy(() -> PcmSandboxSamplePolicy.validate(repeated)).isInstanceOf(RuntimeException.class);
        for (RestOperationTypeEnum operation : List.of(RestOperationTypeEnum.READ, RestOperationTypeEnum.CREATE, RestOperationTypeEnum.GET_PAGE, RestOperationTypeEnum.HISTORY_TYPE, RestOperationTypeEnum.TRANSACTION)) {
            assertThatThrownBy(() -> policy.enforce(request, operation)).isInstanceOf(RuntimeException.class);
        }
    }
    @Test
    void projectsOnlySandboxIdentifierNameBirthDateAndMandatoryMetadataAndCapsEntries() {
        SystemRequestDetails request = new SystemRequestDetails(); request.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE,
                new PcmRequestContext("ho-a", "sampler", List.of(), PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE, null, List.of(), null, false));
        Bundle bundle = new Bundle().setType(Bundle.BundleType.SEARCHSET).setTotal(10000);
        bundle.addLink().setRelation("next").setUrl("https://malicious.invalid/next");
        for (int i = 0; i < 11; i++) {
            Patient patient = new Patient(); patient.setId("Patient/" + i); patient.addIdentifier().setSystem(PcmSandboxSamplePolicy.SYSTEM).setValue("12345678-1234-1234-1234-" + String.format("%012d", i + 1));
            patient.addIdentifier().setSystem("urn:private").setValue("secret"); patient.addName().setText("Synthetic name"); patient.addTelecom().setValue("secret"); patient.setBirthDateElement(new org.hl7.fhir.r4.model.DateType("1990-01-01"));
            patient.getMeta().addSecurity("http://terminology.hl7.org/CodeSystem/v3-ActReason", "HTEST", null);
            bundle.addEntry().setResource(patient);
        }
        new PcmResponsePolicyInterceptor().removeOrdinaryTotal(request, bundle);
        assertThat(bundle.getEntry()).hasSize(10); assertThat(bundle.hasTotal()).isFalse(); assertThat(bundle.getLink()).isEmpty();
        Patient result = (Patient) bundle.getEntryFirstRep().getResource(); assertThat(result.getIdentifier()).hasSize(1); assertThat(result.hasTelecom()).isFalse(); assertThat(result.getBirthDateElement().getValueAsString()).isEqualTo("1990-01-01"); assertThat(result.getMeta().getSecurity()).hasSize(1);
    }
    @Test
    void preservesFullPartialAndMissingBirthDateWithoutOtherDemographics() {
        for (String date : List.of("1985-03-12", "1985-03", "1985", "")) {
            SystemRequestDetails request = new SystemRequestDetails();
            request.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE,
                    new PcmRequestContext("ho-a", "sampler", List.of(), PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE, null, List.of(), null, false));
            Patient patient = new Patient();
            patient.addIdentifier().setSystem(PcmSandboxSamplePolicy.SYSTEM).setValue("12345678-1234-1234-1234-123456789abc");
            patient.getMeta().addSecurity("http://terminology.hl7.org/CodeSystem/v3-ActReason", "HTEST", null);
            if (!date.isEmpty()) patient.setBirthDateElement(new org.hl7.fhir.r4.model.DateType(date));
            patient.addAddress().setCity("Private"); patient.addTelecom().setValue("Private");
            Bundle bundle = new Bundle().setType(Bundle.BundleType.SEARCHSET); bundle.addEntry().setResource(patient);
            new PcmResponsePolicyInterceptor().removeOrdinaryTotal(request, bundle);
            Patient result = (Patient) bundle.getEntryFirstRep().getResource();
            assertThat(result.hasBirthDateElement()).isEqualTo(!date.isEmpty());
            if (!date.isEmpty()) assertThat(result.getBirthDateElement().getValueAsString()).isEqualTo(date);
            assertThat(result.hasAddress()).isFalse(); assertThat(result.hasTelecom()).isFalse();
        }
        for (String elements : List.of("identifier,name", "identifier,name,birthDate,telecom", "*")) {
            Map<String, String[]> wider = query(); wider.put("_elements", new String[]{elements});
            assertThatThrownBy(() -> PcmSandboxSamplePolicy.validate(wider)).isInstanceOf(RuntimeException.class);
        }
    }
    @Test
    void sourceExcludesUntaggedAmbiguousDuplicateAndInvalidRowsWithoutScanningPastFirstTen() {
        SystemRequestDetails request = new SystemRequestDetails(); request.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE,
                new PcmRequestContext("ho-a", "app", List.of(), PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE, null, List.of(), null, false));
        Bundle bundle = new Bundle().setType(Bundle.BundleType.SEARCHSET);
        for (int i = 0; i < 11; i++) {
            Patient patient = new Patient();
            patient.addIdentifier().setSystem(PcmSandboxSamplePolicy.SYSTEM).setValue("12345678-1234-1234-1234-" + String.format("%012d", i + 1));
            patient.getMeta().addSecurity("http://terminology.hl7.org/CodeSystem/v3-ActReason", "HTEST", null);
            if (i == 0) patient.getMeta().getSecurity().clear();
            if (i == 1) patient.addIdentifier().setSystem(PcmSandboxSamplePolicy.SYSTEM).setValue("12345678-1234-1234-1234-000000000099");
            if (i == 2) patient.getIdentifierFirstRep().setValue("not-a-guid");
            if (i == 4) patient.getIdentifierFirstRep().setValue("12345678-1234-1234-1234-000000000004");
            bundle.addEntry().setResource(patient);
        }
        new PcmResponsePolicyInterceptor().removeOrdinaryTotal(request, bundle);
        assertThat(bundle.getEntry()).hasSize(6);
        assertThat(bundle.getEntry().stream().map(entry -> ((Patient) entry.getResource()).getIdentifierFirstRep().getValue()))
                .doesNotContain("12345678-1234-1234-1234-000000000011");
    }
}
