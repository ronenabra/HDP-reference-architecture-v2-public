package org.hl7.hdp.pcm.hapi;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.encoder.EncoderBase;
import java.util.LinkedHashMap;
import java.util.Map;

/** AWS-safe bounded stdout; this output is never collected as a second runtime source. */
public final class PcmSafeConsoleEncoder extends EncoderBase<ILoggingEvent> {
    @Override public byte[] headerBytes() { return new byte[0]; }
    @Override public byte[] footerBytes() { return new byte[0]; }
    @Override public byte[] encode(ILoggingEvent event) {
        try {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("timestamp", java.time.Instant.ofEpochMilli(event.getTimeStamp()).toString()); value.put("level", event.getLevel().toString());
            value.put("nativeLogger", event.getLoggerName()); value.put("nativeThread", event.getThreadName()); value.put("message", event.getMessage());
            value.put("arguments", event.getArgumentArray()); value.put("exception", event.getThrowableProxy());
            if (PcmQueryLimits.class.getName().equals(event.getLoggerName())
                    && PcmBudgetFailure.WARNING.equals(event.getMessage()) && event.getArgumentArray() != null
                    && event.getArgumentArray().length == 1 && event.getArgumentArray()[0] instanceof PcmBudgetFailure cause) {
                value.put("message", "PCM query budget exceeded: " + cause.message());
                value.put("arguments", new Object[]{cause.message()});
                value.put("reasonCode", PcmBudgetFailure.REASON); value.put("budgetFailure", cause.fields());
            }
            byte[] encoded = PcmBoundedJson.encode(value, PcmBoundedJson.LINE_LIMIT);
            if (new String(encoded, java.nio.charset.StandardCharsets.UTF_8).contains("[AWS_CREDENTIAL_BLOCKED]")) { value.put("awsScrubbed", true); encoded = PcmBoundedJson.encode(value, PcmBoundedJson.LINE_LIMIT); }
            return encoded;
        } catch (Exception refused) { return "{\"level\":\"WARN\",\"message\":\"Native stdout record dropped whole: encoding or size limit; raw unavailable\",\"reasonCode\":\"LOG_OVERSIZE\"}\n".getBytes(java.nio.charset.StandardCharsets.UTF_8); }
    }
}
