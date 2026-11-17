package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;

/** Selects the one-shot private importer or the ordinary signed adapter path. */
public final class CompositeRequestContextVerifier implements SignedRequestContextVerifier {
    private final SignedRequestContextVerifier importer;
    private final SignedRequestContextVerifier adapter;

    public CompositeRequestContextVerifier(SignedRequestContextVerifier importer, SignedRequestContextVerifier adapter) {
        this.importer = importer;
        this.adapter = adapter;
    }

    @Override
    public PcmRequestContext verify(RequestDetails requestDetails) {
        return PrivateImportRequestContextVerifier.credentialHeader(requestDetails) == null
                ? adapter.verify(requestDetails)
                : importer.verify(requestDetails);
    }
}
