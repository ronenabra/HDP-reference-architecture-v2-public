package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.jpa.searchparam.MatchUrlService;
import ca.uhn.fhir.jpa.searchparam.SearchParameterMap;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.param.TokenParam;
import ca.uhn.fhir.rest.param.DateParam;
import ca.uhn.fhir.rest.param.TokenParamModifier;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import ca.uhn.fhir.rest.param.ReferenceParam;
import ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

/** Native compiler preserves grant union, client conjunction and exceptional reference partitions. */
class PcmNativeMatchQueriesTest {
    final FhirContext fhir = FhirContext.forR4Cached();
    final MatchUrlService parser = mock(MatchUrlService.class);
    final PcmNativeMatchQueries compiler = new PcmNativeMatchQueries(fhir, parser);

    /** All declared families use their native compartment metadata; master exceptions stay explicit. */
    @Test void declaredTypeInventoryKeepsSelectionAndCountCompartmentPathsAligned() {
        var masters = Set.of("Organization", "Practitioner", "PractitionerRole", "Location");
        var inventory = java.util.Map.ofEntries(
                java.util.Map.entry("Patient", Set.of("Patient.link.other")),
                java.util.Map.entry("Observation", Set.of("Observation.subject", "Observation.performer")),
                java.util.Map.entry("Encounter", Set.of("Encounter.subject")),
                java.util.Map.entry("Condition", Set.of("Condition.asserter", "Condition.subject")),
                java.util.Map.entry("Procedure", Set.of("Procedure.performer.actor", "Procedure.subject")),
                java.util.Map.entry("MedicationRequest", Set.of("MedicationRequest.subject")),
                java.util.Map.entry("MedicationStatement", Set.of("MedicationStatement.subject")),
                java.util.Map.entry("MedicationAdministration", Set.of("MedicationAdministration.subject", "MedicationAdministration.performer.actor")),
                java.util.Map.entry("MedicationDispense", Set.of("MedicationDispense.receiver", "MedicationDispense.subject")),
                java.util.Map.entry("AllergyIntolerance", Set.of("AllergyIntolerance.asserter", "AllergyIntolerance.recorder", "AllergyIntolerance.patient")),
                java.util.Map.entry("Immunization", Set.of("Immunization.patient")),
                java.util.Map.entry("RelatedPerson", Set.of("RelatedPerson.patient")),
                java.util.Map.entry("DiagnosticReport", Set.of("DiagnosticReport.subject")));
        for (String type : PcmSmartScopeParser.declaredResourceTypes()) {
            if (masters.contains(type)) {
                var master = new PcmReadGrant(type, null, "p", Set.of('r'), true);
                assertThat(master.masterRead()).isTrue();
                continue;
            }
            var grant = new PcmReadGrant(type, null, "p");
            var count = compiler.compile(plan(type, grant), new SearchParameterMap(), type).get(0);
            assertThat(count.complete()).as(type).isNotEmpty();
            compiler.pageSelection(plan(type, grant), new SearchParameterMap(), type, links -> {
                assertThat(links.patients()).containsExactly("p");
                assertThat(links.paths()).as(type).isNotEmpty().allMatch(path -> path.startsWith(type + "."));
                assertThat(links.localLinks()).isEqualTo(type.equals("Patient"));
                assertThat(links.paths()).as(type).containsExactlyInAnyOrderElementsOf(inventory.get(type));
                return Set.of();
            });
        }
    }

    /** Build the same search-applicable effective plan used by the execution path. */
    PcmAuthorizedMatchPlan plan(String type, PcmReadGrant... grants) {
        var request = new SystemRequestDetails();
        request.setResourceName(type);
        request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        return new PcmAuthorizedMatchPlan(request, new PcmRequestContext("ho-a", "client", List.of(grants)),
                mock(RuleFilteringConsentService.class));
    }

    @Test void conjunctionAppendsAndGroupsWithoutChangingEitherInput() {
        var client = new SearchParameterMap("status", new TokenParam("final"));
        client.add("status", new TokenParam("amended"));
        var grant = new SearchParameterMap("status", new TokenParam("preliminary"));
        var joined = PcmNativeMatchQueries.conjunction(client, grant);
        assertThat(joined.get("status")).hasSize(3);
        assertThat(client.get("status")).hasSize(2);
        assertThat(grant.get("status")).hasSize(1);
    }

