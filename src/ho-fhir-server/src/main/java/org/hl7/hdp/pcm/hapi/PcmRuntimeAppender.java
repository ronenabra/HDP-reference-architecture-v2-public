package org.hl7.hdp.pcm.hapi;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.UnsynchronizedAppenderBase;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Dedicated per-HO bounded async JSONL writer; failures cannot escape into clinical handling. */
public final class PcmRuntimeAppender extends UnsynchronizedAppenderBase<ILoggingEvent> {
    static final int MAX_ENTRIES = 1024, MAX_BYTES = 8 * 1024 * 1024;
    static final long ROTATE_BYTES = 10L * 1024 * 1024, RETAIN_BYTES = 250L * 1024 * 1024;
    private final java.util.concurrent.ConcurrentLinkedDeque<Entry> queue = new java.util.concurrent.ConcurrentLinkedDeque<>();
    private final AtomicLong rotationSequence = new AtomicLong();
    private Runnable beforeWrite = () -> { };
    void setBeforeWrite(Runnable value) { beforeWrite = value; }
    private final AtomicLong sequence = new AtomicLong();
    private final String processId = UUID.randomUUID().toString();
    private final String hoId = System.getenv().getOrDefault("HO_ID", "unavailable");
    private Path directory = Path.of("/runtime/logs/hapi-runtime");
    private Clock clock = Clock.systemUTC();
    private String currentDay;
    // One CAS reserves both entry count (upper32) and encoded bytes (lower32).
    // A preempted writer never holds a lock needed by an HTTP producer.
    private final AtomicLong queuedBudget = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong(), failures = new AtomicLong(), pendingLoss = new AtomicLong();
    private volatile long lastSuccess;
    private boolean writeFailurePending;
    private final Map<String,AtomicLong> lossCounts = Map.of("LOG_OVERSIZE",new AtomicLong(), "LOG_DEPTH_LIMIT",new AtomicLong(),
            "LOG_ENCODING_FAILED",new AtomicLong(), "LOG_QUEUE_OVERFLOW",new AtomicLong(), "LOG_WRITE_FAILED",new AtomicLong());
    private String lossReason = "unknown";
    private final boolean enabled = !"false".equalsIgnoreCase(System.getenv("PCM_HAPI_OBSERVABILITY_ENABLED"));
    private volatile boolean running;
    private Thread worker;

    /** Logback owns a fixed source path; tests may select an owned temporary directory. */
    public void setDirectory(String value) { directory = Path.of(value); }
    void setClock(Clock value) { clock = value; }

    @Override public void start() {
        if (!enabled) {
            super.start();
            try { writeHealth(); } catch (IOException unavailable) { System.err.println("PCM HAPI diagnostic disabled-state readout unavailable"); }
            return;
        }
        running = true; super.start();
        worker = new Thread(this::drain, "pcm-hapi-diagnostics"); worker.setDaemon(true); worker.start();
    }

