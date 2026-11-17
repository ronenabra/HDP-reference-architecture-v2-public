package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Tests the isolated import credential boundary. */
class PrivateImportRequestContextVerifierTest {
    private static final String SECRET = "0123456789abcdef0123456789abcdef";

    @Test
    void exactCredentialCreatesOnlyAnImportContext() {
        SystemRequestDetails request = new SystemRequestDetails();
        request.addHeader(PrivateImportRequestContextVerifier.HEADER, SECRET);
        PcmRequestContext context = new PrivateImportRequestContextVerifier(SECRET, "ho-a").verify(request);

        assertThat(context.healthOrganization()).isEqualTo("ho-a");
        assertThat(context.importAccess()).isTrue();
        assertThat(context.readGrants()).isEmpty();
    }

    @Test
    void normalizedLowercaseHeaderSelectsAndVerifiesTheImportPath() {
        SystemRequestDetails request = new SystemRequestDetails();
        request.addHeader(PrivateImportRequestContextVerifier.HEADER.toLowerCase(java.util.Locale.ROOT), SECRET);
        SignedRequestContextVerifier deniedAdapter = ignored -> { throw new AssertionError("adapter path selected"); };
        PcmRequestContext context = new CompositeRequestContextVerifier(
                new PrivateImportRequestContextVerifier(SECRET, "ho-a"), deniedAdapter).verify(request);

        assertThat(context.importAccess()).isTrue();
    }

    @Test
    void verifiedContextSurvivesLaterAuthorizationPassesWithoutHeaders() {
        SystemRequestDetails request = new SystemRequestDetails();
        request.addHeader(PrivateImportRequestContextVerifier.HEADER, SECRET);
        PrivateImportRequestContextVerifier verifier = new PrivateImportRequestContextVerifier(SECRET, "ho-a");
        PcmRequestContext initial = verifier.verify(request);
        request.setHeaders(PrivateImportRequestContextVerifier.HEADER, java.util.List.of());

        assertThat(verifier.verify(request)).isSameAs(initial);
    }

    @Test
    void missingShortAndWrongCredentialsFailClosed() {
        SystemRequestDetails request = new SystemRequestDetails();
        assertThatThrownBy(() -> new PrivateImportRequestContextVerifier(SECRET, "ho-a").verify(request))
                .isInstanceOf(SecurityException.class);
        request.addHeader(PrivateImportRequestContextVerifier.HEADER, "wrong");
        assertThatThrownBy(() -> new PrivateImportRequestContextVerifier(SECRET, "ho-a").verify(request))
                .isInstanceOf(SecurityException.class);
        request.setHeaders(PrivateImportRequestContextVerifier.HEADER, java.util.List.of(SECRET));
        assertThatThrownBy(() -> new PrivateImportRequestContextVerifier("short", "ho-a").verify(request))
                .isInstanceOf(SecurityException.class);
    }
}