    @Test void pageKeepsCompleteGrantUnionAndRepeatedClientRestrictionsSeparateFromCandidates() {
        var a = new PcmReadGrant("Observation", "status=final", "p");
        var b = new PcmReadGrant("Observation", "status=preliminary", "other");
        var client = new SearchParameterMap("subject", new ReferenceParam("Patient/conflict"));
        client.add("subject", new ReferenceParam("Patient/p"));
        var selected = compiler.pageSelection(plan("Observation", a, b), client, "Observation",
                links -> Set.of("foreign", "mixed"));
        assertThat(selected.grants()).containsExactly(a, b);
        assertThat(selected.client().get("subject")).hasSize(2);
        assertThat(selected.candidates().get("subject")).hasSize(2);
        assertThat(selected.candidates().get("_filter").get(0).get(0).getValueAsQueryToken(fhir))
                .contains("performer eq \"Patient/p\"", "subject eq \"Patient/p\"",
                        "performer eq \"Patient/other\"", "subject eq \"Patient/other\"",
                        "_id eq \"foreign\"", "_id eq \"mixed\"", " or ");
        assertThat(selected.candidates().containsKey("status")).isFalse();
        assertThat(client.containsKey("_filter")).isFalse();
        var modified = selected.candidates(); modified.add("status", new TokenParam("amended"));
        assertThat(selected.candidates().containsKey("status")).isFalse();
        ((ReferenceParam) modified.get("subject").get(0).get(0)).setValue("Patient/mutated");
        ((ReferenceParam) selected.client().get("subject").get(0).get(0)).setValue("Patient/changed-client");
        ((ReferenceParam) client.get("subject").get(0).get(0)).setValue("Patient/changed-input");
        assertThat(((ReferenceParam) selected.candidates().get("subject").get(0).get(0)).getValue())
                .isEqualTo("Patient/conflict");
        assertThat(((ReferenceParam) selected.client().get("subject").get(0).get(0)).getValue())
                .isEqualTo("Patient/conflict");
    }

    @Test void pageFactorsOnlyIdenticalProvenScopeFiltersAndDoesNotCountOrResolveSystemPatients() {
        when(parser.translateMatchUrl(eq("status=final"), any()))
                .thenReturn(new SearchParameterMap("status", new TokenParam("final")));
        var selected = compiler.pageSelection(plan("Observation", new PcmReadGrant("Observation", "status=final", "p")),
                new SearchParameterMap("status", new TokenParam("preliminary")), "Observation", links -> Set.of());
        assertThat(selected.candidates().get("status")).hasSize(2);
        var system = compiler.pageSelection(plan("Observation", new PcmReadGrant("Observation", "status=final", null)),
                new SearchParameterMap(), "Observation", links -> { throw new AssertionError("system is not a compartment"); });
        assertThat(system.candidates().keySet()).containsExactly("status");
        assertThat(system.candidates().getCount()).isNull();
        assertThat(system.candidates().getSummaryMode()).isNull();
    }

    @Test void patientSelfUsesIdOnlyCoverAndUnprovenScopePredicatesRetainAuthoritativeResiduals() {
        var patient = compiler.pageSelection(plan("Patient", new PcmReadGrant("Patient", null, "p")),
                new SearchParameterMap("_id", new TokenParam("p")), "Patient",
                links -> {
                    assertThat(links.localLinks()).isTrue();
                    assertThat(links.paths()).containsExactly("Patient.link.other");
                    assertThat(links.patients()).containsExactly("p");
                    return Set.of("linked");
                });
        assertThat(patient.candidates().keySet()).containsExactlyInAnyOrder("_id", "_filter");
        assertThat(patient.candidates().get("_filter").get(0).get(0).getValueAsQueryToken(fhir))
                .contains("_id eq \"p\"", "_id eq \"linked\"").doesNotContain("link eq");
        assertThat(patient.reason()).isEqualTo("native-patient-self-and-link-ids+bounded-native-client-probe");
        when(parser.translateMatchUrl(eq("subject=Patient/p"), any()))
                .thenReturn(new SearchParameterMap("subject", new ReferenceParam("Patient/p")));
        var selected = compiler.pageSelection(plan("Observation", new PcmReadGrant("Observation", "subject=Patient/p", "p")),
                new SearchParameterMap(), "Observation", links -> Set.of());
        assertThat(selected.candidates().keySet()).containsExactly("_filter");
        assertThat(selected.grants().get(0).filter()).isEqualTo("subject=Patient/p");
    }

    @Test void selectiveProbeReceivesImmutableClientAndOnlyCompleteCommonScopeIntersection() {
        when(parser.translateMatchUrl(eq("identifier=urn:test|scope"), any()))
                .thenReturn(new SearchParameterMap("identifier", new TokenParam("urn:test", "scope")));
        var client = new SearchParameterMap();
        client.addOrList("_id", List.of(new TokenParam("self"), new TokenParam("link")));
        client.add("_id", new TokenParam("link"));
        compiler.pageSelection(plan("Patient", new PcmReadGrant("Patient", "identifier=urn:test|scope", "self")),
                client, "Patient", links -> {
                    assertThat(links.predicates().get("_id")).hasSize(2);
                    assertThat(links.predicates().get("_id").get(0)).hasSize(2);
                    assertThat(links.predicates().get("identifier")).hasSize(1);
                    links.predicates().get("_id").clear();
                    assertThat(links.predicates().keySet()).contains("identifier", "_id");
                    assertThat(links.predicates().get("_id")).hasSize(2);
                    return Set.of("link");
                });
        assertThat(client.keySet()).containsExactly("_id");
        compiler.pageSelection(plan("Patient", new PcmReadGrant("Patient", "status=active", "self"),
                        new PcmReadGrant("Patient", "status=inactive", "other")), client, "Patient", links -> {
                    assertThat(links.predicates().keySet()).containsExactly("_id");
                    assertThat(links.patients()).containsExactlyInAnyOrder("self", "other");
                    return Set.of();
                });
    }