    @Override protected void append(ILoggingEvent event) {
        if (!enabled) return;
        try {
            boolean structured = "org.hl7.hdp.pcm.hapi.PcmRuntimeObservability".equals(event.getLoggerName());
            if (!structured && !selected(event)) return;
            Map<String, Object> record = base(event.getLevel().toString(), structured ? "HAPI decision" : "HAPI native runtime warning/error");
            Map<String, Object> details = new LinkedHashMap<>();
            if (structured && event.getArgumentArray() != null && event.getArgumentArray().length == 1 && event.getArgumentArray()[0] instanceof Map<?, ?> supplied) {
                for (var entry : supplied.entrySet()) if (entry.getKey() instanceof String key) details.put(key, entry.getValue());
            } else {
                details.put("type", event.getLevel().isGreaterOrEqual(Level.ERROR) && (event.getLoggerName().equals("org.springframework.boot.SpringApplication") || event.getLoggerName().contains("LoggingFailureAnalysisReporter")) ? "HAPI_STARTUP_FAILED" : "HAPI_NATIVE_DIAGNOSTIC"); details.put("nativeMessage", event.getMessage());
                details.put("arguments", event.getArgumentArray()); details.put("exception", event.getThrowableProxy());
                details.putAll(event.getMDCPropertyMap());
            }
            details.put("nativeLogger", event.getLoggerName()); details.put("nativeThread", event.getThreadName());
            if (PcmQueryLimits.class.getName().equals(event.getLoggerName())
                    && PcmBudgetFailure.WARNING.equals(event.getMessage()) && event.getArgumentArray() != null
                    && event.getArgumentArray().length == 1 && event.getArgumentArray()[0] instanceof PcmBudgetFailure cause) {
                details.put("reasonCode", PcmBudgetFailure.REASON); details.put("budgetFailure", cause.fields());
                details.put("arguments", new Object[]{cause.message()});
                record.put("message", "PCM query budget exceeded: " + cause.message());
            }
            details.put("healthOrganizationId", hoId); details.put("visibility", "default");
            record.put("details", details);
            String type = String.valueOf(details.get("type"));
            if (structured) record.put("message", type + (details.get("reasonCode") == null ? "" : " · " + details.get("reasonCode")) + (details.get("outcome") == null ? "" : " · " + details.get("outcome")));
            if (structured && "HAPI_ERROR".equals(type) && PcmBudgetFailure.REASON.equals(details.get("reasonCode"))
                    && details.get("message") instanceof String message && message.length() <= 256) record.put("message", message);
            boolean verbose = "HAPI_RESOURCE_DECISION".equals(type);
            envelope(record, details);
            byte[] encoded = PcmBoundedJson.encode(record, verbose ? PcmBoundedJson.EXPLANATION_LIMIT : PcmBoundedJson.LINE_LIMIT);
            // Re-encoding a bounded record establishes an explicit transformation label.
            String raw = new String(encoded, java.nio.charset.StandardCharsets.UTF_8);
            if (raw.contains("[AWS_CREDENTIAL_BLOCKED]")) { record.put("awsScrubbed", true); encoded = PcmBoundedJson.encode(record, verbose ? PcmBoundedJson.EXPLANATION_LIMIT : PcmBoundedJson.LINE_LIMIT); }
            offer(new Entry(encoded, verbose));
        } catch (Exception refused) { lost(refused.getMessage() != null && refused.getMessage().startsWith("LOG_DEPTH") ? "LOG_DEPTH_LIMIT" : refused.getMessage() != null && refused.getMessage().startsWith("Unsupported native") ? "LOG_ENCODING_FAILED" : "LOG_OVERSIZE"); }
    }

    private static boolean selected(ILoggingEvent event) {
        String logger = event.getLoggerName();
        return !logger.startsWith("org.hibernate.SQL") && !logger.startsWith("org.hibernate.orm.jdbc.bind") && !logger.startsWith("org.hibernate.type.descriptor") && event.getLevel().isGreaterOrEqual(Level.WARN) && (logger.startsWith("ca.uhn.fhir.") || logger.startsWith("org.springframework.") || logger.startsWith("org.hibernate.") || logger.startsWith("org.hl7.hdp.pcm."));
    }

