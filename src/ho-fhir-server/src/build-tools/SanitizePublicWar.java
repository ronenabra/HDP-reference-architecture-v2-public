import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Build-only removal of one upstream mail-test private key from the shipped WAR.
 * All application classes, other dependency entries and notices retain their bytes.
 * The final Docker stage copies only the already-sanitized complete runtime tree,
 * so an earlier layer cannot retain the removed credential.
 */
public final class SanitizePublicWar {
    private static final String JAR = "WEB-INF/lib/greenmail-2.1.0-rc-1.jar";
    private static final String KEY = "greenmail.p12";

    private SanitizePublicWar() { }

    /**
     * Sanitize a patched WAR and write a value-free provenance receipt.
     * @param arguments upstream WAR, overlaid WAR, sanitized WAR and receipt paths.
     * @throws Exception when the exact reviewed fixture is absent or processing fails.
     */
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 4) throw new IllegalArgumentException("expected upstream, overlaid, sanitized and receipt paths");
        Path upstream = Path.of(arguments[0]), original = Path.of(arguments[1]);
        Path output = Path.of(arguments[2]), receipt = Path.of(arguments[3]);
        String[] removed = new String[3];
        boolean found = false;
        try (ZipInputStream input = new ZipInputStream(Files.newInputStream(original));
                ZipOutputStream result = new ZipOutputStream(Files.newOutputStream(output))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                byte[] bytes = input.readAllBytes();
                if (JAR.equals(entry.getName())) {
                    if (found) throw new IOException("duplicate reviewed dependency");
                    found = true;
                    byte[] jar = bytes;
                    removed[0] = sha256(jar);
                    java.io.ByteArrayOutputStream sanitized = new java.io.ByteArrayOutputStream();
                    stripKey(jar, sanitized, removed);
                    byte[] safe = sanitized.toByteArray();
                    removed[1] = sha256(safe);
                    bytes = safe;
                }
                writeEntry(result, entry, bytes);
            }
        }
        if (!found || removed[2] == null) {
            Files.deleteIfExists(output);
            throw new IOException("reviewed vendor private-key fixture was not found; review the pinned dependency before changing this rule");
        }
        String json = """
                {
                  "schemaVersion": "pcm-public-hapi-sanitization/1",
                  "upstreamImage": "hapiproject/hapi:v8.10.0-3@sha256:55213612779ab3eeec919226b7bad378f0061ade823393a61d7dd46dd5087a3d",
                  "upstreamWarSha256": "%s",
                  "overlaidWarSha256": "%s",
                  "sanitizedWarSha256": "%s",
                  "removed": [{"path": "%s!%s", "sha256": "%s", "reason": "unused vendor mail-test PrivateKeyEntry; no installation may reuse it"}],
                  "dependencyBeforeSha256": "%s",
                  "dependencyAfterSha256": "%s",
                  "preservation": "all non-removed dependency entries, application classes and notices retain their uncompressed bytes; final image is flattened before publication"
                }
                """.formatted(fileSha256(upstream), fileSha256(original), fileSha256(output), JAR, KEY, removed[2], removed[0], removed[1]);
        Files.writeString(receipt, json, StandardCharsets.UTF_8);
    }

    /**
     * Preserve executable-WAR compression semantics while refreshing modified-entry metadata.
     * Spring Boot reads nested JARs directly from STORED entries and rejects DEFLATED ones.
     */
    private static void writeEntry(ZipOutputStream output, ZipEntry original, byte[] bytes) throws IOException {
        ZipEntry entry = copyEntry(original);
        entry.setMethod(original.getMethod());
        if (original.getMethod() == ZipEntry.STORED) {
            CRC32 crc = new CRC32();
            crc.update(bytes);
            entry.setSize(bytes.length);
            entry.setCompressedSize(bytes.length);
            entry.setCrc(crc.getValue());
        }
        output.putNextEntry(entry);
        output.write(bytes);
        output.closeEntry();
    }

    /** Copy ZIP identity and timestamps without reusing compression-dependent offsets. */
    private static ZipEntry copyEntry(ZipEntry original) {
        ZipEntry entry = new ZipEntry(original.getName());
        if (original.getTime() >= 0) entry.setTime(original.getTime());
        if (original.getComment() != null) entry.setComment(original.getComment());
        return entry;
    }

    /** Remove the exact reviewed keystore, retaining all other nested JAR bytes. */
    private static void stripKey(byte[] jar, OutputStream output, String[] hashes) throws Exception {
        try (ZipInputStream input = new ZipInputStream(new java.io.ByteArrayInputStream(jar));
                ZipOutputStream result = new ZipOutputStream(output)) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                if (KEY.equals(entry.getName())) {
                    if (hashes[2] != null) throw new IOException("duplicate reviewed keystore");
                    hashes[2] = sha256(input.readAllBytes());
                    continue;
                }
                writeEntry(result, entry, input.readAllBytes());
            }
        }
    }

    /** Hash one small nested dependency or fixture without exposing its bytes. */
    private static String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }

    /** Stream a complete WAR hash rather than buffering the runtime archive. */
    private static String fileSha256(Path file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int size;
            while ((size = input.read(buffer)) >= 0) digest.update(buffer, 0, size);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
