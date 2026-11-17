package org.hl7.hdp.pcm.hapi;

import jakarta.servlet.ServletConnection;
import java.io.IOException;
import java.util.concurrent.locks.ReentrantLock;
import org.apache.tomcat.util.net.SocketWrapperBase;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Exact native connection identities, closed/recycled wrappers and retained-buffer observation. */
class PcmCountTomcatProtocolTest {
    final SocketWrapperBase<?> socket = mock(SocketWrapperBase.class);
    final ServletConnection identity = mock(ServletConnection.class);

    PcmCountTomcatProtocolTest() {
        when(socket.getServletConnection("http/1.1", "")).thenReturn(identity);
        when(identity.getConnectionId()).thenReturn("original");
        when(socket.getLock()).thenReturn(new ReentrantLock());
    }

    @Test void observesBufferedApplicationInputWithoutDrainingOrReplaying() throws Exception {
        var connection = PcmCountTomcatProtocol.connection(socket, "original");
        when(socket.isReadyForRead()).thenReturn(false, true).thenThrow(new IOException("reset"));
        assertThat(connection.lock()).isSameAs(socket.getLock());
        assertThat(connection.hasAdditionalInput()).isFalse();
        assertThat(connection.hasAdditionalInput()).isTrue();
        assertThatThrownBy(connection::hasAdditionalInput).isInstanceOf(IOException.class);
        verify(socket, times(3)).isReadyForRead();
        verify(socket, never()).getSocket();
        verify(socket, never()).getSocketBufferHandler();
    }

    @Test void closedAndRecycledWrappersAreNeverRead() throws Exception {
        var connection = PcmCountTomcatProtocol.connection(socket, "original");
        when(socket.isClosed()).thenReturn(true);
        assertThatThrownBy(connection::hasAdditionalInput).isInstanceOf(IOException.class);
        when(socket.isClosed()).thenReturn(false); when(identity.getConnectionId()).thenReturn("reused");
        assertThatThrownBy(connection::hasAdditionalInput).isInstanceOf(IOException.class);
        verify(socket, never()).isReadyForRead();
    }
}
