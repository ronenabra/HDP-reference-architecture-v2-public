package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.server.SystemRequestDetails;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Covers private HAPI completion, errors, HO attribution and AWS canaries. */
class PcmImportDiagnosticInterceptorTest {
    private final ObjectMapper mapper = new ObjectMapper();

    private static SystemRequestDetails request(String operationId) {
        SystemRequestDetails details = new SystemRequestDetails();
        details.setRequestType(RequestTypeEnum.POST);
        details.setRequestPath("");
        details.addHeader(PrivateImportRequestContextVerifier.HEADER, "synthetic-import-credential");
        if (operationId != null) details.addHeader("X-PCM-Operation-Id", operationId);
        return details;
    }

    @Test
    void recordsRequestNormalCompletionAndErrorForNamedHo() throws Exception {
        String id = "00000000-0000-4000-8000-000000000003";
        SystemRequestDetails details = request(id);
        PcmImportDiagnosticInterceptor interceptor = new PcmImportDiagnosticInterceptor(mapper, "ho-b");
        JsonNode first = mapper.readTree(interceptor.record("hapi-request", "INFO", details, null, null));
        JsonNode completion = mapper.readTree(interceptor.record("hapi-complete", "INFO", details, null, null));
        JsonNode error = mapper.readTree(interceptor.record("hapi-error", "ERROR", details, 403,
                new ForbiddenOperationException("synthetic failure")));

        assertThat(PcmImportDiagnosticInterceptor.eligible(details)).isTrue();
        assertThat(first.at("/details/visibility").asText()).isEqualTo("diagnostic");
        assertThat(error.at("/details/visibility").asText()).isEqualTo("diagnostic");
        assertThat(first.at("/details/stage").asText()).isEqualTo("hapi-request");
        assertThat(completion.at("/details/stage").asText()).isEqualTo("hapi-complete");
        assertThat(error.at("/details/stage").asText()).isEqualTo("hapi-error");
        assertThat(error.at("/details/healthOrganizationId").asText()).isEqualTo("ho-b");
        assertThat(error.at("/details/operationId").asText()).isEqualTo(id);
        assertThat(error.at("/details/httpStatus").asInt()).isEqualTo(403);
    }

    @Test
    void marksMissingCorrelationAndRestrictsNativeStreamToPrivatePost() throws Exception {
        PcmImportDiagnosticInterceptor interceptor = new PcmImportDiagnosticInterceptor(mapper, "ho-a");
        SystemRequestDetails uncorrelated = request("bad-identifier");
        JsonNode nativeRecord = mapper.readTree(interceptor.record("hapi-complete", "INFO", uncorrelated, null, null));
        assertThat(nativeRecord.at("/details/correlation").asText()).isEqualTo("unavailable");
        assertThat(nativeRecord.at("/details/operationId").isNull()).isTrue();
        uncorrelated.setRequestType(RequestTypeEnum.GET);
        assertThat(PcmImportDiagnosticInterceptor.eligible(uncorrelated)).isFalse();
        uncorrelated.setRequestType(RequestTypeEnum.POST);
        uncorrelated.setRequestPath("Patient");
        assertThat(PcmImportDiagnosticInterceptor.eligible(uncorrelated)).isFalse();
        assertThat(PcmImportDiagnosticInterceptor.sanitize("AKIAABCDEFGHIJKLMNOP Patient/123"))
                .isEqualTo("[AWS_CREDENTIAL_BLOCKED] Patient/123");
        assertThat(PcmImportDiagnosticInterceptor.sanitize("aws_secret_access_key=synthetic-secret Patient/123"))
                .isEqualTo("[AWS_CREDENTIAL_BLOCKED] Patient/123");
    }
}