    @Test void compartmentUsesPerformerAndSubjectAlternativesAndRetainsForeignReferences() {
        var p = plan("Observation", new PcmReadGrant("Observation", null, "p"));
        var result = compiler.compile(p, new SearchParameterMap(), "Observation");
        assertThat(result).hasSize(1);
        assertThat(result.get(0).complete()).extracting(SearchParameterMap::keySet)
                .containsExactly(Set.of("performer"), Set.of("subject"));
        assertThat(result.get(0).references()).hasSize(2);
        assertThat(result.get(0).references().get(0).localTargets()).isNull();
        assertThat(result.get(0).references().get(1).localTargets()).isNotNull();
    }

    @Test void patientSelfAndMultivaluedLinksStayIndependent() {
        var result = compiler.compile(plan("Patient", new PcmReadGrant("Patient", null, "p")),
                new SearchParameterMap(), "Patient").get(0);
        assertThat(result.complete()).extracting(SearchParameterMap::keySet)
                .containsExactly(Set.of("_id"), Set.of("link"));
        assertThat(result.references().get(0).localTargets()).isNull();
    }

    @Test void readOnlyGrantCannotBroadenSearchAndDuplicateScopesAreDeduplicated() {
        var s = new PcmReadGrant("Observation", "status=final", null, Set.of('s'));
        var r = new PcmReadGrant("Observation", null, null, Set.of('r'));
        when(parser.translateMatchUrl(eq("status=final"), any())).thenReturn(new SearchParameterMap("status", new TokenParam("final")));
        var result = compiler.compile(plan("Observation", s, s, r), new SearchParameterMap(), "Observation");
        assertThat(result).hasSize(1);
        assertThat(result.get(0).complete().get(0).get("status")).hasSize(1);
    }

    @Test void unprovenReferenceScopeFilterExplicitlyRetainsAuthoritativeMatcher() {
        when(parser.translateMatchUrl(eq("subject=Patient/p"), any()))
                .thenReturn(new SearchParameterMap("subject", new ReferenceParam("Patient/p")));
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "subject=Patient/p", "p")),
                new SearchParameterMap(), "Observation")).isEmpty();
    }

    /** Every parsed date value must be proven; the client side retains all native prefixes. */
    @ParameterizedTest
    @ValueSource(strings = {"sa", "eb", "ap", "ne"})
    void unprovenScopeDateFallsBackEvenBesideProvenGrant(String prefix) {
        var dates = new SearchParameterMap("date", new DateParam("ge1900-01-01"));
        dates.add("date", new DateParam(prefix + "1900-01-01"));
        when(parser.translateMatchUrl(eq("date=ge1900-01-01"), any())).thenReturn(dates);
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "date=ge1900-01-01", null),
                new PcmReadGrant("Observation", null, "p")), new SearchParameterMap(), "Observation")).isEmpty();
        var client = new SearchParameterMap("date", new DateParam(prefix + "1900-01-01"));
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", null, null)),
                client, "Observation")).hasSize(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "eq", "gt", "ge", "lt", "le"})
    void provenScopeDateRetainsNativePlan(String prefix) {
        when(parser.translateMatchUrl(eq("date=ge1900-01-01"), any()))
                .thenReturn(new SearchParameterMap("date", new DateParam(prefix + "1900-01-01")));
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "date=ge1900-01-01", "p")),
                new SearchParameterMap(), "Observation")).hasSize(1);
    }

    @Test void exceptionalTokensRetainMatcherForPatientAndSystemGrants() {
        for (var token : List.of(new TokenParam("", "718-7"), new TokenParam("http://loinc.org", ""),
                new TokenParam("http://loinc.org", null), new TokenParam(""))) {
            when(parser.translateMatchUrl(eq("code=718-7"), any())).thenReturn(new SearchParameterMap("code", token));
            for (String patient : new String[] {null, "p"}) {
                assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "code=718-7", patient)),
                        new SearchParameterMap(), "Observation")).isEmpty();
            }
        }
    }

    @Test void everyTokenOrMemberAndSecurityNotGroupRequiresProof() {
        var tokens = new SearchParameterMap();
        tokens.addOrList("code", List.of(new TokenParam("http://loinc.org", "718-7"), new TokenParam("", "718-7")));
        when(parser.translateMatchUrl(eq("code=718-7"), any())).thenReturn(tokens);
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "code=718-7", "p")),
                new SearchParameterMap(), "Observation")).isEmpty();
        var denied = new TokenParam("V");
        denied.setModifier(TokenParamModifier.NOT);
        tokens = new SearchParameterMap("_security", denied);
        when(parser.translateMatchUrl(eq("code=718-7"), any())).thenReturn(tokens);
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "code=718-7", "p")),
                new SearchParameterMap(), "Observation")).hasSize(1);
        tokens.addOrList("_security", List.of(denied, denied));
        assertThat(compiler.compile(plan("Observation", new PcmReadGrant("Observation", "code=718-7", "p")),
                new SearchParameterMap(), "Observation")).isEmpty();
    }
}
