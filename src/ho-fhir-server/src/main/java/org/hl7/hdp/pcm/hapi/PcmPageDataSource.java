package org.hl7.hdp.pcm.hapi;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import javax.sql.DataSource;
import org.springframework.jdbc.datasource.DelegatingDataSource;

/** Supported JDBC proxies observe PAGE statements while preserving native pool and transaction ownership. */
final class PcmPageDataSource extends DelegatingDataSource implements AutoCloseable {
    /** Keep the existing initialized pool and all DataSource configuration/unwrap behavior. */
    PcmPageDataSource(DataSource target) { super(target); }

    /** Preserve Spring's inferred pool shutdown lifecycle after wrapping its DataSource bean. */
    @Override public void close() throws Exception {
        if (getTargetDataSource() instanceof AutoCloseable closeable) closeable.close();
    }

    /** Outside a PAGE worker return the original connection unchanged. */
    @Override public Connection getConnection() throws SQLException { return observe(super.getConnection()); }
    /** Preserve the explicit-credential DataSource contract. */
    @Override public Connection getConnection(String username, String password) throws SQLException {
        return observe(super.getConnection(username, password));
    }

    /** Pool close, commit, rollback, autoCommit and enlistment calls delegate exactly once. */
    private static Connection observe(Connection connection) {
        if (PcmPageExecutor.CURRENT.get() == null) return connection;
        return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class},
                (proxy, method, arguments) -> {
                    Object result = invoke(connection, method, arguments);
                    if (result instanceof Statement statement && method.getName().matches("prepareStatement|prepareCall|createStatement")) {
                        Class<?> type = statement instanceof java.sql.CallableStatement ? java.sql.CallableStatement.class
                                : statement instanceof java.sql.PreparedStatement ? java.sql.PreparedStatement.class : Statement.class;
                        return Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                                (statementProxy, statementMethod, statementArguments) -> execute(statement, statementMethod, statementArguments));
                    }
                    return result;
                });
    }

    /** Native statements retain their SQL/parameters; only deadline and active cancellation are added. */
    private static Object execute(Statement statement, Method method, Object[] arguments) throws Throwable {
        PcmPageExecutor.Budget budget = PcmPageExecutor.CURRENT.get();
        if (budget == null) return invoke(statement, method, arguments);
        if (!method.getName().startsWith("execute")) return observeResult(invoke(statement, method, arguments), statement);
        budget.check();
        long remaining = budget.deadline - System.nanoTime();
        int previousTimeout = statement.getQueryTimeout();
        statement.setQueryTimeout(Math.max(1, (int) ((remaining + 999_999_999) / 1_000_000_000)));
        ActiveCall active = new ActiveCall(statement);
        budget.cancellation.bind(active::cancel);
        try {
            budget.check();
            Object result = invoke(statement, method, arguments);
            budget.check();
            return observeResult(result, statement);
        } finally {
            active.close();
            budget.cancellation.unbind();
            if (!statement.isClosed()) statement.setQueryTimeout(previousTimeout);
        }
    }

    /** Cover cursor fetches too: a streaming ResultSet can block after executeQuery returns. */
    private static Object observeResult(Object result, Statement statement) {
        if (!(result instanceof java.sql.ResultSet rows)) return result;
        return Proxy.newProxyInstance(java.sql.ResultSet.class.getClassLoader(), new Class<?>[]{java.sql.ResultSet.class},
                (proxy, method, arguments) -> {
                    PcmPageExecutor.Budget budget = PcmPageExecutor.CURRENT.get();
                    if (budget == null || !"next".equals(method.getName())) return invoke(rows, method, arguments);
                    budget.check();
                    ActiveCall active = new ActiveCall(statement);
                    budget.cancellation.bind(active::cancel);
                    try { Object value = invoke(rows, method, arguments); budget.check(); return value; }
                    finally { active.close(); budget.cancellation.unbind(); }
                });
    }

    /** A captured timer/transport callback cannot cancel a statement after native ownership resumes. */
    private static final class ActiveCall implements AutoCloseable {
        private final Statement statement;
        private boolean active = true;
        ActiveCall(Statement statement) { this.statement = statement; }
        synchronized void cancel() {
            if (!active) return;
            active = false;
            try { statement.cancel(); }
            catch (SQLException alreadyClosed) { /* Native cleanup retains close and pool ownership. */ }
        }
        /** Await an already-running cancellation before a statement can be closed or returned to its pool. */
        @Override public synchronized void close() { active = false; }
    }

    /** Preserve JDBC's original exception type instead of wrapping it in a reflection exception. */
    private static Object invoke(Object target, Method method, Object[] arguments) throws Throwable {
        try { return method.invoke(target, arguments); }
        catch (InvocationTargetException failed) { throw failed.getCause(); }
    }
}
