package org.hl7.hdp.pcm.hapi;

import jakarta.servlet.ServletConnection;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.locks.Lock;
import org.apache.coyote.http11.Http11NioProtocol;
import org.apache.tomcat.util.net.NioEndpoint;
import org.apache.tomcat.util.net.SocketWrapperBase;

/** Standard pinned NIO connector with public, request-bound COUNT connection observation. */
public final class PcmCountTomcatProtocol extends Http11NioProtocol {
    private static final Set<PcmCountTomcatProtocol> ACTIVE = new CopyOnWriteArraySet<>();
    private final NioEndpoint endpoint;

    /** Spring/Tomcat constructs this protocol through its public no-argument extension point. */
    public PcmCountTomcatProtocol() { this(new NioEndpoint()); }

    /** Retain the same endpoint passed to the standard HTTP/1 NIO protocol. */
    private PcmCountTomcatProtocol(NioEndpoint endpoint) {
        super(endpoint);
        this.endpoint = endpoint;
    }

    /** Register only live service endpoints, including a separately configured management connector. */
    @Override public void init() throws Exception {
        super.init();
        ACTIVE.add(this);
    }

    /** Remove endpoint references even if connector shutdown fails. */
    @Override public void destroy() throws Exception {
        try { super.destroy(); } finally { ACTIVE.remove(this); }
    }

    /** Find only the exact ServletConnection that supplied this verified request. */
    static PcmCountConnection connection(HttpServletRequest request) {
        ServletConnection connection = request.getServletConnection();
        if (connection == null || !"http/1.1".equalsIgnoreCase(connection.getProtocol())) {
            throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("PCM count connection unavailable");
        }
        String id = connection.getConnectionId();
        for (PcmCountTomcatProtocol protocol : ACTIVE) {
            for (SocketWrapperBase<?> socket : protocol.endpoint.getConnections()) {
                if (id.equals(socket.getServletConnection("http/1.1", "").getConnectionId())) {
                    return connection(socket, id);
                }
            }
        }
        throw new ca.uhn.fhir.rest.server.exceptions.InternalErrorException("PCM count connection unavailable");
    }

    /** Bind observation to an immutable connection identity, guarding wrapper reuse and closure. */
    static PcmCountConnection connection(SocketWrapperBase<?> socket, String expectedId) {
        return new PcmCountConnection() {
            @Override public Lock lock() { return socket.getLock(); }
            @Override public boolean hasAdditionalInput() throws IOException {
                if (socket.isClosed() || !expectedId.equals(socket.getServletConnection("http/1.1", "").getConnectionId())) {
                    throw new IOException("PCM count connection ended");
                }
                // This reads only through the connector's retained input buffer. It never
                // drains, replays or parses a later request, and TLS control bytes are not application data.
                return socket.isReadyForRead();
            }
        };
    }
}
