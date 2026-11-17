package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Cryptographic, HO, request, class, expiry, and Patient-binding coverage. */
class LocalJwtRequestContextVerifierTest {
    private static final Instant NOW = Instant.parse("2026-08-13T00:00:00Z");
    private RSAPublicKey publicKey;
    private RSAPrivateKey privateKey;

    @BeforeEach
    void createKey() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair pair = generator.generateKeyPair();
        publicKey = (RSAPublicKey) pair.getPublic();
        privateKey = (RSAPrivateKey) pair.getPrivate();
    }

    @Test
    void localSamplerContextRequiresExplicitSourcePolicyAndRejectsStrict() throws Exception {
        LocalJwtRequestContextVerifier verifier = verifier((system, value, request) -> { throw new AssertionError("sampler cannot resolve a clinical patient"); });
        verifier.setSimulationPolicy(() -> new PcmSimulationPolicy("test-policy", false, true));
        Map<String, Object> claims = new java.util.HashMap<>();
        claims.put("kind", "sandbox-patient-sample"); claims.put("scope", "system/Patient.s");
        claims.put("pcm_issuer", "https://pcm2mtest.health.gov.il/api/fhir-service/r4"); claims.put("scenario", "sandbox-patient-sample");
        claims.put("contract_identifier", Map.of("system", "http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id", "value", "SAMPLING-POLICY"));
        claims.put("healthcare_service_identifier", Map.of("system", "http://pcm.fhir.health.gov.il/identifier/pcm-system-healthcareservice-id", "value", "SAMPLING-SERVICE"));
        claims.put("request_binding", Map.of("method", "GET", "uri", "/fhir/Patient?identifier=x"));
        String signed = token(claims);
        SystemRequestDetails enabled = request("GET", "/fhir/Patient?identifier=x", "Patient"); enabled.addHeader("Authorization", "Bearer " + signed);
        assertThat(verifier.verify(enabled).kind()).isEqualTo(PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE);
        verifier.setSimulationPolicy(() -> new PcmSimulationPolicy("test-policy", true, false));
        SystemRequestDetails strict = request("GET", "/fhir/Patient?identifier=x", "Patient"); strict.addHeader("Authorization", "Bearer " + signed);
        assertThatThrownBy(() -> verifier.verify(strict)).isInstanceOf(SecurityException.class);
    }

    @Test
    void mountedPolicyReloadRejectsStaleContextsAndPreservesSourceIsolation() throws Exception {
        java.nio.file.Path config = java.nio.file.Files.createTempFile("pcm-policy-", ".json");
        try {
            java.nio.file.Files.writeString(config, policyConfig("connectathon-balanced", 1));
            LocalJwtRequestContextVerifier verifier = verifier((system, value, request) -> "local-patient");
            verifier.setSimulationPolicy(() -> PcmSimulationPolicy.load(config, "ho-a"));
            String firstStamp = PcmSimulationPolicy.load(config, "ho-a").stamp();
            String firstToken = token(Map.of("policy_stamp", firstStamp));
            SystemRequestDetails first = request("GET", "/fhir/Observation?status=final", "Observation");
            first.addHeader("Authorization", "Bearer " + firstToken);
            assertThat(verifier.verify(first).healthOrganization()).isEqualTo("ho-a");
            java.nio.file.Files.writeString(config, policyConfig("strict", 2));
            SystemRequestDetails stale = request("GET", "/fhir/Observation?status=final", "Observation");
            stale.addHeader("Authorization", "Bearer " + firstToken);
            assertThatThrownBy(() -> verifier.verify(stale)).isInstanceOf(SecurityException.class);
            String updatedStamp = PcmSimulationPolicy.load(config, "ho-a").stamp();
            assertThat(updatedStamp).isNotEqualTo(firstStamp).isNotEqualTo(PcmSimulationPolicy.load(config, "ho-b").stamp());
            SystemRequestDetails updated = request("GET", "/fhir/Observation?status=final", "Observation");
            updated.addHeader("Authorization", "Bearer " + token(Map.of("policy_stamp", updatedStamp)));
            assertThat(verifier.verify(updated).healthOrganization()).isEqualTo("ho-a");
        } finally { java.nio.file.Files.deleteIfExists(config); }
    }

    @Test
    void verifiesClosedRequestBoundTokenAndResolvesPatientExactly() throws Exception {
        LocalJwtRequestContextVerifier verifier = verifier((system, value, request) -> {
            assertThat(system).isEqualTo("http://example.test/mrn");
            assertThat(value).isEqualTo("123");
            return "local-patient";
        });
        SystemRequestDetails request = request("GET", "/fhir/Observation?status=final", "Observation");
        request.addHeader("Authorization", "Bearer " + token(Map.of()));

        PcmRequestContext context = verifier.verify(request);

        assertThat(context.healthOrganization()).isEqualTo("ho-a");
        assertThat(context.targetPatientId()).isEqualTo("local-patient");
        assertThat(context.readGrants()).singleElement().satisfies(grant -> {
            assertThat(grant.patientId()).isEqualTo("local-patient");
            assertThat(grant.filter()).isEqualTo("status=final");
        });
    }

    @Test
    void failsClosedForCrossHoAudienceExpiryClassBindingAndUnknownClaims() throws Exception {
        List<Map<String, Object>> overrides = List.of(
                Map.<String, Object>of("aud", "urn:ho-b:fhir"), Map.<String, Object>of("ho_id", "ho-b"),
                Map.<String, Object>of("exp", Date.from(NOW)), Map.<String, Object>of("kind", "online-presence"),
                Map.<String, Object>of("unexpected", "value"), Map.<String, Object>of("policy_stamp", "old-policy"));
        for (Map<String, Object> override : overrides) {
            SystemRequestDetails request = request("GET", "/fhir/Observation?status=final", "Observation");
            request.addHeader("Authorization", "Bearer " + token(override));
            assertThatThrownBy(() -> verifier((s, v, r) -> "patient").verify(request))
                    .as(override.toString()).isInstanceOf(SecurityException.class);
        }
        SystemRequestDetails replay = request("GET", "/fhir/Observation/other", "Observation/other");
        replay.addHeader("Authorization", "Bearer " + token(Map.of()));
        assertThatThrownBy(() -> verifier((s, v, r) -> "patient").verify(replay))
                .isInstanceOf(SecurityException.class);

        SystemRequestDetails normalized = request("GET", "/fhir/?_getpages=opaque&_getpagesoffset=1", "");
        normalized.setRestOperationType(RestOperationTypeEnum.GET_PAGE);
        normalized.addHeader("Authorization", "Bearer " + token(Map.of(
                "request_binding", Map.of(
                        "method", "GET", "uri", "/fhir/?_getpages=opaque&_getpagesoffset=1"))));
        assertThat(verifier((s, v, r) -> "patient").verify(normalized).readGrants()).isNotEmpty();
    }

    @Test
    void zeroOrAmbiguousPatientResolutionIsNeverApproximated() throws Exception {
        for (PatientIdentifierResolver resolver : List.<PatientIdentifierResolver>of(
                (s, v, r) -> { throw new SecurityException("zero"); },
                (s, v, r) -> { throw new SecurityException("ambiguous"); })) {
            SystemRequestDetails request = request("GET", "/fhir/Observation?status=final", "Observation");
            request.addHeader("Authorization", "Bearer " + token(Map.of()));
            assertThatThrownBy(() -> verifier(resolver).verify(request)).isInstanceOf(SecurityException.class);
        }
    }

    @Test
    void acceptsOnlyExactlyBoundNativePagingRequestsAtTheFhirBase() throws Exception {
        SystemRequestDetails request = request("GET", "/fhir?_getpages=opaque&_getpagesoffset=1", "");
        request.setRestOperationType(RestOperationTypeEnum.GET_PAGE);
        request.addHeader("Authorization", "Bearer " + token(Map.of(
                "request_binding", Map.of(
                        "method", "GET", "uri", "/fhir?_getpages=opaque&_getpagesoffset=1"))));

        assertThat(verifier((s, v, r) -> "patient").verify(request).readGrants()).isNotEmpty();

        SystemRequestDetails replay = request("GET", "/fhir?_getpages=other", "");
        replay.setRestOperationType(RestOperationTypeEnum.GET_PAGE);
        replay.addHeader("Authorization", "Bearer " + token(Map.of(
                "request_binding", Map.of(
                        "method", "GET", "uri", "/fhir?_getpages=opaque&_getpagesoffset=1"))));
        assertThatThrownBy(() -> verifier((s, v, r) -> "patient").verify(replay))
                .isInstanceOf(SecurityException.class);
    }

    @Test
    void acceptsClosedOnlineAndBatchPresenceClassesAndRejectsSetMismatch() throws Exception {
        String system = "http://fhir.health.gov.il/identifier/il-hdp-test-id";
        String onlineScope = "system/Patient.s?identifier=" + system + "|1&" + PcmWorkflowPolicy.DEMOGRAPHICS;
        SystemRequestDetails online = request("GET", "/fhir/Patient?identifier=x", "Patient");
        online.addHeader("Authorization", "Bearer " + token(Map.of(
                "kind", "online-presence", "scope", onlineScope,
                "presence_identifiers", List.of(Map.of("system", system, "value", "1")),
                "request_binding", Map.of("method", "GET", "uri", "/fhir/Patient?identifier=x"))));
        assertThat(verifier((s, v, r) -> { throw new AssertionError("presence must not clinical-resolve"); })
                .verify(online).kind()).isEqualTo(PcmRequestContext.Kind.ONLINE_PRESENCE);

        String batchScope = onlineScope.replace("&" + PcmWorkflowPolicy.DEMOGRAPHICS, "," + system + "|2&" + PcmWorkflowPolicy.DEMOGRAPHICS);
        SystemRequestDetails batch = request("POST", "/fhir", "");
        batch.setRestOperationType(RestOperationTypeEnum.TRANSACTION);
        Map<String, Object> batchClaims = new java.util.HashMap<>();
        batchClaims.put("kind", "batch-presence");
        batchClaims.put("scope", batchScope);
        batchClaims.put("patient_identifier", null);
        batchClaims.put("presence_identifiers", List.of(
                Map.of("system", system, "value", "1"),
                Map.of("system", system, "value", "2")));
        batchClaims.put("request_binding", Map.of("method", "POST", "uri", "/fhir"));
        batch.addHeader("Authorization", "Bearer " + token(batchClaims));
        assertThat(verifier((s, v, r) -> "unused").verify(batch).presenceIdentifiers()).hasSize(2);

        SystemRequestDetails mismatch = request("GET", "/fhir/Patient?identifier=x", "Patient");
        mismatch.addHeader("Authorization", "Bearer " + token(Map.of(
                "kind", "online-presence", "scope", onlineScope,
                "presence_identifiers", List.of(Map.of("system", system, "value", "2")),
                "request_binding", Map.of("method", "GET", "uri", "/fhir/Patient?identifier=x"))));
        assertThatThrownBy(() -> verifier((s, v, r) -> "unused").verify(mismatch))
                .isInstanceOf(SecurityException.class);
    }

    @Test
    void rejectsRetiredUnfilteredContextEvenWithFormerPermissivePolicy() throws Exception {
        Map<String, Object> claims = new java.util.HashMap<>();
        claims.put("kind", "unfiltered-simulation");
        claims.put("scope", "system/*.*");
        claims.put("patient_identifier", null);
        SystemRequestDetails request = request("GET", "/fhir/Observation?status=final", "Observation");
        request.addHeader("Authorization", "Bearer " + token(claims));

        LocalJwtRequestContextVerifier openVerifier = verifier((s, v, r) -> {
            throw new AssertionError("open synthetic simulation must not resolve a Patient");
        });
        openVerifier.setSimulationPolicy(() -> new PcmSimulationPolicy("test-policy", false, false, true, true, true));
        assertThatThrownBy(() -> openVerifier.verify(request)).isInstanceOf(SecurityException.class);
        assertThatThrownBy(() -> new PcmRequestContext("ho-a", "subject", List.of(),
                PcmRequestContext.Kind.UNFILTERED_SIMULATION, null, List.of(), null, false))
                .isInstanceOf(IllegalArgumentException.class);

        SystemRequestDetails replay = request("GET", "/fhir/Patient", "Patient");
        replay.addHeader("Authorization", request.getHeader("Authorization"));
        assertThatThrownBy(() -> verifier((s, v, r) -> "unused").verify(replay))
                .isInstanceOf(SecurityException.class);
    }

    @Test
    void authenticatesOnePatientButDiscoveryCarriesOnlyTheRepresentative() throws Exception {
        Map<String, String> identity = Map.of("system", "http://fhir.health.gov.il/identifier/il-national-id", "value", "000000018");
        String tokenValue = identity.get("system") + "|" + identity.get("value");
        SystemRequestDetails auth = request("GET", "/fhir/Patient?identifier=x", "Patient");
        auth.addHeader("Authorization", "Bearer " + token(Map.of(
                "kind", "patient-authentication", "patient_identifier", identity,
                "scope", "patient/Patient.s?" + PcmWorkflowPolicy.DEMOGRAPHICS,
                "request_binding", Map.of("method", "GET", "uri", "/fhir/Patient?identifier=x"))));
        assertThat(verifier((s, v, r) -> "one").verify(auth).patientIdentifier().token()).isEqualTo(tokenValue);
        SystemRequestDetails discovery = request("GET", "/fhir/Patient?x=y", "Patient");
        discovery.addHeader("Authorization", "Bearer " + token(Map.of(
                "kind", "dependent-discovery", "representative_identifier", identity,
                "scope", "system/Patient.s?_has:RelatedPerson:patient:identifier=" + tokenValue + "&" + PcmWorkflowPolicy.DEMOGRAPHICS
                        + " system/RelatedPerson.s?identifier=" + tokenValue + "&" + PcmWorkflowPolicy.DEMOGRAPHICS + "&" + PcmWorkflowPolicy.DISCOVERY_TAG,
                "request_binding", Map.of("method", "GET", "uri", "/fhir/Patient?x=y"))));
        PcmRequestContext context = verifier((s, v, r) -> { throw new AssertionError("discovery cannot resolve a Patient compartment"); }).verify(discovery);
        assertThat(context.patientIdentifier()).isNull();
        assertThat(context.representativeIdentifier().token()).isEqualTo(tokenValue);
        assertThat(context.readGrants()).hasSize(2);
    }

    @Test
    void operationRejectsRetiredSimulationWithAnyQuery() throws Exception {
        String uri = "/fhir/Patient/$everything?_type=Observation&_count=1";
        var claims = new java.util.HashMap<String, Object>();
        claims.put("kind", "unfiltered-simulation"); claims.put("scope", "system/*.*");
        claims.put("scenario", "consent-access");
        claims.put("request_binding", Map.of("method", "GET", "uri", uri));
        String signed = token(claims);
        for (String actualQuery : List.of("_type=Observation&_count=1", "_type=Patient&_count=1")) {
            var input = org.mockito.Mockito.mock(jakarta.servlet.http.HttpServletRequest.class);
            org.mockito.Mockito.when(input.getHeader("Authorization")).thenReturn("Bearer " + signed);
            org.mockito.Mockito.when(input.getHeader("X-PCM-Request-Method")).thenReturn("GET");
            org.mockito.Mockito.when(input.getHeader("X-PCM-Request-URI")).thenReturn(uri);
            org.mockito.Mockito.when(input.getQueryString()).thenReturn(actualQuery);
            var request = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails();
            request.setServletRequest(input); request.setRequestType(RequestTypeEnum.GET);
            request.setRequestPath("Patient/$everything");
            var verifier = verifier((system, value, original) -> "local-patient");
            verifier.setSimulationPolicy(() -> new PcmSimulationPolicy("test-policy", false, false, true, true, true));
            assertThatThrownBy(() -> verifier.verify(request)).isInstanceOf(SecurityException.class);
        }
    }

    @Test
    void rejectsOldSchemasMixedPrefixesAndPatientIdentityDisagreements() throws Exception {
        for (Map<String, Object> override : List.of(
                Map.<String, Object>of("schema", "pcm-ds-local-token/4"),
                Map.<String, Object>of("authorization_schema", "pcm-ds-authorization-context/3"),
                Map.<String, Object>of("scope", "patient/Observation.s system/Patient.s"),
                Map.<String, Object>of("scope", "patient/Patient.s?identifier=http://example.test/mrn|other"),
                Map.<String, Object>of("patient", "Patient/contradiction"))) {
            var request = request("GET", "/fhir/Observation?status=final", "Observation");
            request.addHeader("Authorization", "Bearer " + token(override));
            assertThatThrownBy(() -> verifier((system, value, original) -> "local").verify(request)).isInstanceOf(SecurityException.class);
        }
    }

    @Test
    void presenceAboveOneHundredUsesCurrentSourceLimitAndExactContractIdentity() throws Exception {
        var identities = java.util.stream.IntStream.range(0, 105)
                .mapToObj(index -> Map.of("system", "http://example.test/id", "value", Integer.toString(index))).toList();
        String scope = "system/Patient.s?identifier=" + identities.stream().map(id -> id.get("system") + "|" + id.get("value"))
                .collect(java.util.stream.Collectors.joining(",")) + "&" + PcmWorkflowPolicy.DEMOGRAPHICS;
        var overrides = new java.util.HashMap<String, Object>();
        overrides.put("kind", "batch-presence"); overrides.put("scope", scope); overrides.put("presence_identifiers", identities);
        overrides.put("request_binding", Map.of("method", "POST", "uri", "/fhir"));
        var verifier = verifier((system, value, request) -> { throw new AssertionError("system scope must never resolve Patient"); });
        verifier.setPresenceMaximum(() -> 105);
        var accepted = request("POST", "/fhir", ""); accepted.setRestOperationType(RestOperationTypeEnum.TRANSACTION);
        accepted.addHeader("Authorization", "Bearer " + token(overrides));
        assertThat(verifier.verify(accepted).presenceIdentifiers()).hasSize(105);
        verifier.setPresenceMaximum(() -> 100);
        var limited = request("POST", "/fhir", ""); limited.setRestOperationType(RestOperationTypeEnum.TRANSACTION);
        limited.addHeader("Authorization", accepted.getHeader("Authorization"));
        assertThatThrownBy(() -> verifier.verify(limited)).isInstanceOf(SecurityException.class);
        verifier.setPresenceMaximum(() -> 105);
        overrides.put("contract_identifier", Map.of("system", "http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id", "value", "wrong"));
        var wrong = request("POST", "/fhir", ""); wrong.setRestOperationType(RestOperationTypeEnum.TRANSACTION);
        wrong.addHeader("Authorization", "Bearer " + token(overrides));
        assertThatThrownBy(() -> verifier.verify(wrong)).isInstanceOf(SecurityException.class);
    }

    @Test
    void syntheticWorkflowRequiresExactExplicitFixtureEnrollmentForBothScenarios() throws Exception {
        String system = "http://fhir.health.gov.il/identifier/il-hdp-test-id";
        for (String value : List.of("1", "2")) for (String scenario : List.of("patient-authentication", "dependent-discovery")) {
            var identity = new PcmPatientIdentifier(system, value);
            String scope = scenario.equals("patient-authentication") ? "patient/Patient.s?" + PcmWorkflowPolicy.DEMOGRAPHICS
                    : "system/Patient.s?_has:RelatedPerson:patient:identifier=" + identity.token() + "&" + PcmWorkflowPolicy.DEMOGRAPHICS
                        + " system/RelatedPerson.s?identifier=" + identity.token() + "&" + PcmWorkflowPolicy.DEMOGRAPHICS + "&" + PcmWorkflowPolicy.DISCOVERY_TAG;
            var claims = Map.<String, Object>of("kind", scenario, "scope", scope,
                    scenario.equals("patient-authentication") ? "patient_identifier" : "representative_identifier", Map.of("system", system, "value", value),
                    "request_binding", Map.of("method", "GET", "uri", "/fhir/Patient?fixture=1"));
            String signed = token(claims);
            var verifier = verifier((s, v, r) -> "fixture-patient");
            var denied = request("GET", "/fhir/Patient?fixture=1", "Patient"); denied.addHeader("Authorization", "Bearer " + signed);
            assertThatThrownBy(() -> verifier.verify(denied)).isInstanceOf(SecurityException.class);
            verifier.setSyntheticWorkflowFixtures(() -> java.util.Set.of(new PcmPatientIdentifier(system, value.equals("1") ? "2" : "1")));
            var wrong = request("GET", "/fhir/Patient?fixture=1", "Patient"); wrong.addHeader("Authorization", "Bearer " + signed);
            assertThatThrownBy(() -> verifier.verify(wrong)).isInstanceOf(SecurityException.class);
            verifier.setSyntheticWorkflowFixtures(() -> java.util.Set.of(identity));
            var accepted = request("GET", "/fhir/Patient?fixture=1", "Patient"); accepted.addHeader("Authorization", "Bearer " + signed);
            assertThat(verifier.verify(accepted).kind()).isEqualTo(scenario.equals("patient-authentication")
                    ? PcmRequestContext.Kind.PATIENT_AUTHENTICATION : PcmRequestContext.Kind.DEPENDENT_DISCOVERY);
            verifier.setSyntheticWorkflowFixtures(java.util.Set::of);
            var removed = request("GET", "/fhir/Patient?fixture=1", "Patient"); removed.addHeader("Authorization", "Bearer " + signed);
            assertThatThrownBy(() -> verifier.verify(removed)).isInstanceOf(SecurityException.class);
        }
    }

    /** Minimal native policy envelope; the complete schema is independently checked by Node. */
    private static String policyConfig(String preset, int revision) {
        return "{\"configVersion\":\"pcm-team-config/5\",\"conformance\":{\"mode\":\""
                + (preset.equals("strict") ? "strict" : "connectathon") + "\",\"policyVersion\":\"pcm-sandbox-policy/4\",\"preset\":\"" + preset
                + "\"},\"security\":{\"dsFhirServer\":{\"enforceMappedPatients\":true}},\"runtime\":{\"revision\":" + revision + "}}";
    }

    @Test
    void everyPresetRequiresNativeFilteringAndRejectsRetiredOverrides() throws Exception {
        var file = java.nio.file.Files.createTempFile("pcm-invariant-", ".json");
        try {
            var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
            for (String preset : List.of("connectathon-easy", "connectathon-balanced", "connectathon-mtls", "strict")) {
                String baseline = policyConfig(preset, 1);
                java.nio.file.Files.writeString(file, baseline);
                assertThat(PcmSimulationPolicy.load(file, "ho-a").nativeFiltering()).isTrue();
                assertThat(PcmSimulationPolicy.load(file, "ho-a").anonymousSimulation()).isFalse();
                for (String key : List.of("oauthBearer", "tokenResourceBinding", "tokenAudience", "tokenExpiry", "consentState", "serviceState", "patientIdentifier", "patientMapping", "smartScopes", "smartInteractions", "smartQueryFilters", "informationBucket", "sensitivityLabels", "history", "references", "includes", "paging", "resultFiltering", "presenceAuthorization")) {
                    for (boolean local : List.of(false, true)) {
                        var config = (com.fasterxml.jackson.databind.node.ObjectNode) mapper.readTree(baseline);
                        var controls = config.putObject("securitySimulation");
                        (local ? controls.putObject("perSource").putObject("ho-a") : controls.putObject("global")).put(key, false);
                        java.nio.file.Files.writeString(file, mapper.writeValueAsString(config));
                        assertThatThrownBy(() -> PcmSimulationPolicy.load(file, "ho-a")).isInstanceOf(SecurityException.class);
                    }
                }
            }
            java.nio.file.Files.writeString(file, policyConfig("connectathon-easy", 1).replace("pcm-team-config/5", "pcm-team-config/4"));
            assertThatThrownBy(() -> PcmSimulationPolicy.load(file, "ho-a")).isInstanceOf(SecurityException.class);
        } finally { java.nio.file.Files.deleteIfExists(file); }
    }

    private LocalJwtRequestContextVerifier verifier(PatientIdentifierResolver resolver) {
        return new LocalJwtRequestContextVerifier("https://adapter/ho-a", "urn:ho-a:fhir", "ho-a",
                publicKey, resolver, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private SystemRequestDetails request(String method, String uri, String path) {
        SystemRequestDetails request = new SystemRequestDetails();
        request.setRequestType(RequestTypeEnum.valueOf(method));
        request.setRequestPath(path);
        request.addHeader("X-PCM-Request-Method", method);
        request.addHeader("X-PCM-Request-URI", uri);
        return request;
    }

    @Test
    void simulationEvidenceRequiresExactCurrentPolicyAndDoesNotInventCertificates() throws Exception {
        for (List<String> skipped : List.of(List.of("token-endpoint-mtls"), List.of("client-assertion-signature"),
                List.of("token-endpoint-mtls", "client-assertion-signature"))) {
            Map<String, Object> evidence = new java.util.HashMap<>();
            evidence.put("correlationVerified", false);
            evidence.put("tokenEndpointMtlsThumbprint", skipped.contains("token-endpoint-mtls") ? null : "A".repeat(43));
            evidence.put("clientAssertionSigningThumbprint", skipped.contains("client-assertion-signature") ? null : "B".repeat(43));
            evidence.put("simulation", Map.of("version", "pcm-authentication-simulation/1", "skipped", skipped));
            LocalJwtRequestContextVerifier relaxed = verifier((system, value, request) -> "patient-local");
            relaxed.setSimulationPolicy(() -> new PcmSimulationPolicy("test-policy", true, false, true, true, false));
            SystemRequestDetails accepted = request("GET", "/fhir/Observation?status=final", "Observation");
            accepted.addHeader("Authorization", "Bearer " + token(Map.of("authentication", evidence)));
            assertThat(relaxed.verify(accepted)).isNotNull();
            SystemRequestDetails strict = request("GET", "/fhir/Observation?status=final", "Observation");
            strict.addHeader("Authorization", accepted.getHeader("Authorization"));
            assertThatThrownBy(() -> verifier((system, value, request) -> "patient-local").verify(strict)).isInstanceOf(SecurityException.class);
            evidence.put(skipped.contains("token-endpoint-mtls") ? "tokenEndpointMtlsThumbprint" : "clientAssertionSigningThumbprint", "C".repeat(43));
            SystemRequestDetails invented = request("GET", "/fhir/Observation?status=final", "Observation");
            invented.addHeader("Authorization", "Bearer " + token(Map.of("authentication", evidence)));
            assertThatThrownBy(() -> relaxed.verify(invented)).isInstanceOf(SecurityException.class);
        }
    }

    @Test
    void formSearchRetainsExactPostBindingAndRejectsMethodUriOperationReplay() throws Exception {
        String uri = "/fhir/Observation/_search?status=final";
        String signed = token(Map.of("request_binding", Map.of("method", "POST", "uri", uri)));
        var accepted = request("POST", uri, "Observation/_search");
        accepted.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
        accepted.addHeader("Authorization", "Bearer " + signed);
        assertThat(verifier((s, v, r) -> "p").verify(accepted).readGrants()).isNotEmpty();
        for (var rejected : List.of(request("GET", uri, "Observation/_search"),
                request("POST", "/fhir/Observation/_search?status=preliminary", "Observation/_search"),
                request("POST", uri, "Observation"))) {
            rejected.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
            rejected.addHeader("Authorization", "Bearer " + signed);
            assertThatThrownBy(() -> verifier((s, v, r) -> "p").verify(rejected)).isInstanceOf(SecurityException.class);
        }
        var create = request("POST", "/fhir/Observation", "Observation");
        create.setRestOperationType(RestOperationTypeEnum.CREATE);
        create.addHeader("Authorization", "Bearer " + token(Map.of("request_binding", Map.of("method", "POST", "uri", "/fhir/Observation"))));
        assertThatThrownBy(() -> verifier((s, v, r) -> "p").verify(create)).isInstanceOf(SecurityException.class);
    }

    @Test
    void postSearchComparesTheActualServletQueryWithTheSignedUntouchedQuery() throws Exception {
        String uri = "/fhir/Observation/_search?status=final&code=a%7Cb&code=c%7Cd";
        String signed = token(Map.of("request_binding", Map.of("method", "POST", "uri", uri)));
        for (String query : List.of(uri.substring(uri.indexOf('?') + 1), "status=final", "status=preliminary&code=a%7Cb&code=c%7Cd")) {
            var input = org.mockito.Mockito.mock(jakarta.servlet.http.HttpServletRequest.class);
            org.mockito.Mockito.when(input.getHeader("Authorization")).thenReturn("Bearer " + signed);
            org.mockito.Mockito.when(input.getHeader("X-PCM-Request-Method")).thenReturn("POST");
            org.mockito.Mockito.when(input.getHeader("X-PCM-Request-URI")).thenReturn(uri);
            org.mockito.Mockito.when(input.getQueryString()).thenReturn(query);
            var request = new ca.uhn.fhir.rest.server.servlet.ServletRequestDetails(); request.setServletRequest(input);
            request.setRequestType(RequestTypeEnum.POST); request.setRestOperationType(RestOperationTypeEnum.SEARCH_TYPE);
            request.setResourceName("Observation"); request.setRequestPath("Observation/_search");
            if (query.equals(uri.substring(uri.indexOf('?') + 1))) assertThat(verifier((s, v, r) -> "p").verify(request)).isNotNull();
            else assertThatThrownBy(() -> verifier((s, v, r) -> "p").verify(request)).isInstanceOf(SecurityException.class);
        }
    }

    private String token(Map<String, Object> overrides) throws Exception {
        String kid = "local-jwt-" + Base64.getUrlEncoder().withoutPadding().encodeToString(
                MessageDigest.getInstance("SHA-256").digest(publicKey.getEncoded())).substring(0, 16);
        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer("https://adapter/ho-a").audience("urn:ho-a:fhir")
                .issueTime(Date.from(NOW)).expirationTime(Date.from(NOW.plusSeconds(30))).jwtID(UUID.randomUUID().toString())
                .subject("pcm-client-opaque-1234567890").claim("client_id", "pcm-client-opaque-1234567890")
                .claim("policy_stamp", "test-policy").claim("schema", "pcm-ds-local-token/5").claim("authorization_schema", "pcm-ds-authorization-context/4")
                .claim("ho_id", "ho-a").claim("kind", "data-source-access")
                .claim("scope", "patient/Observation.rs?status=final")
                .claim("pcm_issuer", "https://pcm").claim("pcm_audience", "https://ho-a/fhir")
                .claim("pcm_expires_at", NOW.plusSeconds(60).getEpochSecond())
                .claim("authentication", Map.of("correlationVerified", true, "tokenEndpointMtlsThumbprint", "A".repeat(43), "clientAssertionSigningThumbprint", "B".repeat(43)))
                .claim("patient_identifier", Map.of("system", "http://example.test/mrn", "value", "123"))
                .claim("request_binding", Map.of("method", "GET", "uri", "/fhir/Observation?status=final"));
        String kind = (String) overrides.getOrDefault("kind", "data-source-access");
        if (kind.equals("unfiltered-simulation")) claims.claim("authentication", Map.of("correlationVerified", false, "simulation", "anonymous-source"));
        if (kind.equals("data-source-access")) {
            claims.claim("scenario", "consent-access")
                    .claim("consent_identifier", Map.of("system", "urn:consent", "value", "one"))
                    .claim("healthcare_service_identifier", Map.of("system", "urn:service", "value", "one"))
                    .claim("organization", Map.of("system", "urn:organization", "value", "one"));
        } else if (!kind.equals("unfiltered-simulation")) {
            String scenario = kind.endsWith("presence") ? "presence-check" : kind;
            claims.claim("patient_identifier", null).claim("scenario", scenario)
                    .claim("contract_identifier", Map.of("system", "http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id", "value", PcmWorkflowPolicy.DEFAULTS.getOrDefault(scenario, scenario)));
        }
        overrides.forEach(claims::claim);
        SignedJWT token = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
                .type(JOSEObjectType.JWT).keyID(kid).build(), claims.build());
        token.sign(new RSASSASigner(privateKey));
        return token.serialize();
    }
}
