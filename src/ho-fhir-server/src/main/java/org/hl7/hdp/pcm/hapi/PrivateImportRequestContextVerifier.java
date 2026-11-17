package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.servlet.ServletRequestDetails;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

/** Verifies the private one-shot loader credential without logging it. */
public final class PrivateImportRequestContextVerifier implements SignedRequestContextVerifier {
    public static final String HEADER = "X-PCM-Import-Credential";
    private static final String SERVLET_ATTRIBUTE =
            PrivateImportRequestContextVerifier.class.getName() + ".context";
    private final byte[] expected;
    private final String healthOrganization;

    /** Create the closed verifier; a blank credential keeps the server deny-all. */
    public PrivateImportRequestContextVerifier(String credential, String healthOrganization) {
        this.expected = String.valueOf(credential == null ? "" : credential).getBytes(StandardCharsets.UTF_8);
        this.healthOrganization = healthOrganization == null || healthOrganization.isBlank() ? "unconfigured" : healthOrganization;
    }

    /** Read the custom credential across RequestDetails header-map casing. */
    static String credentialHeader(RequestDetails requestDetails) {
        String supplied = requestDetails.getHeader(HEADER);
        return supplied == null ? requestDetails.getHeader(HEADER.toLowerCase(java.util.Locale.ROOT)) : supplied;
    }

    @Override
    public PcmRequestContext verify(RequestDetails requestDetails) {
        Object cached = requestDetails.getUserData().get(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE);
        if (cached instanceof PcmRequestContext context && context.importAccess()) return context;
        if (requestDetails instanceof ServletRequestDetails servletDetails) {
            Object servletCached = servletDetails.getServletRequest().getAttribute(SERVLET_ATTRIBUTE);
            if (servletCached instanceof PcmRequestContext context && context.importAccess()) return context;
        }
        String supplied = credentialHeader(requestDetails);
        byte[] actual = String.valueOf(supplied == null ? "" : supplied).getBytes(StandardCharsets.UTF_8);
        if (expected.length < 32 || !MessageDigest.isEqual(expected, actual)) {
            if ("true".equalsIgnoreCase(System.getenv("PCM_IMPORT_ONLY"))) {
                System.err.printf("PCM private import credential denied: present=%s expectedLength=%d actualLength=%d%n",
                        supplied != null, expected.length, actual.length);
            }
            throw new SecurityException("Private import credential missing or invalid");
        }
        PcmRequestContext context = new PcmRequestContext(
                healthOrganization, "clinical-data-loader", List.of(), true);
        // HAPI can perform multiple authorization passes for a system
        // operation. Preserve the verified import context on RequestDetails
        // instead of depending on the servlet header surviving every pass.
        requestDetails.getUserData().put(LocalJwtRequestContextVerifier.CONTEXT_ATTRIBUTE, context);
        if (requestDetails instanceof ServletRequestDetails servletDetails) {
            // Transaction entry authorization uses derived RequestDetails but
            // retains the parent servlet request. Cache only the already
            // verified context there so every entry remains credential-bound.
            servletDetails.getServletRequest().setAttribute(SERVLET_ATTRIBUTE, context);
        }
        return context;
    }
}
