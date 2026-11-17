package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.searchparam.matcher.AuthorizationSearchParamMatcher;
import ca.uhn.fhir.jpa.searchparam.matcher.SearchParamMatcher;
import ca.uhn.fhir.jpa.api.dao.DaoRegistry;
import ca.uhn.fhir.jpa.api.dao.IFhirSystemDao;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.context.FhirContext;
import com.fasterxml.jackson.databind.ObjectMapper;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentInterceptor;
import ca.uhn.fhir.rest.server.interceptor.consent.RuleFilteringConsentService;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Meta;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.nio.file.Path;

/** Spring module loaded by the pinned HAPI JPA Starter. */
@AutoConfiguration
@Configuration
public class PcmHapiSecurityConfiguration {
    private final PcmRuntimeObservability observations = new PcmRuntimeObservability();

    /** Observe receipt before the existing startup gate, including pre-context refusals. */
    @Bean
    org.springframework.boot.web.servlet.FilterRegistrationBean<jakarta.servlet.Filter> pcmRuntimeLifecycle() {
        var registration = new org.springframework.boot.web.servlet.FilterRegistrationBean<jakarta.servlet.Filter>(observations);
        registration.addUrlPatterns("/fhir/*"); registration.setAsyncSupported(true);
        registration.setOrder(org.springframework.core.Ordered.HIGHEST_PRECEDENCE); return registration;
    }

    private final java.util.concurrent.atomic.AtomicBoolean securityReady = new java.util.concurrent.atomic.AtomicBoolean();

    /** Fail closed while the pinned Starter opens its connector before ApplicationReady registration. */
    @Bean
    org.springframework.boot.web.servlet.FilterRegistrationBean<jakarta.servlet.Filter> pcmSecurityStartupGate() {
        jakarta.servlet.Filter filter = (request, response, chain) -> {
            if (securityReady.get()) { chain.doFilter(request, response); return; }
            var http = (jakarta.servlet.http.HttpServletResponse) response;
            http.setStatus(503);
            http.setHeader("Retry-After", "1");
            http.setContentType("application/fhir+json");
            http.getWriter().write("{\"resourceType\":\"OperationOutcome\",\"issue\":[{\"severity\":\"error\",\"code\":\"transient\",\"diagnostics\":\"PCM security initialization is incomplete\"}]}");
        };
        var registration = new org.springframework.boot.web.servlet.FilterRegistrationBean<>(filter);
        registration.addUrlPatterns("/fhir/*");
        registration.setAsyncSupported(true);
        registration.setOrder(org.springframework.core.Ordered.HIGHEST_PRECEDENCE + 1);
        return registration;
    }

    /** Observe statements only while the existing PAGE worker owns their execution. */
    @Bean
    static org.springframework.beans.factory.config.BeanPostProcessor pcmPageDataSource() {
        return new org.springframework.beans.factory.config.BeanPostProcessor() {
            @Override public Object postProcessAfterInitialization(Object bean, String name) {
                return bean instanceof javax.sql.DataSource source ? new PcmPageDataSource(source) : bean;
            }
        };
    }

    /** Preserve standard NIO behavior while exposing supported request-bound count observation. */
    @Bean
    org.springframework.boot.web.server.WebServerFactoryCustomizer<org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory>
            pcmCountConnector() {
        return factory -> factory.setProtocol(PcmCountTomcatProtocol.class.getName());
    }

    /** Exact identifier lookup stays inside the HAPI persistence abstraction. */
    @Bean
    PatientIdentifierResolver patientIdentifierResolver(DaoRegistry daoRegistry) {
        return new HapiPatientIdentifierResolver(daoRegistry);
    }

    /** Load explicitly configured local limits without claiming national defaults. */
    @Bean
    PcmPresenceLimits pcmPresenceLimits(ObjectMapper mapper) {
        return PcmPresenceLimitLoader.load(
                Path.of(System.getenv().getOrDefault("TEAM_CONFIG_PATH", "/runtime/team-config.json")), mapper);
    }

    /** Verify the HO-pairwise adapter JWT while retaining the private loader path. */
    @Bean
    @ConditionalOnMissingBean(SignedRequestContextVerifier.class)
    SignedRequestContextVerifier signedRequestContextVerifier(PatientIdentifierResolver patientResolver) {
        String hoId = requiredEnvironment("HO_ID");
        SignedRequestContextVerifier importer = new PrivateImportRequestContextVerifier(
                System.getenv("PCM_IMPORT_CREDENTIAL"),
                hoId);
        SignedRequestContextVerifier adapter = new LocalJwtRequestContextVerifier(
                requiredEnvironment("PCM_LOCAL_JWT_ISSUER"),
                requiredEnvironment("PCM_LOCAL_JWT_AUDIENCE"),
                hoId,
                Path.of(requiredEnvironment("PCM_LOCAL_JWT_CERTIFICATE")),
                patientResolver);
        return new CompositeRequestContextVerifier(importer, adapter);
    }

