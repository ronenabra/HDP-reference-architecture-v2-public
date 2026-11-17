package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Patient;
import org.hl7.fhir.r4.model.RelatedPerson;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.assertj.core.api.Assertions.*;

/** System searches must retain identity predicates and return only projected data. */
class PcmSystemSearchPolicyTest {
    private static final PcmPatientIdentifier ID = new PcmPatientIdentifier("http://example.test/id", "001");

    private PcmRequestContext context(PcmRequestContext.Kind kind) {
        return new PcmRequestContext("ho", "client", List.of(), kind,
                kind == PcmRequestContext.Kind.PATIENT_AUTHENTICATION ? ID : null, List.of(), null, false,
                kind == PcmRequestContext.Kind.DEPENDENT_DISCOVERY ? ID : null);
    }

    @Test
    void requiresExactIdentityAndRejectsExpansionAndDuplicateParameters() {
        PcmRequestContext auth = context(PcmRequestContext.Kind.PATIENT_AUTHENTICATION);
        assertThatCode(() -> PcmSystemSearchPolicy.validate(auth, "Patient", Map.of("identifier", new String[]{ID.token()})))
                .doesNotThrowAnyException();
        for (Map<String, String[]> query : List.of(
                Map.of("identifier", new String[]{ID.token(), ID.token()}),
                Map.of("identifier", new String[]{ID.token()}, "_include", new String[]{"*"}),
                Map.of("identifier", new String[]{ID.token()}, "_elements", new String[]{"address"}),
                Map.of("identifier", new String[]{"http://example.test/id|002"}))) {
            assertThatThrownBy(() -> PcmSystemSearchPolicy.validate(auth, "Patient", query))
                    .isInstanceOf(ForbiddenOperationException.class);
        }
        PcmRequestContext discovery = context(PcmRequestContext.Kind.DEPENDENT_DISCOVERY);
        assertThatCode(() -> PcmSystemSearchPolicy.validate(discovery, "Patient",
                Map.of("_has:RelatedPerson:patient:identifier", new String[]{ID.token()}))).doesNotThrowAnyException();
        assertThatCode(() -> PcmSystemSearchPolicy.validate(discovery, "RelatedPerson",
                Map.of("identifier", new String[]{ID.token()}))).doesNotThrowAnyException();
        assertThatThrownBy(() -> PcmSystemSearchPolicy.validate(discovery, "Patient",
                Map.of("identifier", new String[]{ID.token()}))).isInstanceOf(ForbiddenOperationException.class);
    }

    @Test
    void projectsNestedResultsWithoutMutatingStoredResourcesAndPreservesModifiers() {
        Patient patient = new Patient(); patient.setId("Patient/one");
        patient.addIdentifier().setSystem(ID.system()).setValue(ID.value());
        patient.addName().setFamily("Example"); patient.addAddress().setCity("Private");
        patient.addTelecom().setValue("0500000000"); patient.setBirthDateElement(new org.hl7.fhir.r4.model.DateType("2000-01-01"));
        patient.setActive(false); patient.setDeceased(new org.hl7.fhir.r4.model.BooleanType(true));
        patient.getMeta().addSecurity().setSystem("urn:security").setCode("R");
        Bundle search = new Bundle().setType(Bundle.BundleType.SEARCHSET);
        search.addEntry().setResource(patient);
        Bundle batch = new Bundle().setType(Bundle.BundleType.BATCHRESPONSE);
        batch.addEntry().setResource(search);
        PcmResponsePolicyInterceptor.projectBundle(batch, PcmRequestContext.Kind.DEPENDENT_DISCOVERY);
        Patient projected = (Patient) search.getEntryFirstRep().getResource();
        assertThat(projected.hasAddress()).isFalse(); assertThat(projected.hasTelecom()).isFalse();
        assertThat(projected.hasBirthDate()).isFalse(); assertThat(projected.hasDeceased()).isTrue();
        assertThat(projected.getActive()).isFalse(); assertThat(projected.getMeta().getSecurity()).hasSize(1);
        assertThat(projected.getMeta().getTag().stream().anyMatch(tag -> "http://terminology.hl7.org/CodeSystem/v3-ObservationValue".equals(tag.getSystem()) && "SUBSETTED".equals(tag.getCode()))).isTrue();
        assertThat(patient.hasAddress()).isTrue();
        search.getEntryFirstRep().setResource(patient);
        PcmResponsePolicyInterceptor.projectBundle(search, PcmRequestContext.Kind.PATIENT_AUTHENTICATION);
        projected = (Patient) search.getEntryFirstRep().getResource();
        assertThat(projected.hasTelecom()).isTrue(); assertThat(projected.hasBirthDate()).isTrue();
        assertThat(projected.hasAddress()).isFalse();
        RelatedPerson relation = new RelatedPerson(); relation.getPatient().setReference("Patient/one");
        relation.addName().setFamily("Private"); relation.setActive(true);
        search.getEntryFirstRep().setResource(relation);
        PcmResponsePolicyInterceptor.projectBundle(search, PcmRequestContext.Kind.DEPENDENT_DISCOVERY);
        RelatedPerson result = (RelatedPerson) search.getEntryFirstRep().getResource();
        assertThat(result.hasName()).isFalse(); assertThat(result.getPatient().getReference()).isEqualTo("Patient/one");
        assertThat(result.getActive()).isTrue();
    }
}
