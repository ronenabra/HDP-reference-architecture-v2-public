package org.hl7.hdp.pcm.hapi;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import ch.qos.logback.classic.spi.IThrowableProxy;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Array;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** Streaming JSON encoding: refuse whole records before unbounded exception/object serialization. */
final class PcmBoundedJson {
    private static final JsonFactory JSON = new JsonFactory();
    static final int LINE_LIMIT = 256 * 1024;
    static final int EXPLANATION_LIMIT = 64 * 1024;
    static final Pattern SECRET_KEY = Pattern.compile("(?i)(?:aws[_-]?(?:secret[_-]?access[_-]?key|session[_-]?token|security[_-]?token)|x-amz-security-token)");
    private PcmBoundedJson() { }

    /** Encode within the UTF-8 line budget, including newline; cycles/depth overflow refuse the record. */
    static byte[] encode(Object value, int limit) throws IOException {
        var output = new LimitedOutput(limit);
        try (JsonGenerator json = JSON.createGenerator(output)) {
            write(json, value, 0, new IdentityHashMap<>());
        }
        output.write('\n');
        return output.bytes.toByteArray();
    }

    private static void write(JsonGenerator json, Object value, int depth, IdentityHashMap<Object, Boolean> parents) throws IOException {
        if (depth > 32) throw new IOException("LOG_DEPTH_LIMIT");
        if (value == null) { json.writeNull(); return; }
        if (value instanceof String string) {
            if (string.length() > LINE_LIMIT) throw new IOException("LOG_OVERSIZE");
            json.writeString(PcmImportDiagnosticInterceptor.sanitize(string)); return;
        }
        if (value instanceof Enum<?> item) { json.writeString(item.name()); return; }
        if (value instanceof Throwable error) {
            json.writeStartObject(); json.writeStringField("type", error.getClass().getName());
            json.writeFieldName("message"); write(json, error.getMessage(), depth + 1, parents);
            json.writeStringField("stackReference", "native exception field when present"); json.writeEndObject(); return;
        }
        if (value instanceof Number number) { json.writeNumber(number.toString()); return; }
        if (value instanceof Boolean bool) { json.writeBoolean(bool); return; }
        if (parents.put(value, Boolean.TRUE) != null) throw new IOException("LOG_DEPTH_LIMIT");
        try {
            if (value instanceof Map<?, ?> map) {
                boolean awsTriplet = map.keySet().stream().anyMatch(key -> "AccessKeyId".equalsIgnoreCase(String.valueOf(key)))
                        && map.keySet().stream().anyMatch(key -> "SecretAccessKey".equalsIgnoreCase(String.valueOf(key)))
                        && map.keySet().stream().anyMatch(key -> "Token".equalsIgnoreCase(String.valueOf(key)) || "SessionToken".equalsIgnoreCase(String.valueOf(key)));
                boolean awsEcr = map.containsKey("authorizationToken") && (map.containsKey("proxyEndpoint") || map.containsKey("authorizationData"));
                json.writeStartObject();
                for (var entry : map.entrySet()) {
                    if (!(entry.getKey() instanceof String key) || key.length() > 512) throw new IOException("LOG_OVERSIZE");
                    json.writeFieldName(PcmImportDiagnosticInterceptor.sanitize(key));
                    write(json, (SECRET_KEY.matcher(key).matches() || awsTriplet && key.matches("(?i)AccessKeyId|SecretAccessKey|Token|SessionToken") || awsEcr && key.equals("authorizationToken")) ? "[AWS_CREDENTIAL_BLOCKED]" : entry.getValue(), depth + 1, parents);
                }
                json.writeEndObject();
            } else if (value instanceof Iterable<?> iterable) {
                json.writeStartArray(); for (Object item : iterable) write(json, item, depth + 1, parents); json.writeEndArray();
            } else if (value.getClass().isArray()) {
                json.writeStartArray(); for (int i = 0; i < Array.getLength(value); i++) write(json, Array.get(value, i), depth + 1, parents); json.writeEndArray();
            } else if (value instanceof IThrowableProxy error) {
                json.writeStartObject(); json.writeStringField("type", error.getClassName());
                json.writeFieldName("message"); write(json, error.getMessage(), depth + 1, parents);
                json.writeArrayFieldStart("stack");
                if (error.getStackTraceElementProxyArray() != null) for (var frame : error.getStackTraceElementProxyArray()) write(json, frameText(frame.getStackTraceElement()), depth + 1, parents);
                json.writeEndArray(); json.writeFieldName("cause"); write(json, error.getCause(), depth + 1, parents);
                json.writeFieldName("suppressed"); write(json, error.getSuppressed(), depth + 1, parents); json.writeEndObject();
            } else throw new IOException("Unsupported native log value: " + value.getClass().getName());
        } finally { parents.remove(value); }
    }

    /** Refuse hostile frame fields before StackTraceElement formats an otherwise unbounded string. */
    private static String frameText(StackTraceElement frame) throws IOException {
        long length = 64;
        for (String value : new String[]{frame.getClassName(), frame.getMethodName(), frame.getFileName(),
                frame.getModuleName(), frame.getModuleVersion(), frame.getClassLoaderName()}) {
            if (value != null) length += value.length();
            if (length > LINE_LIMIT) throw new IOException("LOG_OVERSIZE");
        }
        return frame.toString();
    }

    /** A fixed upper bound applies while Jackson writes, before constructing the encoded byte array. */
    private static final class LimitedOutput extends OutputStream {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream(1024);
        final int limit;
        LimitedOutput(int limit) { this.limit = limit; }
        @Override public void write(int value) throws IOException { check(1); bytes.write(value); }
        @Override public void write(byte[] value, int start, int length) throws IOException { check(length); bytes.write(value, start, length); }
        private void check(int count) throws IOException { if (count > limit - bytes.size()) throw new IOException("LOG_OVERSIZE"); }
    }
}
