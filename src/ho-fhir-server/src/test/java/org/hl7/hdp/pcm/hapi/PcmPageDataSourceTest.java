package org.hl7.hdp.pcm.hapi;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Pool lifecycle, native exception types, timeouts and real cancellation callback ownership. */
class PcmPageDataSourceTest {
    final DataSource pool = mock(DataSource.class);
    final Connection connection = mock(Connection.class);
    final PreparedStatement statement = mock(PreparedStatement.class);
    final PcmPageDataSource observed = new PcmPageDataSource(pool);
    final ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1);
    PcmPageDataSourceTest() throws SQLException {
        when(pool.getConnection()).thenReturn(connection);
        when(connection.prepareStatement(anyString())).thenReturn(statement);
        timer.setRemoveOnCancelPolicy(true);
    }
    @AfterEach void clearWorker() {
        var budget = PcmPageExecutor.CURRENT.get(); if (budget != null) budget.close();
        PcmPageExecutor.CURRENT.remove(); timer.shutdownNow();
    }
    @Test void wrappedPoolStillReceivesItsShutdownCallback() throws Exception {
        DataSource closeable = mock(DataSource.class, withSettings().extraInterfaces(AutoCloseable.class));
        new PcmPageDataSource(closeable).close();
        verify((AutoCloseable) closeable).close();
    }
    @Test void nonPageConnectionsAreIdenticalAndTheirPoolOwnershipIsUnchanged() throws Exception {
        assertThat(observed.getConnection()).isSameAs(connection);
        observed.getConnection().close();
        verify(connection).close(); verify(statement, never()).setQueryTimeout(anyInt());
    }
    @Test void pageStatementsKeepOriginalSqlTimeoutAndTransactionLifecycle() throws Exception {
        var cancellation = new PcmCountCancellation();
        PcmPageExecutor.CURRENT.set(new PcmPageExecutor.Budget(5000, cancellation));
        when(statement.getQueryTimeout()).thenReturn(7);
        Connection wrapped = observed.getConnection();
        wrapped.setAutoCommit(false);
        wrapped.prepareStatement("SELECT 1").execute();
        wrapped.commit(); wrapped.close();
        verify(connection).prepareStatement("SELECT 1"); verify(connection).setAutoCommit(false);
        verify(connection).commit(); verify(connection).close(); verify(statement).execute();
        verify(statement).setQueryTimeout(intThat(seconds -> seconds >= 1 && seconds <= 5));
        verify(statement).setQueryTimeout(7);
        cancellation.cancel(); verify(statement, never()).cancel();
    }
    @Test void cancellationWhileNativeExecuteIsActiveInvokesStatementCancelAndUnwinds() throws Exception {
        var cancellation = new PcmCountCancellation();
        PcmPageExecutor.CURRENT.set(new PcmPageExecutor.Budget(5000, cancellation));
        when(statement.execute()).thenAnswer(call -> { cancellation.cancel(); return false; });
        assertThatThrownBy(() -> observed.getConnection().prepareStatement("SELECT blocked").execute())
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        verify(statement).cancel(); verify(statement).setQueryTimeout(0);
    }
    @Test void streamingFetchCanBeCancelledAndOriginalJdbcFailureTypeIsPreserved() throws Exception {
        var cancellation = new PcmCountCancellation();
        PcmPageExecutor.CURRENT.set(new PcmPageExecutor.Budget(5000, cancellation));
        ResultSet rows = mock(ResultSet.class); when(statement.executeQuery()).thenReturn(rows);
        when(rows.next()).thenAnswer(call -> { cancellation.cancel(); return false; });
        ResultSet wrapped = observed.getConnection().prepareStatement("SELECT cursor").executeQuery();
        assertThatThrownBy(wrapped::next).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        verify(statement).cancel(); wrapped.close(); verify(rows).close();
        PcmPageExecutor.CURRENT.remove();
        PcmPageExecutor.CURRENT.set(new PcmPageExecutor.Budget(5000, new PcmCountCancellation()));
        SQLException nativeFailure = new SQLException("native failure"); when(connection.prepareStatement("fail")).thenThrow(nativeFailure);
        assertThatThrownBy(() -> observed.getConnection().prepareStatement("fail")).isSameAs(nativeFailure);
    }

    @Test void verifiedDeadlineActivelyCancelsBlockedStreamingFetchAndAllowsRecovery() throws Exception {
        var cancellation = new PcmCountCancellation();
        ResultSet rows = mock(ResultSet.class); when(statement.executeQuery()).thenReturn(rows);
        var cancelled = new CountDownLatch(1);
        doAnswer(call -> { cancelled.countDown(); return null; }).when(statement).cancel();
        when(rows.next()).thenAnswer(call -> {
            assertThat(cancelled.await(2, TimeUnit.SECONDS)).as("deadline must unblock native fetch").isTrue();
            return false;
        });
        var initial = new PcmPageExecutor.Budget(5000, cancellation); PcmPageExecutor.CURRENT.set(initial);
        ResultSet wrapped = observed.getConnection().prepareStatement("SELECT cursor").executeQuery(); initial.close();
        // Start the short deadline after mock/proxy setup so this test isolates blocked next(), not cold instrumentation.
        var budget = new PcmPageExecutor.Budget(250, cancellation); PcmPageExecutor.CURRENT.set(budget);
        budget.watchDeadline(timer);
        long start = System.nanoTime();
        assertThatThrownBy(wrapped::next).isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        assertThat(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start)).isLessThan(1500);
        assertThat(cancellation.isCancelled()).isTrue(); verify(statement).cancel();
        budget.close(); wrapped.close(); verify(rows).close();
        assertThat(timer.getQueue()).isEmpty();
        var recovery = new PcmPageExecutor.Budget(5000, new PcmCountCancellation());
        PcmPageExecutor.CURRENT.set(recovery); recovery.watchDeadline(timer);
        observed.getConnection().prepareStatement("SELECT recovery").execute(); recovery.close();
        verify(statement, times(1)).cancel(); assertThat(timer.getQueue()).isEmpty();
    }

    @Test void verifiedDeadlineAlsoCancelsBlockedExecuteBeforeServletTimeout() throws Exception {
        var cancelled = new CountDownLatch(1);
        doAnswer(call -> { cancelled.countDown(); return null; }).when(statement).cancel();
        when(statement.execute()).thenAnswer(call -> {
            assertThat(cancelled.await(2, TimeUnit.SECONDS)).isTrue(); throw new SQLException("cancelled by native driver");
        });
        var budget = new PcmPageExecutor.Budget(200, new PcmCountCancellation());
        PcmPageExecutor.CURRENT.set(budget);
        budget.watchDeadline(timer);
        assertThatThrownBy(() -> observed.getConnection().prepareStatement("SELECT blocked").execute())
                .isInstanceOf(SQLException.class).hasMessage("cancelled by native driver");
        verify(statement).cancel(); verify(statement).setQueryTimeout(0);
        budget.close(); assertThat(timer.getQueue()).isEmpty();
    }

    @Test void expiredBudgetRejectsBeforeSqlAndNormalCleanupRemovesDeadlineWithoutCancellingPool() throws Exception {
        var expired = new PcmPageExecutor.Budget(0, new PcmCountCancellation());
        PcmPageExecutor.CURRENT.set(expired);
        assertThatThrownBy(() -> observed.getConnection().prepareStatement("SELECT expired").execute())
                .isInstanceOf(ca.uhn.fhir.rest.server.exceptions.BaseServerResponseException.class);
        assertThat(expired.cancellation.isCancelled()).isTrue(); verify(statement, never()).execute(); expired.close();
        var normal = new PcmPageExecutor.Budget(5000, new PcmCountCancellation());
        PcmPageExecutor.CURRENT.set(normal); normal.watchDeadline(timer);
        observed.getConnection().prepareStatement("SELECT normal").execute(); normal.close();
        assertThat(timer.getQueue()).isEmpty(); normal.cancellation.cancel(); verify(statement, never()).cancel();
    }

    @Test void alreadyCapturedCancellationCannotReachAStatementAfterExecuteReturns() throws Exception {
        var cancellation = mock(PcmCountCancellation.class);
        var callback = new java.util.concurrent.atomic.AtomicReference<Runnable>();
        doAnswer(call -> { callback.set(call.getArgument(0)); return null; }).when(cancellation).bind(any());
        PcmPageExecutor.CURRENT.set(new PcmPageExecutor.Budget(5000, cancellation));
        observed.getConnection().prepareStatement("SELECT complete").execute();
        callback.get().run(); verify(statement, never()).cancel();
        verify(cancellation).unbind();
    }
}
