package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Verifies the adapter's closed, short-lived, request-bound RS256 JWT. */
public final class LocalJwtRequestContextVerifier implements SignedRequestContextVerifier {
    static final String CONTEXT_ATTRIBUTE = LocalJwtRequestContextVerifier.class.getName() + ".context";
    private static final Set<String> REQUIRED_CLAIMS = Set.of(
            "iss", "aud", "iat", "exp", "jti", "schema", "authorization_schema", "ho_id", "kind",
            "sub", "client_id", "scope", "pcm_issuer", "pcm_audience", "pcm_expires_at",
            "authentication", "request_binding", "policy_stamp");
    private static final Set<String> OPTIONAL_CLAIMS = Set.of(
            "organization", "patient_identifier", "consent_identifier",
            "healthcare_service_identifier", "presence_identifiers", "contract_identifier", "representative_identifier", "scenario");

    private final String issuer;
    private final String audience;
    private final String healthOrganization;
    private final PatientIdentifierResolver patientResolver;
    private final Clock clock;
    private final RSAPublicKey publicKey;
    private final String keyId;
    private java.util.function.Supplier<Map<String, String>> workflowIdentities = () -> PcmWorkflowPolicy.DEFAULTS;
    private java.util.function.Supplier<Set<PcmPatientIdentifier>> syntheticWorkflowFixtures = Set::of;
    private java.util.function.IntSupplier presenceMaximum = () -> 100;
    private java.util.function.Supplier<PcmSimulationPolicy> simulationPolicy = () -> new PcmSimulationPolicy("test-policy", true);

    public LocalJwtRequestContextVerifier(
            String issuer,
            String audience,
            String healthOrganization,
            Path certificate,
            PatientIdentifierResolver patientResolver) {
        this(issuer, audience, healthOrganization, readPublicKey(certificate), patientResolver, Clock.systemUTC());
        this.workflowIdentities = () -> PcmWorkflowPolicy.load(
                Path.of(System.getenv().getOrDefault("TEAM_CONFIG_PATH", "/runtime/team-config.json")));
        this.syntheticWorkflowFixtures = () -> PcmWorkflowPolicy.syntheticFixtures(
                Path.of(System.getenv().getOrDefault("TEAM_CONFIG_PATH", "/runtime/team-config.json")));
        this.presenceMaximum = () -> PcmPresenceLimitLoader.load(
                Path.of(System.getenv().getOrDefault("TEAM_CONFIG_PATH", "/runtime/team-config.json")), new com.fasterxml.jackson.databind.ObjectMapper(), healthOrganization).maxPatients();
        this.simulationPolicy = () -> PcmSimulationPolicy.load(
                Path.of(System.getenv().getOrDefault("TEAM_CONFIG_PATH", "/runtime/team-config.json")), healthOrganization);
    }

    LocalJwtRequestContextVerifier(
            String issuer,
            String audience,
            String healthOrganization,
            RSAPublicKey publicKey,
            PatientIdentifierResolver patientResolver,
            Clock clock) {
        this.issuer = requireValue(issuer);
        this.audience = requireValue(audience);
        this.healthOrganization = requireValue(healthOrganization);
        this.publicKey = publicKey;
        this.patientResolver = patientResolver;
        this.clock = clock;
        this.keyId = keyId(publicKey);
    }

    /** Test seam for an explicit current source policy. */
    void setSimulationPolicy(java.util.function.Supplier<PcmSimulationPolicy> policy) { this.simulationPolicy = policy; }

    /** Test seam for selected-source finite presence limits. */
    void setPresenceMaximum(java.util.function.IntSupplier maximum) { this.presenceMaximum = maximum; }

    /** Test seam for current configured Contract identities. */
    void setWorkflowIdentities(java.util.function.Supplier<Map<String, String>> identities) { this.workflowIdentities = identities; }

    /** Test seam for explicit local fixture enrollment; defaults reject every synthetic workflow identity. */
    void setSyntheticWorkflowFixtures(java.util.function.Supplier<Set<PcmPatientIdentifier>> fixtures) { this.syntheticWorkflowFixtures = fixtures; }

