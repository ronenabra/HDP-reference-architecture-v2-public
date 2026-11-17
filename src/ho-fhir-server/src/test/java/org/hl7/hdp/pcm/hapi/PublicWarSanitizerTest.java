package org.hl7.hdp.pcm.hapi;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.InvocationTargetException;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import javax.tools.ToolProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Build-tool security regressions without depending on a live service or reusable key. */
class PublicWarSanitizerTest {
    @TempDir Path temporary;

    /** Compile the standalone JDK-only build tool and invoke its actual CLI implementation. */
    private void sanitize(Path original, Path safe, Path receipt) throws Exception {
        Path classes = temporary.resolve("classes");
        Files.createDirectories(classes);
        int status = ToolProvider.getSystemJavaCompiler().run(null, null, null, "-d", classes.toString(),
                "src/build-tools/SanitizePublicWar.java");
        assertThat(status).isZero();
        try (URLClassLoader loader = new URLClassLoader(new java.net.URL[] { classes.toUri().toURL() })) {
            try {
                loader.loadClass("SanitizePublicWar").getMethod("main", String[].class)
                        .invoke(null, (Object) new String[] { original.toString(), original.toString(), safe.toString(), receipt.toString() });
            } catch (InvocationTargetException error) {
                if (error.getCause() instanceof Exception cause) throw cause;
                throw error;
            }
        }
    }

    /** Build controlled ZIP entries; fixture bytes are deliberately not real credentials. */
    private static byte[] zip(Map<String, byte[]> entries) throws Exception {
        return zip(entries, false);
    }

    /** Model the upstream executable WAR's uncompressed nested dependency entries. */
    private static byte[] zip(Map<String, byte[]> entries, boolean stored) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream output = new ZipOutputStream(bytes)) {
            for (Map.Entry<String, byte[]> value : entries.entrySet()) {
                ZipEntry entry = new ZipEntry(value.getKey());
                if (stored) {
                    CRC32 crc = new CRC32();
                    crc.update(value.getValue());
                    entry.setMethod(ZipEntry.STORED);
                    entry.setSize(value.getValue().length);
                    entry.setCompressedSize(value.getValue().length);
                    entry.setCrc(crc.getValue());
                }
                output.putNextEntry(entry);
                output.write(value.getValue());
                output.closeEntry();
            }
        }
        return bytes.toByteArray();
    }

    @Test
    void removesOnlyReviewedPrivateFixtureAndPreservesApplicationAndLicenseBytes() throws Exception {
        byte[] license = "synthetic attribution that must survive".getBytes(StandardCharsets.UTF_8);
        Map<String, byte[]> dependency = new LinkedHashMap<>();
        dependency.put("greenmail.p12", new byte[] { 1, 2, 3, 4 });
        dependency.put("META-INF/LICENSE", license);
        dependency.put("com/example/Unchanged.class", new byte[] { 5, 6, 7 });
        Path original = temporary.resolve("original.war"), safe = temporary.resolve("safe.war"), receipt = temporary.resolve("receipt.json");
        Files.write(original, zip(Map.of("WEB-INF/lib/greenmail-2.1.0-rc-1.jar", zip(dependency),
                "WEB-INF/classes/ActualApplication.class", new byte[] { 8, 9 })));
        sanitize(original, safe, receipt);
        try (ZipFile war = new ZipFile(safe.toFile())) {
            assertThat(war.getInputStream(war.getEntry("WEB-INF/classes/ActualApplication.class")).readAllBytes()).containsExactly(8, 9);
            Path jar = temporary.resolve("sanitized.jar");
            Files.write(jar, war.getInputStream(war.getEntry("WEB-INF/lib/greenmail-2.1.0-rc-1.jar")).readAllBytes());
            try (ZipFile contents = new ZipFile(jar.toFile())) {
                assertThat(contents.getEntry("greenmail.p12")).isNull();
                assertThat(contents.getInputStream(contents.getEntry("META-INF/LICENSE")).readAllBytes()).isEqualTo(license);
                assertThat(contents.getInputStream(contents.getEntry("com/example/Unchanged.class")).readAllBytes()).containsExactly(5, 6, 7);
            }
        }
        assertThat(Files.readString(receipt)).contains("pcm-public-hapi-sanitization/1", "sanitizedWarSha256", "dependencyBeforeSha256", "greenmail.p12");
        assertThat(Files.readString(receipt)).doesNotContain("synthetic attribution");
    }


    @Test
    void preservesStoredExecutableWarLibrariesAndRecomputesChangedSizeAndCrc() throws Exception {
        byte[] nested = zip(Map.of("greenmail.p12", new byte[] { 1, 2, 3, 4 },
                "META-INF/NOTICE", new byte[] { 6, 7 }), true);
        byte[] untouched = zip(Map.of("org/example/Library.class", new byte[] { 9, 10 }));
        Path original = temporary.resolve("executable.war"), safe = temporary.resolve("executable-safe.war");
        Files.write(original, zip(Map.of("WEB-INF/lib/greenmail-2.1.0-rc-1.jar", nested,
                "WEB-INF/lib/untouched.jar", untouched), true));
        sanitize(original, safe, temporary.resolve("stored-receipt.json"));
        try (ZipFile war = new ZipFile(safe.toFile())) {
            ZipEntry changed = war.getEntry("WEB-INF/lib/greenmail-2.1.0-rc-1.jar");
            ZipEntry retained = war.getEntry("WEB-INF/lib/untouched.jar");
            assertThat(changed.getMethod()).isEqualTo(ZipEntry.STORED);
            assertThat(retained.getMethod()).isEqualTo(ZipEntry.STORED);
            assertThat(war.getInputStream(retained).readAllBytes()).isEqualTo(untouched);
            byte[] bytes = war.getInputStream(changed).readAllBytes();
            CRC32 crc = new CRC32();
            crc.update(bytes);
            assertThat(changed.getSize()).isEqualTo(bytes.length);
            assertThat(changed.getCompressedSize()).isEqualTo(bytes.length);
            assertThat(changed.getCrc()).isEqualTo(crc.getValue());
            Path jar = temporary.resolve("stored-sanitized.jar");
            Files.write(jar, bytes);
            try (ZipFile dependency = new ZipFile(jar.toFile())) {
                assertThat(dependency.getEntry("META-INF/NOTICE").getMethod()).isEqualTo(ZipEntry.STORED);
                assertThat(dependency.getEntry("greenmail.p12")).isNull();
            }
        }
    }

    @Test
    void refusesMissingReviewedFixtureInsteadOfClaimingAnUninspectedUpstreamUpgradeIsSafe() throws Exception {
        Path original = temporary.resolve("original.war"), safe = temporary.resolve("safe.war");
        Files.write(original, zip(Map.of("WEB-INF/classes/ActualApplication.class", new byte[] { 8, 9 })));
        assertThatThrownBy(() -> sanitize(original, safe, temporary.resolve("receipt.json")))
                .hasMessageContaining("reviewed vendor private-key fixture was not found");
        assertThat(safe).doesNotExist();
    }
}
