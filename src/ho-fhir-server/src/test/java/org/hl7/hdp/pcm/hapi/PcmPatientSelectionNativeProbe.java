package org.hl7.hdp.pcm.hapi;

import java.nio.file.Files;
import java.nio.file.Path;
import org.hibernate.resource.jdbc.spi.StatementInspector;
import org.hibernate.boot.SessionFactoryBuilder;
import org.hibernate.boot.spi.MetadataImplementor;
import org.hibernate.boot.spi.SessionFactoryBuilderFactory;
import org.hibernate.boot.spi.SessionFactoryBuilderImplementor;

/** Disposable-only SQL barriers; this test class is never included in the production WAR. */
public class PcmPatientSelectionNativeProbe implements SessionFactoryBuilderFactory {
    /** Observe exactly the owning PAGE worker and coordinate its actual projection statements. */
    @Override public SessionFactoryBuilder getSessionFactoryBuilder(MetadataImplementor metadata,
            SessionFactoryBuilderImplementor builder) {
        org.slf4j.LoggerFactory.getLogger(getClass()).info("PCM disposable Patient selection SQL probe installed");
        return builder.applyStatementInspector((StatementInspector) sql -> {
            var budget = PcmPageExecutor.CURRENT.get();
            if (budget == null || budget.request == null) return sql;
            String correlation = budget.request.getHeader("X-Correlation-Id");
            if (correlation == null) return sql;
            String lower = sql.toLowerCase();
            if (correlation.startsWith("patient-review-cost-") && lower.startsWith("select")) {
                String key = getClass().getName() + ".sqlCount";
                int count = (Integer) budget.request.getUserData().getOrDefault(key, 0);
                budget.request.getUserData().put(key, count + 1);
                if (count < 16) {
                    try { Files.writeString(Path.of(System.getenv("PCM_PATIENT_REVIEW_CONTROL"), "cost-sql.txt"),
                            correlation + " ids=" + budget.ids.get() + " " + sql.substring(0, Math.min(8192, sql.length())) + "\n",
                            java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); }
                    catch (java.io.IOException failed) { throw new IllegalStateException(failed); }
                }
            }
            if (!lower.contains("hfj_res_link")) return sql;
            if (correlation.startsWith("patient-review-snapshot")) {
                try {
                    Files.writeString(Path.of(System.getenv("PCM_PATIENT_REVIEW_CONTROL"), "snapshot-sql.txt"),
                            "ids=" + budget.ids.get() + " " + sql + "\n",
                            java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
                    // Read the actual bound Hibernate connection, rather than inferring isolation
                    // from a transaction annotation or a different maintenance connection.
                    for (Object resource : org.springframework.transaction.support.TransactionSynchronizationManager.getResourceMap().values()) {
                        if (resource instanceof org.springframework.orm.jpa.EntityManagerHolder holder) {
                            holder.getEntityManager().unwrap(org.hibernate.Session.class).doWork(connection -> {
                                try (var statement = connection.createStatement(); var rows = statement.executeQuery(
                                        "select pg_backend_pid(), current_setting('transaction_isolation'), pg_current_xact_id()::text, pg_current_snapshot()::text")) {
                                    rows.next();
                                    try { Files.writeString(Path.of(System.getenv("PCM_PATIENT_REVIEW_CONTROL"), "snapshot-connections.txt"),
                                            rows.getInt(1) + "|" + rows.getString(2) + "|" + rows.getString(3) + "|" + rows.getString(4) + "\n",
                                            java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND); }
                                    catch (java.io.IOException failed) { throw new IllegalStateException(failed); }
                                }
                            });
                        }
                    }
                } catch (java.io.IOException failed) { throw new IllegalStateException(failed); }
            }
            if (correlation.startsWith("patient-review-snapshot") && lower.contains("target_resource_url")) {
                barrier("snapshot");
            } else if (correlation.matches("patient-review-concurrent-[ab](?:-[0-9a-f-]{36})?") && !lower.contains("target_resource_url")) {
                barrier(correlation.startsWith("patient-review-concurrent-a") ? "concurrent-a" : "concurrent-b");
            }
            return sql;
        });
    }

    /** Bounded, file-owned handshake; native test orchestration releases it after the exact event. */
    private static void barrier(String name) {
        Path root = Path.of(System.getenv("PCM_PATIENT_REVIEW_CONTROL"));
        try {
            Files.writeString(root.resolve(name + "-ready"), "ready");
            long deadline = System.nanoTime() + 5_000_000_000L;
            while (!Files.exists(root.resolve(name + "-release"))) {
                if (System.nanoTime() >= deadline) throw new IllegalStateException("Native test barrier expired: " + name);
                Thread.sleep(10);
            }
        } catch (java.io.IOException failed) {
            throw new IllegalStateException("Native test barrier unavailable", failed);
        } catch (InterruptedException cancelled) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Native test barrier interrupted", cancelled);
        }
    }
}