    static final String FILTERING_ATTRIBUTE = LocalJwtRequestContextVerifier.class.getName() + ".filtering";

    @Override
    public PcmRequestContext verify(RequestDetails requestDetails) {
        Object cached = requestDetails.getUserData().get(CONTEXT_ATTRIBUTE);
        if (cached instanceof PcmRequestContext context) return context;
        try {
            String authorization = requestDetails.getHeader("Authorization");
            if (authorization == null || !authorization.startsWith("Bearer ")
                    || authorization.length() <= 7 || authorization.substring(7).contains(" ")) {
                throw new PcmContextException("CONTEXT_MISSING", "Missing adapter JWT");
            }
            SignedJWT token = SignedJWT.parse(authorization.substring(7));
            if (!JWSAlgorithm.RS256.equals(token.getHeader().getAlgorithm())
                    || !JOSEObjectType.JWT.equals(token.getHeader().getType())
                    || !keyId.equals(token.getHeader().getKeyID())
                    || !token.verify(new RSASSAVerifier(publicKey))) {
                throw new PcmContextException("CONTEXT_SIGNATURE_INVALID", "Adapter JWT signature is invalid");
            }
            JWTClaimsSet claims = token.getJWTClaimsSet();
            validateClaims(claims, requestDetails);
            String kind = claims.getStringClaim("kind");
            PcmRequestContext context = switch (kind) {
                case "sandbox-patient-sample" -> samplerContext(claims);
                case "data-source-access" -> clinicalContext(claims, requestDetails);
                case "online-presence" -> onlinePresenceContext(claims);
                case "batch-presence" -> batchPresenceContext(claims);
                case "patient-authentication" -> authenticationContext(claims, requestDetails);
                case "dependent-discovery" -> discoveryContext(claims);
                default -> throw new SecurityException("Adapter JWT token class is invalid");
            };
            requestDetails.getUserData().put(FILTERING_ATTRIBUTE, true);
            requestDetails.getUserData().put(CONTEXT_ATTRIBUTE, context);
            requestDetails.getUserData().put(EXPIRY_ATTRIBUTE, claims.getExpirationTime().toInstant());
            requestDetails.getUserData().put(POLICY_ATTRIBUTE, claims.getStringClaim("policy_stamp"));
            java.util.Map<String,Object> observed = new java.util.LinkedHashMap<>();
            for (String key : java.util.List.of("iss", "aud", "pcm_issuer", "pcm_audience", "scenario", "contract_identifier", "healthcare_service_identifier", "authentication")) {
                if (claims.getClaim(key) != null) observed.put(key, claims.getClaim(key));
            }
            requestDetails.getUserData().put(OBSERVABILITY_ATTRIBUTE, observed);
            return context;
        } catch (SecurityException rejected) {
            throw rejected;
        } catch (Exception rejected) {
            throw new SecurityException("Adapter JWT is invalid", rejected);
        }
    }

    /** Verified deadline for bounded native search work; wire parameters cannot supply it. */
    static final String OBSERVABILITY_ATTRIBUTE = LocalJwtRequestContextVerifier.class.getName() + ".observability";
    static final String POLICY_ATTRIBUTE = LocalJwtRequestContextVerifier.class.getName() + ".policy";
    static final String EXPIRY_ATTRIBUTE = LocalJwtRequestContextVerifier.class.getName() + ".expiry";