    /**
     * Register after JPA/search initialization. Constructing the search matcher
     * while StarterJpaConfig creates RestfulServer introduces an upstream bean
     * cycle, so the module deliberately attaches at ApplicationReadyEvent.
     */
    @Bean
    ApplicationListener<ApplicationReadyEvent> pcmSecurityRegistrar(
            SignedRequestContextVerifier verifier,
            PatientIdentifierResolver patientResolver,
            PcmPresenceLimits presenceLimits,
            FhirContext fhirContext,
            IFhirSystemDao<Bundle, Meta> systemDao) {
        return event -> {
            SignedRequestContextVerifier observedVerifier = new PcmObservedVerifier(verifier, observations);
            PatientPresenceCounter presenceCounter = (PatientPresenceCounter) patientResolver;
            SearchParamMatcher nativeMatcher = event.getApplicationContext().getBean(SearchParamMatcher.class);
            AuthorizationSearchParamMatcher authorizationMatcher = new AuthorizationSearchParamMatcher(nativeMatcher);
            PcmMatcherProbe.probe(authorizationMatcher);
            PcmAuthorizationInterceptor resultFilter = new PcmAuthorizationInterceptor(
                    observedVerifier, new PcmDiscoveryMatcher(authorizationMatcher, event.getApplicationContext().getBean(ca.uhn.fhir.jpa.api.dao.DaoRegistry.class)));
            PcmAdmissionAuthorizationInterceptor admission = new PcmAdmissionAuthorizationInterceptor(observedVerifier, observations);
            ConsentInterceptor consent = new PcmSearchConsentInterceptor(new PcmObservedConsentService(resultFilter, observations));
            RestfulServer server = event.getApplicationContext().getBean(RestfulServer.class);
            server.registerInterceptor(observations);
            // Keep native persisted search phases useful for small first pages. The
            // PAGE worker independently bounds native work even at the final threshold.
            event.getApplicationContext().getBean(ca.uhn.fhir.jpa.api.config.JpaStorageSettings.class)
                    .setSearchPreFetchThresholds(java.util.List.of(32, 128, 512, 2048, -1));
            // The verifier bean already requires HO_ID at startup; keep this
            // registration independently testable with an explicit fallback.
            server.registerInterceptor(new PcmImportDiagnosticInterceptor(
                    new ObjectMapper(), System.getenv().getOrDefault("HO_ID", "unavailable")));
            server.registerInterceptor(new PcmRoutePolicyInterceptor(observedVerifier, presenceCounter).observeWith(observations));
            PcmAuthorizedMatchExecutor matches = new PcmAuthorizedMatchExecutor(
                    event.getApplicationContext().getBean(DaoRegistry.class), new PcmObservedConsentService(resultFilter, observations),
                    event.getApplicationContext().getBean(org.springframework.transaction.PlatformTransactionManager.class),
                    event.getApplicationContext().getBean(jakarta.persistence.EntityManager.class),
                    fhirContext, event.getApplicationContext().getBean(ca.uhn.fhir.jpa.searchparam.MatchUrlService.class));
            PcmPageExecutor pages = new PcmPageExecutor(event.getApplicationContext().getBean(DaoRegistry.class),
                    event.getApplicationContext().getBean(org.springframework.transaction.PlatformTransactionManager.class),
                    event.getApplicationContext().getBean(jakarta.persistence.EntityManager.class), fhirContext, matches);
            server.registerInterceptor(pages);
            PcmCountInterceptor count = new PcmCountInterceptor(observedVerifier,
                    new PcmRoutePolicyInterceptor(observedVerifier, presenceCounter).observeWith(observations), matches, pages);
            server.registerInterceptor(count);
            event.getApplicationContext().addApplicationListener(closed -> {
                if (closed instanceof org.springframework.context.event.ContextClosedEvent) count.close();
            });
            server.registerInterceptor(admission);
            server.registerInterceptor(consent);
            server.registerInterceptor(new PcmResponsePolicyInterceptor());
            if (!"true".equalsIgnoreCase(System.getenv("PCM_IMPORT_ONLY"))) {
                server.registerProvider(new PcmBatchPresenceProvider(
                        observedVerifier, presenceCounter, presenceLimits, fhirContext, systemDao).withCurrentLimits(() ->
                            PcmPresenceLimitLoader.load(Path.of(System.getenv().getOrDefault("TEAM_CONFIG_PATH", "/runtime/team-config.json")), new ObjectMapper())));
            }
            securityReady.set(true);
            org.slf4j.LoggerFactory.getLogger(PcmRuntimeObservability.class).info("PCM_EVENT", java.util.Map.of("type", "HAPI_STARTUP_READY", "reasonCode", "STARTUP_READY", "detailCollection", observations.detailState()));
        };
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
