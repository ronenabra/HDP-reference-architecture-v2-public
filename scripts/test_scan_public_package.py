#!/usr/bin/env python3
"""Focused publication-scanner tests using only owned synthetic archive bytes."""
import importlib.util
import gzip
import hashlib
import io
import tarfile
import unittest
import zipfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("public_scanner", Path(__file__).with_name("scan-public-package.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PublicScannerTests(unittest.TestCase):
    """Prove nested and binary content cannot silently evade the public scan."""

    def test_private_material_nested_in_jar_inside_layer(self):
        """Inspect ZIP entries beneath image-layer TAR boundaries."""
        key = b"-----BEGIN " + b"PRIVATE KEY-----\n" + b"A" * 96 + b"\n-----END " + b"PRIVATE KEY-----\n"
        jar = io.BytesIO()
        with zipfile.ZipFile(jar, "w") as archive:
            archive.writestr("fixture.pem", key)
        layer = io.BytesIO()
        with tarfile.open(fileobj=layer, mode="w") as archive:
            info = tarfile.TarInfo("app.jar")
            info.size = len(jar.getvalue())
            archive.addfile(info, io.BytesIO(jar.getvalue()))
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(layer.getvalue()), "images.tar!layer.tar")
        self.assertTrue(any(item["rule"] == "private-key" and "app.jar!fixture.pem" in item["location"]
                            for item in scanner.findings))

    def test_public_certificate_and_binary_bytes_are_inspected_without_false_key(self):
        """Public trust anchors are allowed, binary AWS credentials are rejected."""
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(b"-----BEGIN CERTIFICATE-----\n" + b"A" * 96), "public.crt")
        self.assertEqual(scanner.findings, [])
        scanner.stream(io.BytesIO(b"\x00" + b"AKIA" + b"X" * 16), "binary")
        self.assertEqual(scanner.findings[0]["rule"], "aws-access-key")

    def test_expansion_limit_and_corrupt_archive_are_not_passes(self):
        """Bounds fail loudly instead of returning a skipped-content success."""
        scanner = MODULE.Scanner(max_bytes=10)
        with self.assertRaises(ValueError):
            scanner.stream(io.BytesIO(b"x" * 11), "large")
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(b"corrupt"), "bad.jar")
        self.assertEqual(scanner.findings[0]["rule"], "unsupported-or-corrupt-archive")

    def test_gzip_contents_are_read_instead_of_reencoded(self):
        """A compressed binary credential is still inspected as plain payload."""
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(gzip.compress(b"AKIA" + b"ZXCVBNMASDFGHJKL")), "nested.gz")
        self.assertEqual(scanner.findings[0]["rule"], "aws-access-key")
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(b"\x28\xb5\x2f\xfd" + b"synthetic unsupported compressed bytes"), "blobs/sha256/opaque")
        self.assertEqual(scanner.findings[0]["rule"], "uninspected-archive-format")
        self.assertFalse(scanner.report()["complete"])
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(b"\x1f\x8b\x00" + b"plain custom binary format"), "stdlib/info.spm")
        self.assertEqual(scanner.findings, [])
        scanner.stream(io.BytesIO(b"\x1f\x8b\x00" + b"invalid gzip"), "invalid.gz")
        self.assertFalse(scanner.report()["complete"])

    def test_archive_traversal_is_reported_without_extraction(self):
        """A traversal member never becomes an on-disk file."""
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr("../escape.txt", "synthetic")
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(content.getvalue()), "attachment.zip")
        self.assertEqual(scanner.findings[0]["rule"], "unsafe-archive-path")

    def test_canary_dispositions_are_value_and_source_location_bound(self):
        """A known inert test value cannot exempt unknown keys or runtime logs."""
        known = b"AKIA" + b"IOSFODNN7EXAMPLE"
        unknown = b"AKIA" + b"ZXCVBNMASDFGHJKL"
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(known), "source/redaction.test.js")
        self.assertEqual(scanner.findings, [])
        self.assertEqual(len(scanner.dispositions), 1)
        scanner.stream(io.BytesIO(known + b" " + unknown), "source/redaction.test.js")
        self.assertEqual(scanner.findings[0]["rule"], "aws-access-key")
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(known), "runtime.log")
        self.assertEqual(scanner.findings[0]["rule"], "aws-access-key")
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode="w") as archive:
            info = tarfile.TarInfo("source/redaction.test.js")
            info.size = len(known)
            archive.addfile(info, io.BytesIO(known))
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(content.getvalue()), "source.tar")
        self.assertEqual(scanner.findings, [])
        self.assertEqual(len(scanner.dispositions), 1)

    def test_example_disposition_never_accepts_a_generated_secret(self):
        """Only the declared placeholder convention is non-operational."""
        scanner = MODULE.Scanner()
        placeholder = b"PCM_A_IMPORT_CREDENTIAL=local-only-team-a-ho-a-import-0001\n"
        scanner.stream(io.BytesIO(placeholder), "source/example.env")
        self.assertEqual(scanner.findings, [])
        scanner.stream(io.BytesIO(b"PCM_A_IMPORT_CREDENTIAL=" + b"z" * 43 + b"\n"), "source/example.env")
        self.assertEqual(scanner.findings[0]["rule"], "operational-env-secret")
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(placeholder), "runtime/.env")
        self.assertEqual(scanner.findings[0]["rule"], "operational-env-secret")

    def test_crypto_vector_disposition_requires_whole_binary_member_and_exact_value(self):
        """A known-answer constant never becomes a library-wide credential exemption."""
        key = b"-----BEGIN " + b"PRIVATE KEY-----\n" + b"A" * 96 + b"\n-----END " + b"PRIVATE KEY-----"
        binary = b"synthetic compiled crypto self-test\x00" + key
        original = MODULE.GNUTLS_KNOWN_ANSWERS
        MODULE.GNUTLS_KNOWN_ANSWERS = {"member": "usr/lib/fixture.so", "binarySha256": hashlib.sha256(binary).hexdigest(),
                                     "sourceUrl": "https://example.invalid/owned-fixture", "sourceSha256": "owned-synthetic-source",
                                     "vectors": {hashlib.sha256(key).hexdigest(): "known_answer"}}
        try:
            scanner = MODULE.Scanner()
            scanner.stream(io.BytesIO(binary), "layer.tar!usr/lib/fixture.so")
            self.assertEqual(scanner.findings, [])
            self.assertEqual(scanner.dispositions[0]["rule"], "vendor-cryptographic-known-answer-vector")
            for location, data in [("runtime.log", binary), ("layer.tar!usr/lib/fixture.so", binary + b"unreviewed append"),
                                   ("layer.tar!usr/lib/fixture.so", binary + key.replace(b"A" * 96, b"B" * 96))]:
                scanner = MODULE.Scanner()
                scanner.stream(io.BytesIO(data), location)
                self.assertEqual(scanner.findings[0]["rule"], "private-key")
        finally:
            MODULE.GNUTLS_KNOWN_ANSWERS = original

    def test_compressed_named_debian_state_is_narrowly_content_bound(self):
        """Real compressed files and unknown metadata remain inspected or failed."""
        state = b"auto\n/usr/share/man/man7/builtins.7.gz\n\n/usr/share/man/man7/bash-builtins.7.gz\n10\n\n"
        member = "var/lib/dpkg/alternatives/builtins.7.gz"
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(state), "layer.tar!" + member)
        self.assertEqual(scanner.findings, [])
        self.assertTrue(scanner.report()["complete"])
        for location, data in [("unknown.gz", state), ("layer.tar!" + member, state + b"unreviewed")]:
            scanner = MODULE.Scanner()
            scanner.stream(io.BytesIO(data), location)
            self.assertEqual(scanner.findings[0]["rule"], "unsupported-or-corrupt-archive")
        scanner = MODULE.Scanner()
        scanner.stream(io.BytesIO(gzip.compress(b"AKIA" + b"ZXCVBNMASDFGHJKL")), "layer.tar!" + member)
        self.assertEqual(scanner.findings[0]["rule"], "aws-access-key")


if __name__ == "__main__":
    unittest.main()
