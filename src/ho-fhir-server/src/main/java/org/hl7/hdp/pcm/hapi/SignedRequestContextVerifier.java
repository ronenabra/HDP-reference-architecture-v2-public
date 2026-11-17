package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;

/**
 * Boundary for verifying the adapter-signed, audience- and HO-bound context.
 * Sprint 15 deliberately provides only a rejecting production default; the
 * closed JWT/JWKS implementation is installed with the active policy in
 * Sprint 17.
 */
@FunctionalInterface
public interface SignedRequestContextVerifier {
    /** Verify a request and return its immutable authorization context. */
    PcmRequestContext verify(RequestDetails requestDetails);
}