    private void validateClaims(JWTClaimsSet claims, RequestDetails requestDetails) throws Exception {
        Set<String> names = claims.getClaims().keySet();
        if (!names.containsAll(REQUIRED_CLAIMS)
                || names.stream().anyMatch(name -> !REQUIRED_CLAIMS.contains(name) && !OPTIONAL_CLAIMS.contains(name))) {
            throw new PcmContextException("CONTEXT_SCHEMA_INVALID", "Adapter JWT schema is invalid");
        }
        PcmSimulationPolicy currentPolicy = simulationPolicy.get();
        requestDetails.getUserData().put(PcmQueryLimits.ATTRIBUTE, currentPolicy.queryLimits());
        if (!currentPolicy.stamp().equals(claims.getStringClaim("policy_stamp"))
                || "unfiltered-simulation".equals(claims.getStringClaim("kind"))) {
            throw new PcmContextException("CONTEXT_STALE", "Adapter JWT source policy is stale or incompatible");
        }
        Instant now = clock.instant();
        Date issuedAt = claims.getIssueTime();
        Date expiresAt = claims.getExpirationTime();
        if (!issuer.equals(claims.getIssuer())) throw new PcmContextException("INVALID_ISSUER", "Adapter JWT claims are invalid");
        if (!List.of(audience).equals(claims.getAudience())) throw new PcmContextException("INVALID_AUDIENCE", "Adapter JWT claims are invalid");
        if (!healthOrganization.equals(claims.getStringClaim("ho_id"))) throw new PcmContextException("INVALID_HO", "Adapter JWT claims are invalid");
        if (expiresAt != null && !expiresAt.toInstant().isAfter(now)) throw new PcmContextException("CONTEXT_EXPIRED", "Adapter JWT claims are invalid");
        if (!issuer.equals(claims.getIssuer()) || !List.of(audience).equals(claims.getAudience())
                || issuedAt == null || expiresAt == null
                || issuedAt.toInstant().isAfter(now.plusSeconds(2))
                || !expiresAt.toInstant().isAfter(now)
                || expiresAt.toInstant().isAfter(issuedAt.toInstant().plusSeconds(30))
                || claims.getJWTID() == null || claims.getJWTID().isBlank()
                || !"pcm-ds-local-token/5".equals(claims.getStringClaim("schema"))
                || !"pcm-ds-authorization-context/4".equals(claims.getStringClaim("authorization_schema"))
                || !healthOrganization.equals(claims.getStringClaim("ho_id"))
                || !claims.getSubject().equals(claims.getStringClaim("client_id"))
                || claims.getLongClaim("pcm_expires_at") < expiresAt.toInstant().getEpochSecond()) {
            throw new SecurityException("Adapter JWT claims are invalid");
        }
        Map<String, Object> binding = requiredMap(claims, "request_binding");
        requireExactKeys(binding, Set.of("method", "uri"));
        String method = requireValue(binding.get("method"));
        String uri = requireValue(binding.get("uri"));
        String forwardedMethod = requestDetails.getHeader("X-PCM-Request-Method");
        String forwardedUri = requestDetails.getHeader("X-PCM-Request-URI");
        String actualMethod = requestDetails.getRequestType() == null ? forwardedMethod : requestDetails.getRequestType().name();
        String actualPath = requestDetails.getRequestPath();
        String boundPath = uriPath(uri);
        String normalizedActualPath = actualPath == null || actualPath.isBlank()
                ? "/fhir"
                : "/fhir/" + actualPath.replaceFirst("^/+", "");
        boolean nativePage = (boundPath.equals("/fhir") || boundPath.equals("/fhir/"))
                && requestDetails.getRestOperationType() == RestOperationTypeEnum.GET_PAGE;
        boolean batchRoot = (boundPath.equals("/fhir") || boundPath.equals("/fhir/"))
                && normalizedActualPath.equals("/fhir")
                && requestDetails.getRestOperationType() == RestOperationTypeEnum.TRANSACTION;
        boolean postSearch = "POST".equals(method)
                && boundPath.matches("/fhir/[A-Z][A-Za-z0-9]{0,63}/_search")
                && requestDetails.getRestOperationType() == RestOperationTypeEnum.SEARCH_TYPE;
        if (!(Set.of("GET", "HEAD").contains(method) || "POST".equals(method) && batchRoot || postSearch)
                || !method.equals(forwardedMethod) || !method.equals(actualMethod) || !uri.equals(forwardedUri)
                || !(boundPath.equals("/fhir") || boundPath.startsWith("/fhir/"))
                || uri.contains("..") || uri.contains("#")
                || !(nativePage || batchRoot || boundPath.equals(normalizedActualPath))) {
            throw new PcmContextException("CONTEXT_BINDING_INVALID", "Adapter JWT request binding is invalid");
        }
        if ((boundPath.endsWith("/$everything") || nativePage || postSearch)
                && requestDetails instanceof ca.uhn.fhir.rest.server.servlet.ServletRequestDetails servlet) {
            String actualQuery = servlet.getServletRequest().getQueryString();
            int separator = uri.indexOf('?');
            String signedQuery = separator < 0 ? null : uri.substring(separator + 1);
            if (!java.util.Objects.equals(actualQuery, signedQuery)) throw new PcmContextException("CONTEXT_BINDING_INVALID", "Adapter JWT query binding is invalid");
        }
        Map<String, Object> authentication = requiredMap(claims, "authentication");
        validateAuthentication(authentication, claims.getStringClaim("kind"), currentPolicy);
    }

