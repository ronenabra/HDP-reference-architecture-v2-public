package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.server.RequestDetails;
import java.util.List;

/** Narrow, verified-request delegate overriding only native cache reuse; it confers no system authority. */
final class PcmNativeSearchRequest extends RequestDetails {
    private final RequestDetails original;

    /** Preserve method, query, interceptor broadcaster and verified user data from the original request. */
    PcmNativeSearchRequest(RequestDetails original) { super(original); this.original = original; }
    @Override public String getHeader(String name) {
        return "Cache-Control".equalsIgnoreCase(name) ? "no-cache" : original.getHeader(name);
    }
    @Override public List<String> getHeaders(String name) {
        return "Cache-Control".equalsIgnoreCase(name) ? List.of("no-cache") : original.getHeaders(name);
    }
    @Override public void addHeader(String name, String value) { original.addHeader(name, value); }
    @Override public void setHeaders(String name, List<String> values) { original.setHeaders(name, values); }
    @Override protected byte[] getByteStreamRequestContents() { return original.loadRequestContents(); }
    @Override public java.nio.charset.Charset getCharset() { return original.getCharset(); }
    @Override public ca.uhn.fhir.context.FhirContext getFhirContext() { return original.getFhirContext(); }
    @Override public java.io.InputStream getInputStream() throws java.io.IOException { return original.getInputStream(); }
    @Override public java.io.Reader getReader() throws java.io.IOException { return original.getReader(); }
    @Override public ca.uhn.fhir.rest.server.IRestfulServerDefaults getServer() { return original.getServer(); }
    @Override public String getServerBaseForRequest() { return original.getServerBaseForRequest(); }
}
