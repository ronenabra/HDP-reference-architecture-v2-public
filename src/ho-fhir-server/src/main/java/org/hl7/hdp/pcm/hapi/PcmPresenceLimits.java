package org.hl7.hdp.pcm.hapi;

/** Data Source-local operational limits; PCM-IG does not define national values. */
public record PcmPresenceLimits(int maxPatients, int maxPayloadBytes, long timeoutMilliseconds) {
    public PcmPresenceLimits {
        if (maxPatients < 2 || maxPatients > 10000 || maxPayloadBytes < 1 || maxPayloadBytes > 16777216 || timeoutMilliseconds < 1 || timeoutMilliseconds > 300000) {
            throw new IllegalArgumentException("Presence operational limits are invalid");
        }
    }
}