    /** Validate explicitly skipped evidence only against the current mounted source policy. */
    private void validateAuthentication(Map<String, Object> authentication, String kind, PcmSimulationPolicy policy) {
        if (Boolean.TRUE.equals(authentication.get("correlationVerified"))) {
            requireExactKeys(authentication, Set.of("tokenEndpointMtlsThumbprint", "clientAssertionSigningThumbprint", "correlationVerified"));
            for (String role : List.of("tokenEndpointMtlsThumbprint", "clientAssertionSigningThumbprint")) {
                if (!(authentication.get(role) instanceof String thumbprint) || !thumbprint.matches("[A-Za-z0-9_-]{43}")) {
                    throw new SecurityException("Verified authentication thumbprint is invalid");
                }
            }
            return;
        }
        requireExactKeys(authentication, Set.of("tokenEndpointMtlsThumbprint", "clientAssertionSigningThumbprint", "correlationVerified", "simulation"));
        if (!Boolean.FALSE.equals(authentication.get("correlationVerified")) || !(authentication.get("simulation") instanceof Map<?, ?> simulation)
                || !simulation.keySet().equals(Set.of("version", "skipped"))
                || !"pcm-authentication-simulation/1".equals(simulation.get("version"))
                || !(simulation.get("skipped") instanceof List<?> skipped) || skipped.isEmpty() || skipped.size() > 2
                || new java.util.HashSet<>(skipped).size() != skipped.size()
                || skipped.stream().anyMatch(check -> !Set.of("token-endpoint-mtls", "client-assertion-signature").contains(check))) {
            throw new SecurityException("Adapter authentication simulation is invalid");
        }
        for (String check : List.of("token-endpoint-mtls", "client-assertion-signature")) {
            String role = check.equals("token-endpoint-mtls") ? "tokenEndpointMtlsThumbprint" : "clientAssertionSigningThumbprint";
            if (skipped.contains(check)) {
                boolean permitted = check.equals("token-endpoint-mtls") ? policy.transportSimulation() : policy.signatureSimulation();
                if (!permitted || authentication.get(role) != null) throw new SecurityException("Skipped authentication check is not permitted");
            } else if (!(authentication.get(role) instanceof String thumbprint) || !thumbprint.matches("[A-Za-z0-9_-]{43}")) {
                throw new SecurityException("Observed authentication thumbprint is invalid");
            }
        }
    }

