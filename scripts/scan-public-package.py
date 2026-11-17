#!/usr/bin/env python3
"""Scan public bytes, nested archives and every image layer without extracting paths.

The report contains locations and rule names only, never credential values. This
publication check is separate from intentionally full-fidelity local diagnostics.
"""
import argparse
import bz2
import gzip
import hashlib
import io
import json
import lzma
import re
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


RULES = (
    ("private-key", re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----")),
    ("aws-access-key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("github-token", re.compile(rb"\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("signed-jwt", re.compile(rb"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{64,}\b")),
    ("pcm-opaque-credential", re.compile(rb"\bpcm-(?:token|code|request)-[A-Za-z0-9_-]{40,}\b")),
    ("operational-env-secret", re.compile(rb"(?m)^(?:TEAM_ADMIN_PASSWORD|PCM_[ABC]_(?:DB_PASSWORD|IMPORT_CREDENTIAL)|PCM_POSTGRES_ADMIN_PASSWORD)=[A-Za-z0-9_/-]{32,}\s*$")),
)

# These published, deliberately inert values test AWS redaction. They are never
# accepted in runtime logs or as arbitrary exceptions for operational material.
INERT_AWS_FIXTURES = {b"AKIA" + b"IOSFODNN7EXAMPLE", b"AKIA" + b"ABCDEFGHIJKLMNOP", b"AKIA" + b"1234567890123456"}

# Immutable vendor known-answer vectors are not operational identities. Both the
# complete reviewed binary and each matched value must agree; this never exempts
# a library, arbitrary key, appended material, or future changed vendor build.
GNUTLS_KNOWN_ANSWERS = {
    "member": "usr/lib/x86_64-linux-gnu/libgnutls.so.30.40.3",
    "binarySha256": "32b71cd21f8d8ac659dfc59852a1457f83e5b6082afbfbbe5ca03f648f922a09",
    "sourceUrl": "https://raw.githubusercontent.com/gnutls/gnutls/477a733247460b94cd2b37a10579c27ca6fc196f/lib/crypto-selftests-pk.c",
    "sourceSha256": "fce9355507865b53ba0b5c5587932b9d8519be2cd195650b0d9ff69ac2c335c7",
    "vectors": {
        "293216817f0d585f0b54f225582f59e7b2e2a795b5f8002e2d71c5e3d49ce9b0": "ecdsa_secp384r1_privkey",
        "5a09eb5df3674472eda0077d83cbccef72692c3d052ab393368ac57295439c58": "eddsa_ed25519_privkey",
        "7c4c63ee462e0e700cd9e29c8e0f730b3f1b484c4abdd83f1e69fcd477c061fa": "dsa_2048_privkey",
        "91ea1699ff6b1a34b4a1d500a9c75a808441e47b9ea68da6fb0195e01ce1dc61": "ecdsa_secp256r1_privkey",
        "934b3e9bfd9936c5e30c7f0ed7d36a05e2044f755c0aa433e1d6bef6a68d1391": "ecdsa_secp192r1_privkey",
        "a0b9679665e29ac220dfb0b366317e1b9dd5fe31e9def8b2e511669a041389ae": "ecdsa_secp224r1_privkey",
        "a4d138d7ef9748464117b44fb9c0a4b5b85a1599a127d02690abaa96d03c16e6": "gost12_512_privkey",
        "d039c8119a029ab9f9c83c04d67002d887b6bc6026c4264402ab27cdf24cf138": "rsa_2048_privkey",
        "ef237ea8db4f2ae9ee100e8ced96d29b5dceb0e6a948443e6b8a00b1791f9ec9": "gost01_privkey",
        "f8766749b0c6f9b5661364568226af0ba7ae8d87c0073df24e440de4417521cd": "ecdsa_secp521r1_privkey",
        "fa0b06a72461ec0a963dcfccb8d5b61bd88a6074fc7271573bff68ab86b8c1af": "gost12_256_privkey",
        "fed7079dd4491609e4c996e232f366ac434fa4cc9df19df363391d079d470964": "eddsa_ed448_privkey",
    },
}
DEBIAN_ALTERNATIVES_TEXT = {
    "member": "var/lib/dpkg/alternatives/builtins.7.gz",
    "sha256": "6cd368606c13e12657f237f25e3ddfd89c6ebc34b52b8391561ff89d0c052f62",
}


class Scanner:
    """Stream a bounded archive graph, retaining hashes and non-secret findings."""

    def __init__(self, max_bytes=64 * 1024**3, max_depth=32):
        """Set explicit expansion bounds; reaching either fails rather than skips."""
        self.max_bytes = max_bytes
        self.max_depth = max_depth
        self.bytes = 0
        self.files = 0
        self.archives = 0
        self.findings = []
        self.seen = set()
        self.notices = []
        self.packages = []
        self.artifacts = []
        self.dispositions = []

    def finding(self, location, rule):
        """Record one value-free rule/location pair."""
        value = {"location": location, "rule": rule}
        if value not in self.findings:
            self.findings.append(value)

    def inert_fixture(self, location, rule, matched):
        """Recognize exact non-operational fixtures while inspecting every byte."""
        leaf = location.split("!")[-1]
        reason = None
        if rule == "aws-access-key" and matched in INERT_AWS_FIXTURES and (leaf.endswith(".test.js") or leaf.endswith("Test.java")):
            reason = "published/inert AWS redaction canary in test source; no secret credential pair"
        if rule == "operational-env-secret" and PurePosixPath(leaf).name == "example.env" and matched.split(b"=", 1)[-1].strip().startswith(b"local-only-"):
            reason = "explicit non-operational example template; supported generation replaces this placeholder with fresh random credentials"
        if not reason:
            return False
        disposition = {"location": location, "rule": rule, "fixtureSha256": hashlib.sha256(matched).hexdigest(), "reason": reason}
        if disposition not in self.dispositions:
            self.dispositions.append(disposition)
        return True

    def stream(self, stream, location, depth=0):
        """Inspect one stream and recursively inspect supported archive contents."""
        if depth > self.max_depth:
            self.finding(location, "archive-depth-exceeded")
            return
        self.files += 1
        hasher = hashlib.sha256()
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024**2) as copy:
            overlap = b""
            header = b""
            container = False
            private_values = set()
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                self.bytes += len(chunk)
                if self.bytes > self.max_bytes:
                    raise ValueError("archive expansion bound exceeded; no safety PASS")
                if not header:
                    header = chunk[:512]
                    container = (header.startswith((b"PK\x03\x04", b"\x1f\x8b\x08", b"BZh", b"\xfd7zXZ\x00"))
                                 or (len(header) > 262 and header[257:262] == b"ustar"))
                hasher.update(chunk)
                copy.write(chunk)
                text = overlap + chunk
                # Archive payloads receive their member identity below. Scanning
                # TAR/ZIP framing as a plain document would misattribute an inert
                # test-source canary to its enclosing image/archive instead.
                if not container:
                    for rule, pattern in RULES:
                        for match in pattern.finditer(text):
                            if rule == "private-key":
                                private_values.add(hashlib.sha256(match.group(0)).hexdigest())
                                continue
                            if not self.inert_fixture(location, rule, match.group(0)):
                                self.finding(location, rule)
                overlap = text[-65536:]
            content_hash = hasher.hexdigest()
            for value_hash in private_values:
                policy = GNUTLS_KNOWN_ANSWERS
                if (location.split("!")[-1].lstrip("/").endswith(policy["member"])
                        and content_hash == policy["binarySha256"] and value_hash in policy["vectors"]):
                    self.dispositions.append({"location": location, "rule": "vendor-cryptographic-known-answer-vector",
                                              "fixtureSha256": value_hash, "binarySha256": content_hash,
                                              "sourceUrl": policy["sourceUrl"], "sourceSha256": policy["sourceSha256"],
                                              "vector": policy["vectors"][value_hash],
                                              "reason": "public immutable gnutls_pk_self_test constant; no certificate/install credential binding; cryptographic self-tests preserved"})
                else:
                    self.finding(location, "private-key")
            # Docker save repeats identical layers across images. Bytes above were
            # still inspected; nested expansion of exact bytes need only run once.
            if content_hash in self.seen:
                return content_hash
            self.seen.add(content_hash)
            copy.seek(0)
            name = location.split("!")[-1].lower()
            basename = PurePosixPath(name).name
            if re.match(r"^(?:licen[sc]e|notice|copying|copyright)(?:[._-].*)?$", basename):
                content = copy.read().decode("utf-8", errors="replace")
                self.notices.append({"location": location, "sha256": content_hash, "text": content})
                copy.seek(0)
            if basename == "package.json":
                try:
                    metadata = json.load(copy)
                    if metadata.get("name") and metadata.get("version"):
                        self.packages.append({"ecosystem": "npm", "location": location,
                                              "name": metadata["name"], "version": metadata["version"],
                                              "license": metadata.get("license", metadata.get("licenses", "UNSPECIFIED"))})
                except (ValueError, UnicodeDecodeError):
                    pass
                copy.seek(0)
            if name.endswith("lib/apk/db/installed"):
                for record in copy.read().decode("utf-8").split("\n\n"):
                    fields = dict(line.split(":", 1) for line in record.splitlines() if ":" in line)
                    if fields.get("P"):
                        self.packages.append({"ecosystem": "apk", "location": location, "name": fields["P"],
                                              "version": fields.get("V"), "license": fields.get("L", "UNSPECIFIED"),
                                              "origin": fields.get("o"), "sourceCommit": fields.get("c")})
                copy.seek(0)
            if name.endswith("var/lib/dpkg/status"):
                for record in copy.read().decode("utf-8").split("\n\n"):
                    fields = dict(line.split(":", 1) for line in record.splitlines() if ":" in line and not line[0].isspace())
                    if fields.get("Package"):
                        self.packages.append({"ecosystem": "deb", "location": location, "name": fields["Package"].strip(),
                                              "version": fields.get("Version", "").strip(),
                                              "source": fields.get("Source", "").strip(),
                                              "license": "see preserved /usr/share/doc/<package>/copyright"})
                copy.seek(0)
            if header.startswith(b"PK\x03\x04"):
                self.archives += 1
                with zipfile.ZipFile(copy) as archive:
                    if archive.comment:
                        self.stream(io.BytesIO(archive.comment), f"{location}!zip-comment", depth + 1)
                    for member in archive.infolist():
                        if member.is_dir():
                            continue
                        if member.flag_bits & 1:
                            self.finding(f"{location}!{member.filename}", "encrypted-archive-uninspected")
                            continue
                        self.safe_name(member.filename, location)
                        if member.comment:
                            self.stream(io.BytesIO(member.comment), f"{location}!member-comment", depth + 1)
                        with archive.open(member) as nested:
                            self.stream(nested, f"{location}!{member.filename}", depth + 1)
            elif header.startswith(b"\x1f\x8b\x08"):
                self.archives += 1
                with gzip.GzipFile(fileobj=copy, mode="rb") as nested:
                    self.stream(nested, f"{location}!gzip-content", depth + 1)
            elif header.startswith(b"BZh") or header.startswith(b"\xfd7zXZ\x00"):
                self.archives += 1
                opener = bz2.BZ2File if header.startswith(b"BZh") else lzma.LZMAFile
                with opener(copy) as nested:
                    self.stream(nested, f"{location}!compressed-content", depth + 1)
            elif (len(header) > 262 and header[257:262] == b"ustar") or name.endswith((".tar", "layer.tar")):
                self.archives += 1
                try:
                    with tarfile.open(fileobj=copy, mode="r|*") as archive:
                        for member in archive:
                            self.safe_name(member.name, location)
                            if member.isfile():
                                with archive.extractfile(member) as nested:
                                    self.stream(nested, f"{location}!{member.name}", depth + 1)
                            elif not (member.isdir() or member.issym() or member.islnk() or member.ischr() or member.isblk()):
                                self.finding(f"{location}!{member.name}", "unrecognized-archive-entry")
                except tarfile.TarError as error:
                    raise ValueError(f"unreadable archive: {location}") from error
            elif name.endswith((".p12", ".pfx", ".jks", ".keystore")):
                self.finding(location, "private-credential-container")
            elif header.startswith((b"\x28\xb5\x2f\xfd", b"7z\xbc\xaf\x27\x1c", b"Rar!")):
                self.finding(location, "uninspected-archive-format")
            elif name.endswith((".zip", ".jar", ".war", ".gz", ".tgz", ".xz", ".bz2", ".7z", ".rar", ".zst")):
                state = DEBIAN_ALTERNATIVES_TEXT
                if (name.lstrip("./") == state["member"] and content_hash == state["sha256"]
                        and header.startswith((b"auto\n/usr/share/man/", b"manual\n/usr/share/man/"))):
                    self.dispositions.append({"location": location, "rule": "debian-alternatives-plaintext-state",
                                              "fixtureSha256": content_hash,
                                              "reason": "package-manager text state named after a compressed manpage; all bytes raw-scanned, not a gzip archive"})
                else:
                    self.finding(location, "unsupported-or-corrupt-archive")
            return content_hash

    def safe_name(self, name, location):
        """Reject traversal archive names even though scanning never extracts."""
        if PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            self.finding(f"{location}!{name}", "unsafe-archive-path")
        for rule, pattern in RULES:
            if pattern.search(name.encode("utf-8")):
                self.finding(location, f"credential-in-archive-name:{rule}")

    def path(self, target):
        """Scan regular public artifacts; filesystem links cannot hide bytes."""
        target = Path(target)
        if target.is_symlink():
            self.finding(str(target), "filesystem-symlink")
        elif target.is_dir():
            for child in sorted(target.iterdir()):
                self.path(child)
        elif target.is_file():
            with target.open("rb") as stream:
                content_hash = self.stream(stream, str(target))
                self.artifacts.append({"path": str(target), "sha256": content_hash, "bytes": target.stat().st_size})
        else:
            raise ValueError(f"missing or special scan target: {target}")

    def report(self):
        """Return explicit completeness, counts and safe findings."""
        incomplete = {"archive-depth-exceeded", "encrypted-archive-uninspected", "uninspected-archive-format", "unsupported-or-corrupt-archive"}
        return {"schemaVersion": "pcm-public-safety-scan/1", "status": "fail" if self.findings else "pass",
                "complete": not any(item["rule"] in incomplete for item in self.findings), "scannedFiles": self.files, "archives": self.archives,
                "expandedBytes": self.bytes, "maxExpandedBytes": self.max_bytes,
                "maxArchiveDepth": self.max_depth, "artifacts": self.artifacts,
                "inertFixtureDispositions": self.dispositions, "findings": self.findings}


def main():
    """Scan CLI targets, returning failure for findings or incomplete inspection."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="+")
    parser.add_argument("--output")
    parser.add_argument("--max-expanded-bytes", type=int, default=64 * 1024**3)
    parser.add_argument("--notices-output", help="Write preserved license texts and package metadata separately")
    args = parser.parse_args()
    scanner = Scanner(max_bytes=args.max_expanded_bytes)
    try:
        for target in args.targets:
            scanner.path(target)
        result = scanner.report()
    except (OSError, ValueError, zipfile.BadZipFile, lzma.LZMAError, EOFError) as error:
        result = {"schemaVersion": "pcm-public-safety-scan/1", "status": "fail", "complete": False,
                  "error": str(error), "findings": scanner.findings}
    rendered = json.dumps(result, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(rendered)
    if args.notices_output:
        Path(args.notices_output).write_text(json.dumps({"schemaVersion": "pcm-public-notices/1",
                                                       "notices": scanner.notices, "packages": scanner.packages}, indent=2) + "\n")
    print(rendered, end="")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
