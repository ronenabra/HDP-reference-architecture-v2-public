package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.jpa.searchparam.matcher.AuthorizationSearchParamMatcher;
import ca.uhn.fhir.jpa.api.dao.IFhirSystemDao;
import ca.uhn.fhir.jpa.searchparam.matcher.InMemoryMatchResult;
import ca.uhn.fhir.jpa.searchparam.matcher.SearchParamMatcher;
import ca.uhn.fhir.rest.server.RestfulServer;
import ca.uhn.fhir.rest.server.interceptor.consent.ConsentInterceptor;
import ca.uhn.fhir.context.FhirContext;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ConfigurableApplicationContext;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Meta;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;

/** Verifies that the starter extension wires HAPI's native security components. */
class PcmHapiSecurityConfigurationTest {
    @Test void configuresSupportedNativeNioLifecycleExtension() {
        var factory = mock(org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory.class);
        new PcmHapiSecurityConfiguration().pcmCountConnector().customize(factory);
        verify(factory).setProtocol(PcmCountTomcatProtocol.class.getName());
    }

    @Test
    void createsNativeMatcherAuthorizationAndConsentChain() throws Exception {
        PcmHapiSecurityConfiguration configuration = new PcmHapiSecurityConfiguration();
        SignedRequestContextVerifier verifier = request ->
                new PcmRequestContext("ho-a", "client", java.util.List.of());
        PatientIdentifierResolver patientResolver = mock(
                PatientIdentifierResolver.class,
                org.mockito.Mockito.withSettings().extraInterfaces(PatientPresenceCounter.class));
        SearchParamMatcher matcher = mock(SearchParamMatcher.class);
        when(matcher.match(anyString(), any(), org.mockito.ArgumentMatchers.isNull()))
                .thenAnswer(invocation -> {
                    String expression = invocation.getArgument(0);
                    return expression.contains("subject.identifier")
                            || expression.contains("_has")
                            || expression.contains("_filter")
                            || expression.contains("_lastUpdated")
                            || expression.contains("code-value-quantity")
                            || expression.contains(":missing")
                            ? InMemoryMatchResult.unsupportedFromReason("deferred")
                            : InMemoryMatchResult.successfulMatch();
                });
        RestfulServer server = mock(RestfulServer.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(context.getBean(SearchParamMatcher.class)).thenReturn(matcher);
        when(context.getBean(RestfulServer.class)).thenReturn(server);
        var storageSettings = mock(ca.uhn.fhir.jpa.api.config.JpaStorageSettings.class);
        when(context.getBean(ca.uhn.fhir.jpa.api.config.JpaStorageSettings.class)).thenReturn(storageSettings);
        when(context.getBean(ca.uhn.fhir.jpa.api.dao.DaoRegistry.class)).thenReturn(mock(ca.uhn.fhir.jpa.api.dao.DaoRegistry.class));
        when(context.getBean(org.springframework.transaction.PlatformTransactionManager.class))
                .thenReturn(mock(org.springframework.transaction.PlatformTransactionManager.class));
        when(context.getBean(jakarta.persistence.EntityManager.class)).thenReturn(mock(jakarta.persistence.EntityManager.class));
        ApplicationReadyEvent event = mock(ApplicationReadyEvent.class);
        when(event.getApplicationContext()).thenReturn(context);

        configuration.pcmSecurityRegistrar(
                verifier, patientResolver,
                new PcmPresenceLimits(10, 16384, 1000), FhirContext.forR4Cached(), mockSystemDao())
                .onApplicationEvent(event);

        verify(storageSettings).setSearchPreFetchThresholds(java.util.List.of(32, 128, 512, 2048, -1));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(PcmPageExecutor.class));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(PcmAdmissionAuthorizationInterceptor.class));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(ConsentInterceptor.class));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(PcmRoutePolicyInterceptor.class));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(PcmResponsePolicyInterceptor.class));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(PcmCountInterceptor.class));
        verify(server).registerInterceptor(org.mockito.ArgumentMatchers.isA(PcmImportDiagnosticInterceptor.class));
        verify(server).registerProvider(org.mockito.ArgumentMatchers.isA(PcmBatchPresenceProvider.class));
        var chain = mock(jakarta.servlet.FilterChain.class);
        var request = mock(jakarta.servlet.ServletRequest.class);
        var response = mock(jakarta.servlet.http.HttpServletResponse.class);
        configuration.pcmSecurityStartupGate().getFilter().doFilter(request, response, chain);
        verify(chain).doFilter(request, response);
    }

    @Test void startupGateDeniesFhirUntilEverySecurityComponentIsInstalled() throws Exception {
        var configuration = new PcmHapiSecurityConfiguration();
        var gate = configuration.pcmSecurityStartupGate();
        assertThat(gate.getUrlPatterns()).containsExactly("/fhir/*");
        var request = mock(jakarta.servlet.ServletRequest.class);
        var response = mock(jakarta.servlet.http.HttpServletResponse.class);
        var chain = mock(jakarta.servlet.FilterChain.class);
        var output = new java.io.StringWriter();
        when(response.getWriter()).thenReturn(new java.io.PrintWriter(output));
        gate.getFilter().doFilter(request, response, chain);
        verify(response).setStatus(503); verify(response).setHeader("Retry-After", "1");
        org.mockito.Mockito.verifyNoInteractions(chain);
        assertThat(output.toString()).contains("OperationOutcome");
    }

    @SuppressWarnings("unchecked")
    private static IFhirSystemDao<Bundle, Meta> mockSystemDao() {
        return mock(IFhirSystemDao.class);
    }
}