    /** Local sampling bypasses no query boundary, even in all-off easy simulation. */
    private PcmRequestContext samplerContext(JWTClaimsSet claims) throws Exception {
        if (!simulationPolicy.get().sandboxSampling()
                || !"sandbox-patient-sample".equals(claims.getStringClaim("scenario"))
                || !Set.of("https://pcm2m.health.gov.il/api/fhir-service/r4", "https://pcm2mtest.health.gov.il/api/fhir-service/r4").contains(claims.getStringClaim("pcm_issuer"))
                || !"system/Patient.s".equals(claims.getStringClaim("scope"))
                || claims.getClaim("patient_identifier") != null || claims.getClaim("consent_identifier") != null
                || claims.getClaim("presence_identifiers") != null || claims.getClaim("representative_identifier") != null || claims.getClaim("organization") != null) {
            throw new SecurityException("Local sampler context is invalid");
        }
        Map<String, Object> contract = requiredMap(claims, "contract_identifier");
        Map<String, Object> service = requiredMap(claims, "healthcare_service_identifier");
        requireExactKeys(contract, Set.of("system", "value"));
        requireExactKeys(service, Set.of("system", "value"));
        if (!"http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id".equals(identifier(contract).system())
                || !"http://pcm.fhir.health.gov.il/identifier/pcm-system-healthcareservice-id".equals(identifier(service).system())) {
            throw new SecurityException("Sampling Contract/service evidence is invalid");
        }
        return new PcmRequestContext(healthOrganization, claims.getSubject(), List.of(),
                PcmRequestContext.Kind.SANDBOX_PATIENT_SAMPLE, null, List.of(), null, false);
    }

    private PcmRequestContext clinicalContext(JWTClaimsSet claims, RequestDetails requestDetails) throws Exception {
        Map<String, Object> identifier = requiredMap(claims, "patient_identifier");
        requireExactKeys(identifier, Set.of("system", "value"));
        if (claims.getClaim("presence_identifiers") != null || claims.getClaim("contract_identifier") != null
                || claims.getClaim("representative_identifier") != null
                || !"consent-access".equals(claims.getStringClaim("scenario"))) throw new SecurityException("Clinical context is invalid");
        identifier(requiredMap(claims, "consent_identifier"));
        identifier(requiredMap(claims, "healthcare_service_identifier"));
        identifier(requiredMap(claims, "organization"));
        String patientId = patientResolver.resolve(
                requireValue(identifier.get("system")), requireValue(identifier.get("value")), requestDetails);
        String scope = claims.getStringClaim("scope");
        if (scope == null || !java.util.Arrays.stream(scope.split(" ")).allMatch(value -> value.startsWith("patient/"))) throw new SecurityException("Clinical scope context is invalid");
        for (String token : scope.split(" ")) {
            if (!token.startsWith("patient/Patient.") || !token.contains("?")) continue;
            for (String clause : token.substring(token.indexOf('?') + 1).split("&", -1)) {
                if (clause.startsWith("identifier=") && !clause.equals("identifier=" + requireValue(identifier.get("system")) + "|" + requireValue(identifier.get("value")))) {
                    throw new SecurityException("Patient scope identity disagrees with context");
                }
            }
        }
        List<PcmReadGrant> grants = PcmSmartScopeParser.parse(scope, patientId);
        return new PcmRequestContext(healthOrganization, claims.getSubject(), grants,
                PcmRequestContext.Kind.DATA_SOURCE_ACCESS, null, List.of(), null, false, null, patientId);
    }

    private PcmRequestContext onlinePresenceContext(JWTClaimsSet claims) throws Exception {
        requireSystemBasis(claims, "presence-check");
        if (claims.getClaim("representative_identifier") != null) throw new SecurityException("Presence representative is invalid");
        Object raw = claims.getClaim("presence_identifiers");
        if (!(raw instanceof List<?> values) || values.size() != 1 || !(values.get(0) instanceof Map<?, ?> map)
                || claims.getClaim("patient_identifier") != null || claims.getClaim("patient") != null) {
            throw new SecurityException("Online presence context is invalid");
        }
        if (!map.keySet().equals(Set.of("system", "value"))) throw new SecurityException("Presence identifier is invalid");
        PcmPatientIdentifier identifier = new PcmPatientIdentifier(requireValue(map.get("system")), requireValue(map.get("value")));
        if (!presenceScope(claims.getStringClaim("scope")).equals(List.of(identifier))) {
            throw new SecurityException("Online presence scope does not match its Patient context");
        }
        return new PcmRequestContext(healthOrganization, claims.getSubject(), List.of(),
                PcmRequestContext.Kind.ONLINE_PRESENCE, null, List.of(identifier), null, false);
    }

