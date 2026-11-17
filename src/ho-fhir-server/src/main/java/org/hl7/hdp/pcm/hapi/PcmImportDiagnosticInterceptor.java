package org.hl7.hdp.pcm.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** Emit only private import request, normal completion and HAPI error records. */
public final class PcmImportDiagnosticInterceptor {
    private static final Logger LOG = LoggerFactory.getLogger(PcmImportDiagnosticInterceptor.class);
    private static final Pattern OPERATION_ID = Pattern.compile("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");
    private static final Pattern AWS_ACCESS_KEY = Pattern.compile("\\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\\b");
    private static final Pattern AWS_SIGV4 = Pattern.compile("\\bAWS4-HMAC-SHA256\\s+Credential=[^\\s,]+(?:,\\s*SignedHeaders=[^\\s,]+,\\s*Signature=[A-Fa-f0-9]+)?");
    private static final Pattern AWS_NAMED_SECRET = Pattern.compile(
            "(?i)\\b(?:aws[_-]?(?:secret[_-]?access[_-]?key|session[_-]?token|security[_-]?token)|x-amz-security-token)\\b\\s*[=:]\\s*\\\"?[^\\\"\\s,;]+\\\"?");
    private final ObjectMapper mapper;
    private final String hoId;

    /** Bind one interceptor to the named HO and its JSON serializer. */
    public PcmImportDiagnosticInterceptor(ObjectMapper mapper, String hoId) {
        this.mapper = mapper;
        this.hoId = hoId;
    }

    /** Record receipt before HAPI handles the private transaction. */
    @Hook(Pointcut.SERVER_INCOMING_REQUEST_PRE_HANDLED)
    public void request(RequestDetails details) {
        if (eligible(details)) emit("hapi-request", "INFO", details, null, null);
    }

    /** HAPI's normal completion hook marks processing independently of PCM's client deadline. */
    @Hook(Pointcut.SERVER_PROCESSING_COMPLETED_NORMALLY)
    public void completed(RequestDetails details) {
        if (eligible(details)) emit("hapi-complete", "INFO", details, null, null);
    }

    /** Preserve the native HAPI failure stage and HTTP status for the same HO. */
    @Hook(Pointcut.SERVER_HANDLE_EXCEPTION)
    public void failed(RequestDetails details, BaseServerResponseException error) {
        if (eligible(details)) emit("hapi-error", "ERROR", details, error.getStatusCode(), error);
    }

    static boolean eligible(RequestDetails details) {
        if (details == null || details.getRequestType() != RequestTypeEnum.POST ||
                PrivateImportRequestContextVerifier.credentialHeader(details) == null) return false;
        String path = details.getRequestPath();
        return path == null || path.isBlank() || "$expunge".equals(path);
    }

    static String operationId(RequestDetails details) {
        String supplied = details.getHeader("X-PCM-Operation-Id");
        if (supplied == null) supplied = details.getHeader("x-pcm-operation-id");
        return supplied != null && OPERATION_ID.matcher(supplied).matches() ? supplied : null;
    }

    static String sanitize(String value) {
        if (value == null) return null;
        return AWS_NAMED_SECRET.matcher(AWS_SIGV4.matcher(AWS_ACCESS_KEY.matcher(value)
                .replaceAll("[AWS_CREDENTIAL_BLOCKED]"))
                .replaceAll("[AWS_CREDENTIAL_BLOCKED]"))
                .replaceAll("[AWS_CREDENTIAL_BLOCKED]");
    }

    private void emit(String stage, String level, RequestDetails request, Integer status, Exception error) {
        try {
            String json = record(stage, level, request, status, error);
            if ("ERROR".equals(level)) LOG.error(json);
            else LOG.info(json);
        } catch (JsonProcessingException serializationFailure) {
            LOG.error("HAPI private import diagnostic serialization failed for {}", stage);
        }
    }

    /** Build a structured native record for the dedicated import appender. */
    String record(String stage, String level, RequestDetails request, Integer status, Exception error)
            throws JsonProcessingException {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("type", "HAPI_IMPORT_DIAGNOSTIC");
        details.put("visibility", "diagnostic");
        details.put("stage", stage);
        details.put("healthOrganizationId", hoId);
        details.put("operationId", operationId(request));
        details.put("correlation", operationId(request) == null ? "unavailable" : "operation");
        details.put("requestPath", request.getRequestPath());
        if (status != null) details.put("httpStatus", status);
        if (error != null) {
            details.put("errorType", error.getClass().getName());
            details.put("error", sanitize(error.getMessage()));
        }
        Map<String, Object> record = Map.of(
                "timestamp", Instant.now().toString(), "level", level,
                "message", "HAPI private import " + stage, "details", details);
        return mapper.writeValueAsString(record);
    }
}
