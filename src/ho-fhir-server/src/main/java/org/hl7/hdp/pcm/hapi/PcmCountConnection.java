package org.hl7.hdp.pcm.hapi;

import java.io.IOException;
import java.util.concurrent.locks.Lock;

/** Native request connection observation; implementations retain all input in Tomcat's buffers. */
interface PcmCountConnection {
    /** Serialize observation and response completion with the connector's processing lock. */
    Lock lock();

    /**
     * Observe additional application bytes without consuming them.
     *
     * @return true when pipelining prevents a reliable disconnect observation
     * @throws IOException when the original connection is closed, recycled or disconnected
     */
    boolean hasAdditionalInput() throws IOException;
}