    @SuppressWarnings("unchecked")
    private PcmRequestContext batchPresenceContext(JWTClaimsSet claims) throws Exception {
        requireSystemBasis(claims, "presence-check");
        if (claims.getClaim("representative_identifier") != null) throw new SecurityException("Presence representative is invalid");
        Object raw = claims.getClaim("presence_identifiers");
        if (!(raw instanceof List<?> values) || values.size() < 2 || values.size() > presenceMaximum.getAsInt()
                || claims.getClaim("patient_identifier") != null
                || claims.getClaim("patient") != null
                || claims.getClaim("consent_identifier") != null
                || claims.getClaim("organization") != null) {
            throw new SecurityException("Batch presence context is invalid");
        }
        List<PcmPatientIdentifier> identifiers = new ArrayList<>();
        for (Object value : values) {
            if (!(value instanceof Map<?, ?> map)) throw new SecurityException("Batch presence context is invalid");
            identifiers.add(identifier((Map<String, Object>) map));
        }
        if (new java.util.HashSet<>(identifiers).size() != identifiers.size()
                || !presenceScope(claims.getStringClaim("scope")).equals(identifiers)) {
            throw new SecurityException("Batch presence scope does not match its Patient set");
        }
        return new PcmRequestContext(healthOrganization, claims.getSubject(), List.of(),
                PcmRequestContext.Kind.BATCH_PRESENCE, null, identifiers, null, false);
    }

    /** Validate current policy/service identifiers before accepting a system scenario. */
    private void requireSystemBasis(JWTClaimsSet claims, String scenario) throws Exception {
        if (!scenario.equals(claims.getStringClaim("scenario")) || claims.getClaim("consent_identifier") != null
                || claims.getClaim("organization") != null) throw new SecurityException("System context is invalid");
        Map<String, Object> contract = requiredMap(claims, "contract_identifier");
        requireExactKeys(contract, Set.of("system", "value"));
        if (claims.getClaim("healthcare_service_identifier") != null
                || !"http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id".equals(contract.get("system"))
                || !java.util.Objects.equals(workflowIdentities.get().get(scenario), requireValue(contract.get("value")))) {
            throw new SecurityException("System business identifier is invalid");
        }
    }

    private PcmRequestContext authenticationContext(JWTClaimsSet claims, RequestDetails request) throws Exception {
        requireSystemBasis(claims, "patient-authentication");
        if (claims.getClaim("presence_identifiers") != null || claims.getClaim("representative_identifier") != null) throw new SecurityException("Authentication context is invalid");
        PcmPatientIdentifier identifier = identifier(requiredMap(claims, "patient_identifier"));
        if (!claims.getStringClaim("scope").equals("patient/Patient.s?" + PcmWorkflowPolicy.DEMOGRAPHICS)
                || ((identifier.system().endsWith("/il-hdp-test-id") && !syntheticWorkflowFixtures.get().contains(identifier)) || identifier.system().equals(PcmSandboxSamplePolicy.SYSTEM))) throw new SecurityException("Authentication scope is invalid");
        String patientId = patientResolver.resolve(identifier.system(), identifier.value(), request);
        return new PcmRequestContext(healthOrganization, claims.getSubject(),
                PcmSmartScopeParser.parse(claims.getStringClaim("scope"), patientId),
                PcmRequestContext.Kind.PATIENT_AUTHENTICATION, identifier, List.of(), null, false);
    }