    private Map<String, Object> base(String level, String message) {
        Map<String, Object> result = new LinkedHashMap<>(); result.put("timestamp", clock.instant().toString());
        result.put("level", level); result.put("message", message); result.put("processId", processId);
        long number = sequence.incrementAndGet(); result.put("sequence", number); result.put("id", processId + ":" + number); return result;
    }
    private void envelope(Map<String,Object> record, Map<String,Object> details) {
        details.put("healthOrganizationId", hoId);
        // Purpose controls display; native warnings, filtering summaries and loss remain ordinary.
        details.put("visibility", java.util.Set.of("HAPI_STARTUP_READY", "HAPI_RESOURCE_DECISION").contains(String.valueOf(details.get("type"))) ? "diagnostic" : "default");
        record.put("details", details);
        record.put("event", Map.of("schemaVersion", "1.0", "eventName", String.valueOf(details.get("type")),
                "source", Map.of("componentId", hoId + "-hapi-runtime", "role", "hapi", "healthOrganizationId", hoId),
                "correlation", correlation(details), "provenance", Map.of("kind", "emitted")));
    }
    private static Map<String, Object> correlation(Map<String, Object> details) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String key : new String[]{"flowId", "correlationId", "traceId", "spanId", "parentSpanId", "traceFlags"}) if (details.get(key) != null) result.put(key, details.get(key));
        return result;
    }
    private void lost(String reason) { dropped.incrementAndGet(); pendingLoss.incrementAndGet(); lossCounts.get(reason).incrementAndGet(); lossReason = reason; java.util.concurrent.locks.LockSupport.unpark(worker); }
    private void offer(Entry entry) {
        if (!running) { lost("LOG_WRITE_FAILED"); return; }
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(5);
        while (true) {
            long budget = queuedBudget.get();
            int entries = (int)(budget >>> 32), bytes = (int)budget;
            if (entries >= MAX_ENTRIES || bytes + entry.bytes.length > MAX_BYTES) {
                boolean evicted = false;
                if (!entry.verbose) for (Entry old : queue) {
                    if (old.verbose && queue.remove(old)) {
                        queuedBudget.addAndGet(-reservation(old)); lost("LOG_QUEUE_OVERFLOW"); evicted = true; break;
                    }
                }
                if (!evicted) { lost("LOG_QUEUE_OVERFLOW"); return; }
                continue;
            } else if (queuedBudget.compareAndSet(budget, budget + reservation(entry))) {
                queue.addLast(entry); java.util.concurrent.locks.LockSupport.unpark(worker); return;
            }
            if (System.nanoTime() >= deadline) { lost("LOG_QUEUE_OVERFLOW"); return; }
        }
    }
    private static long reservation(Entry entry) { return (1L << 32) + entry.bytes.length; }
    private void drain() {
        while (running || (queuedBudget.get() >>> 32) > 0 || pendingLoss.get() > 0) {
            Entry next;
            next = queue.pollFirst();
            if (next != null) queuedBudget.addAndGet(-reservation(next));
            if (next == null && (running || (queuedBudget.get() >>> 32) > 0)) java.util.concurrent.locks.LockSupport.parkNanos(java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(250));
            try {
                if (next != null) { write(next.bytes); lastSuccess = clock.millis(); }
                writeHealth();
            } catch (Exception error) {
                writeFailurePending = true; failures.incrementAndGet(); if (next != null) lost("LOG_WRITE_FAILED");
                // Fixed, credential-free warning; never call a logger from its appender.
                if (failures.get() == 1 || failures.get() % 100 == 0) System.err.println("PCM HAPI runtime diagnostics unavailable; diagnostic records may be lost");
                if (!running) break;
            }
        }
    }
    private void write(byte[] bytes) throws IOException {
        beforeWrite.run();
        safeDirectory(directory); Path current = directory.resolve("current.log");
        if (Files.isSymbolicLink(current)) throw new IOException("Diagnostic current file is a symlink");
        String today = clock.instant().atOffset(ZoneOffset.UTC).toLocalDate().toString();
        if (currentDay == null && Files.exists(current)) currentDay = Files.getLastModifiedTime(current).toInstant().atOffset(ZoneOffset.UTC).toLocalDate().toString();
        if (Files.exists(current) && Files.size(current) > 0 && (Files.size(current) + bytes.length > ROTATE_BYTES
                || !today.equals(currentDay))) {
            Path archive = directory.resolve("history").resolve(Instant.ofEpochMilli(clock.millis()).toString().replace(':', '-') + "-" + String.format("%016d", rotationSequence.incrementAndGet()) + "-" + processId);
            safeDirectory(archive); Files.move(current, archive.resolve("app.log"));
        }
        retain(bytes.length);
        Files.write(current, bytes, StandardOpenOption.CREATE, StandardOpenOption.APPEND); currentDay = today;
    }
    private static void safeDirectory(Path target) throws IOException {
        Path absolute = target.toAbsolutePath(); Path cursor = absolute.getRoot();
        for (Path part : absolute) { cursor = cursor.resolve(part); if (Files.isSymbolicLink(cursor)) throw new IOException("Diagnostic path is a symlink"); }
        Files.createDirectories(target);
    }
    private void retain(int incomingBytes) throws IOException {
        Path history = directory.resolve("history"); if (!Files.exists(history)) return; safeDirectory(history);
        try (var paths = Files.list(history)) {
            var rotations = paths.sorted(Comparator.comparing(path -> path.getFileName().toString())).toList();
            long total = (Files.exists(directory.resolve("current.log")) ? Files.size(directory.resolve("current.log")) : 0) + incomingBytes + 4096;
            for (Path path : rotations) { if (Files.isSymbolicLink(path) || Files.isSymbolicLink(path.resolve("app.log"))) throw new IOException("Diagnostic rotation is a symlink"); total += Files.size(path.resolve("app.log")); }
            for (Path path : rotations) {
                Path file = path.resolve("app.log");
                boolean expired = Files.getLastModifiedTime(file).toMillis() < clock.millis() - 5L * 86400000;
                if (expired || total > RETAIN_BYTES) { total -= Files.size(file); Files.delete(file); Files.delete(path); }
            }
        }
    }
    private void writeHealth() throws IOException {
        long loss; String reason;
        loss = pendingLoss.get(); reason = lossReason;
        if (loss > 0) {
            Map<String, Object> marker = base("WARN", "HAPI diagnostic records lost; raw/export unavailable for dropped records");
            envelope(marker, new LinkedHashMap<>(Map.of("type", writeFailurePending ? "HAPI_LOG_RECOVERY" : "HAPI_LOG_LOSS",
                    "reasonCode", writeFailurePending ? "LOG_RECOVERED" : reason, "lossReason", reason, "count", loss, "lastSuccessEpochMs", lastSuccess, "visibility", "default")));
            @SuppressWarnings("unchecked") Map<String,Object> lossDetails = (Map<String,Object>) marker.get("details");
            Map<String,Long> reasonCounts = new LinkedHashMap<>(); lossCounts.forEach((key,value) -> reasonCounts.put(key,value.get()));
            lossDetails.put("cumulativeReasonCounts", reasonCounts); lossDetails.put("lossReasonIsLatest", true);
            write(PcmBoundedJson.encode(marker, 4096));
            writeFailurePending = false; pendingLoss.addAndGet(-loss);
        }
        safeDirectory(directory); Path health = directory.resolve("health.json");
        if (Files.isSymbolicLink(health)) throw new IOException("Diagnostic health file is a symlink");
        Files.write(health, PcmBoundedJson.encode(health(), 4096));
    }
    /** Bounded counters describe diagnostics only, never authorization or lossless auditing. */
    public Map<String, Object> health() {
        return Map.of("observedAtEpochMs", clock.millis(), "queuedEntries", (int)(queuedBudget.get() >>> 32), "queuedBytes", (int)queuedBudget.get(), "dropped", dropped.get(), "writeFailures", failures.get(),
                "lastSuccessEpochMs", lastSuccess, "pendingLoss", pendingLoss.get(), "state", !enabled ? "disabled" : pendingLoss.get() > 0 ? "loss" : "available");
    }
    @Override public void stop() { running = false; java.util.concurrent.locks.LockSupport.unpark(worker); if (worker != null) try { worker.join(1000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } super.stop(); }
    private record Entry(byte[] bytes, boolean verbose) { }
}