    private PcmRequestContext discoveryContext(JWTClaimsSet claims) throws Exception {
        requireSystemBasis(claims, "dependent-discovery");
        if (claims.getClaim("patient") != null || claims.getClaim("patient_identifier") != null
                || claims.getClaim("presence_identifiers") != null) throw new SecurityException("Discovery context is invalid");
        PcmPatientIdentifier representative = identifier(requiredMap(claims, "representative_identifier"));
        if (((representative.system().endsWith("/il-hdp-test-id") && !syntheticWorkflowFixtures.get().contains(representative)) || representative.system().equals(PcmSandboxSamplePolicy.SYSTEM))) throw new SecurityException("Discovery identity is invalid");
        List<String> scope = List.of(claims.getStringClaim("scope").split(" ", -1));
        if (scope.size() != 2 || !scope.contains("system/Patient.s?_has:RelatedPerson:patient:identifier=" + representative.token() + "&" + PcmWorkflowPolicy.DEMOGRAPHICS)
                || !scope.contains("system/RelatedPerson.s?identifier=" + representative.token() + "&" + PcmWorkflowPolicy.DEMOGRAPHICS + "&" + PcmWorkflowPolicy.DISCOVERY_TAG)) throw new SecurityException("Discovery scope is invalid");
        return new PcmRequestContext(healthOrganization, claims.getSubject(),
                PcmSmartScopeParser.parse(claims.getStringClaim("scope"), null),
                PcmRequestContext.Kind.DEPENDENT_DISCOVERY, null, List.of(), null, false, representative);
    }

    private static PcmPatientIdentifier identifier(Map<String, Object> value) {
        requireExactKeys(value, Set.of("system", "value"));
        return new PcmPatientIdentifier(requireValue(value.get("system")), requireValue(value.get("value")));
    }

    private static List<PcmPatientIdentifier> presenceScope(String scope) {
        String prefix = "system/Patient.s?identifier=";
        if (scope == null || !scope.startsWith(prefix) || scope.length() == prefix.length()
                || scope.contains(" ") || scope.contains("\t") || scope.contains("\n")) {
            throw new SecurityException("Presence scope is invalid");
        }
        String suffix = "&" + PcmWorkflowPolicy.DEMOGRAPHICS;
        if (!scope.endsWith(suffix)) throw new SecurityException("Presence demographics predicate is required");
        List<PcmPatientIdentifier> identifiers = new ArrayList<>();
        for (String token : scope.substring(prefix.length(), scope.length() - suffix.length()).split(",", -1)) {
            int separator = token.indexOf('|');
            if (separator <= 0 || separator != token.lastIndexOf('|') || separator == token.length() - 1) {
                throw new SecurityException("Presence scope is invalid");
            }
            identifiers.add(new PcmPatientIdentifier(token.substring(0, separator), token.substring(separator + 1)));
        }
        return List.copyOf(identifiers);
    }

    private static String uriPath(String uri) {
        int query = uri.indexOf('?');
        return query < 0 ? uri : uri.substring(0, query);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> requiredMap(JWTClaimsSet claims, String name) throws Exception {
        Object value = claims.getClaim(name);
        if (!(value instanceof Map<?, ?>)) throw new PcmContextException("CONTEXT_SCHEMA_INVALID", "Adapter JWT schema is invalid");
        return (Map<String, Object>) value;
    }

    private static Map<String, Object> optionalMap(JWTClaimsSet claims, String name) throws Exception {
        return claims.getClaim(name) == null ? null : requiredMap(claims, name);
    }

    private static void requireExactKeys(Map<String, Object> value, Set<String> keys) {
        if (!value.keySet().equals(keys)) throw new PcmContextException("CONTEXT_SCHEMA_INVALID", "Adapter JWT schema is invalid");
    }

    private static String requireValue(Object value) {
        if (!(value instanceof String text) || text.isBlank()) throw new SecurityException("Required value is missing");
        return text;
    }

    private static RSAPublicKey readPublicKey(Path certificate) {
        try (InputStream input = Files.newInputStream(certificate)) {
            return (RSAPublicKey) CertificateFactory.getInstance("X.509")
                    .generateCertificate(input).getPublicKey();
        } catch (Exception error) {
            throw new IllegalStateException("Unable to load the configured adapter certificate", error);
        }
    }

    private static String keyId(RSAPublicKey key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key.getEncoded());
            return "local-jwt-" + Base64.getUrlEncoder().withoutPadding().encodeToString(digest).substring(0, 16);
        } catch (Exception error) {
            throw new IllegalStateException("Unable to derive adapter key id", error);
        }
    }
}
