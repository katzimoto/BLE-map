#!/usr/bin/env python3
"""Fail-closed public-candidate checks. Never print matched text or paths."""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import io
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit
import zipfile

import yaml
from PIL import Image
from generate_synthetic import generate

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_MEMBERS = 2000
RESERVED = tuple(
    ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
)
RULES = {
    "bluetooth-address": r"(?i)(?<![0-9a-f])(?:[0-9a-f]{2}:){5}[0-9a-f]{2}(?![0-9a-f])",
    "observation-short-id": r"\bDevice [A-F0-9]{4,12}\b",
    "capture-filename": r"\b(?:bluetooth|ble|capture|sniff)[_-](?:log[_-])?\d+\.(?:csv|json|xlsx)|\b(?:raw|live)[_-](?:capture|sniffed|observations)[_-](?:data|log)(?:[_-][a-z]+)?\.(?:csv|tsv|json|xlsx)",
    "email": r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}",
    "phone": r"(?<![\w.])\+?\d[\d ()-]{8,}\d(?![\w.])",
    "ssh-instruction": r"\bssh\s+(?:-\w|[\w.-]+@)|\bscp\s+-|\bsshpass\b",
    "deployment-path": r"/(?:home|Users|root|opt|mnt|media|var/lib|etc/letsencrypt)/[\w.-]+|/srv/(?!example-ble-map\b)[\w.-]+",
    "private-key": r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "token-signature": r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{16,})\b",
    "credential-retrieval": r"(?i)(?:cat|printenv|curl|wget)\s+[^\n]{0,80}(?:credential|secret|access.token|\.env)",
    "capture-serial": r'(?i)\b(?:serial|serial_number|serialnumber)\s*[=:]\s*["\x27]?[A-Z0-9_-]{8,}',
}
URL_HOSTS = {
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "docs.github.com",
    "registry.npmjs.org",
    "www.npmjs.com",
    "npmjs.com",
    "nodejs.org",
    "www.python.org",
    "pypi.org",
    "files.pythonhosted.org",
    "www.apache.org",
    "apache.org",
    "json-schema.org",
    "json-schema.org.",
    "www.w3.org",
    "w3.org",
    "www.itl.nist.gov",
    "localhost",
    "example.com",
    "example.invalid",
    "react.dev",
    "reactjs.org",
    "threejs.org",
    "threejs.com",
    "ajv.js.org",
    "developer.mozilla.org",
    "opencollective.com",
    "github.blog",
    "eslint.org",
    "tidelift.com",
    "feross.org",
    "www.patreon.com",
    "patreon.com",
    "paulmillr.com",
    "dotenvx.com",
    "drei.docs.pmnd.rs",
    "docs.pmnd.rs",
    "pmnd.rs",
    "jcgt.org",
}
CODE_SUFFIXES = {
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".py",
    ".css",
    ".html",
    ".md",
    ".txt",
    ".toml",
    ".yml",
    ".yaml",
    ".json",
}


def command(args, cwd=ROOT):
    result = subprocess.run(args, cwd=cwd, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError("Required inspection tool failed")
    return result.stdout


def valid_member(name):
    p = PurePosixPath(name)
    return bool(name) and not p.is_absolute() and ".." not in p.parts and "\\" not in name


# Reviewed mathematical constants from React/Three.js: powers of two, integer
# bounds, half-float conversion, Morton masks and the documented PRNG increment.
MATH_CONSTANTS = {
    str(v)
    for v in [
        2**30 - 1,
        2**30,
        2**31 - 1,
        2**31,
        2**32 - 1,
        2**32,
        0x47800000,
        0xC7800000,
        0x55555555,
        0x6D2B79F5,
    ]
}


def text_findings(text, context="text"):
    if context == "git-metadata":
        text = re.sub(r"(?m)^(author|committer|tagger)( .*?>) \d+ [+-]\d{4}$", r"\1\2", text)
    found = Counter()
    for name, pattern in RULES.items():
        for match in re.finditer(pattern, text):
            value = match.group()
            if name == "phone":
                if len(re.sub(r"\D", "", value)) < 10:
                    continue
                if (
                    context == "javascript"
                    and value in MATH_CONSTANTS
                    and text[max(0, match.start() - 1) : match.start()] not in {'"', "'"}
                ):
                    continue
            if (
                name == "email"
                and context == "git-metadata"
                and re.fullmatch(
                    r"(?:(?:\d+\+)?[\w-]+@users\.noreply\.github\.com|noreply@github\.com)", value
                )
            ):
                continue
            found[name] += 1
    for match in re.finditer(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])", text):
        try:
            address = ipaddress.ip_address(match.group())
            if not any(address in network for network in RESERVED):
                found["non-reserved-ip"] += 1
        except ValueError:
            found["invalid-ip-literal"] += 1
    for match in re.finditer(r'https?://[^\s<>"\x27`)\\]+', text):
        parsed = urlsplit(match.group())
        if (
            parsed.username
            or parsed.password
            or (
                parsed.hostname not in URL_HOSTS
                and not str(parsed.hostname).endswith(".example.invalid")
            )
        ):
            found["unapproved-url"] += 1
    if re.search(
        r'(?i)["\x27]?(?:latitude|longitude|lat|lon|lng)["\x27]?\s*[:=]\s*-?\d{1,3}\.\d{3,}', text
    ):
        found["geographic-coordinate"] += 1
    return found


class Gate:
    def __init__(self, root=ROOT):
        self.root = root
        self.findings = Counter()
        self.inspected = Counter()
        self.total = 0
        self.expected = {}
        with tempfile.TemporaryDirectory() as tmp:
            generate(Path(tmp))
            self.expected = {p.name: p.read_bytes() for p in Path(tmp).iterdir()}
        assets = root / ".privacy/assets.json"
        self.assets = json.loads(assets.read_text()) if assets.exists() else {"approved": []}
        self.image_hashes = {x["sha256"] for x in self.assets["approved"]}

    def structured(self, name, text):
        suffix = PurePosixPath(name).suffix
        try:
            if suffix == ".json" or suffix == ".geojson":

                def pairs(items):
                    if len(items) != len(dict(items)):
                        raise ValueError("Duplicate JSON key")
                    return dict(items)

                obj = json.loads(text, object_pairs_hook=pairs)
            elif suffix in {".yaml", ".yml"}:
                obj = yaml.safe_load(text)
            elif suffix == ".csv":
                rows = list(csv.reader(io.StringIO(text), strict=True))
                if rows and any(len(r) != len(rows[0]) for r in rows):
                    self.findings["ragged-csv"] += 1
                self.findings["unapproved-observation-format"] += 1
                return
            else:
                return
            self.inspected["structured"] += 1

            def walk(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if str(key).lower() in {
                            "latitude",
                            "longitude",
                            "coordinates",
                            "localname",
                            "mac",
                            "epoch_time",
                            "source file",
                            "source_file",
                            "txpower",
                            "service_name",
                            "container_name",
                            "ssh_host",
                        }:
                            self.findings["restricted-structured-field"] += 1
                        walk(child)
                elif isinstance(value, list):
                    for child in value:
                        walk(child)

            walk(obj)
            if isinstance(obj, dict) and obj.get("kind") == "synthetic-ble-fixture":
                filename = obj.get("id", "") + ".json"
                # Require canonical bytes, not merely a synthetic marker.
                if text.encode() != self.expected.get(filename):
                    self.findings["non-generator-observations"] += 1
            if suffix == ".geojson":
                self.findings["unapproved-geographic-format"] += 1
        except ValueError, yaml.YAMLError, csv.Error:
            self.findings["invalid-structured-document"] += 1

    def png(self, name, data, generated):
        self.inspected["images"] += 1
        generated_approved = generated and name in {
            "review-output/screenshots/desktop.png",
            "review-output/screenshots/mobile.png",
            "review-output/screenshots/layout.png",
        }
        if not generated_approved and hashlib.sha256(data).hexdigest() not in self.image_hashes:
            self.findings["unapproved-binary"] += 1
        try:
            at = 8
            while at < len(data):
                size = struct.unpack(">I", data[at : at + 4])[0]
                tag = data[at + 4 : at + 8]
                if tag not in {b"IHDR", b"IDAT", b"IEND", b"sRGB", b"gAMA", b"cHRM", b"pHYs"}:
                    self.findings["image-metadata"] += 1
                at += 12 + size
            with Image.open(io.BytesIO(data)) as im:
                if im.width * im.height > 20_000_000:
                    raise ValueError("Oversized image")
                im.verify()
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "synthetic.png"
                path.write_bytes(data)
                meta = json.loads(command(["exiftool", "-json", "-G1", str(path)]))[0]
                if any(
                    any(marker in k for marker in ["EXIF:", "XMP:", "GPS:", "IPTC:"]) for k in meta
                ):
                    self.findings["image-metadata"] += 1
                ocr = command(
                    ["tesseract", str(path), "stdout", "-l", "eng", "--psm", "11"]
                ).decode()
                self.findings.update(text_findings(ocr))
                if not re.search(r"synthetic", ocr, re.I):
                    self.findings["missing-synthetic-image-marker"] += 1
                self.inspected["ocr"] += 1
        except ValueError, RuntimeError, OSError, struct.error:
            self.findings["image-inspection-failed"] += 1

    def scan(self, name, data, generated=False, depth=0):
        self.total += len(data)
        self.inspected["content_items"] += 1
        if len(data) > MAX_BYTES or self.total > MAX_TOTAL or depth > 4:
            self.findings["inspection-size-bound"] += 1
            return
        if not valid_member(name):
            self.findings["unsafe-path"] += 1
            return
        self.findings.update(text_findings(name))
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            self.png(name, data, generated)
            return
        if data.startswith(b"PK\x03\x04") or name.endswith((".tgz", ".tar.gz", ".zip")):
            self.inspected["archives"] += 1
            try:
                if data.startswith(b"PK\x03\x04"):
                    with zipfile.ZipFile(io.BytesIO(data)) as archive:
                        items = archive.infolist()
                        if len(items) > MAX_MEMBERS or sum(e.file_size for e in items) > MAX_TOTAL:
                            raise ValueError()
                        for entry in items:
                            if entry.is_dir():
                                continue
                            if (
                                entry.file_size > MAX_BYTES
                                or (entry.external_attr >> 16) & 0o170000 == 0o120000
                            ):
                                raise ValueError()
                            self.scan(entry.filename, archive.read(entry), generated, depth + 1)
                else:
                    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                        items = archive.getmembers()
                        if len(items) > MAX_MEMBERS or sum(e.size for e in items) > MAX_TOTAL:
                            raise ValueError()
                        for entry in items:
                            if entry.isdir():
                                continue
                            if not entry.isfile() or entry.size > MAX_BYTES:
                                raise ValueError()
                            file = archive.extractfile(entry)
                            if file is None:
                                raise ValueError()
                            self.scan(entry.name, file.read(), generated, depth + 1)
            except ValueError, OSError, tarfile.TarError, zipfile.BadZipFile:
                self.findings["unsafe-archive"] += 1
            return
        try:
            text = data.decode("utf8")
            if "\0" in text:
                raise UnicodeError()
        except UnicodeError:
            self.findings["unapproved-binary"] += 1
            return
        self.findings.update(
            text_findings(
                text,
                "javascript"
                if PurePosixPath(name).suffix in {".js", ".mjs", ".tsx", ".ts"}
                else "text",
            )
        )
        self.structured(name, text)

    def history(self):
        refs = command(["git", "for-each-ref", "--format=%(refname)"], self.root).decode()
        self.findings.update(text_findings(refs))
        self.inspected["refs"] = len(refs.splitlines())
        objects = (
            command(["git", "rev-list", "--objects", "--all"], self.root).decode().splitlines()
        )
        for entry in objects:
            parts = entry.split(" ", 1)
            oid = parts[0]
            kind = command(["git", "cat-file", "-t", oid], self.root).decode().strip()
            if kind == "blob":
                self.scan(
                    parts[1] if len(parts) > 1 else "reachable-object.txt",
                    command(["git", "cat-file", "blob", oid], self.root),
                )
            elif kind == "tree":
                entries = command(["git", "ls-tree", "-z", oid], self.root).decode().split("\0")
                for entry in filter(None, entries):
                    metadata, _, name = entry.partition("\t")
                    self.findings.update(text_findings(name))
                    if metadata.startswith(("120000", "160000")):
                        self.findings["historical-link-or-submodule"] += 1
            elif kind in {"commit", "tag"}:
                text = command(["git", "cat-file", kind, oid], self.root).decode()
                metadata, _, body = text.partition("\n\n")
                self.findings.update(text_findings(metadata, "git-metadata"))
                self.findings.update(text_findings(body))
            self.inspected["git_objects"] += 1
        # No alternate or shared object store is acceptable.
        alternate = self.root / ".git/objects/info/alternates"
        if alternate.exists():
            self.findings["shared-object-database"] += 1

    def run(self, history=True):
        manifest = json.loads((self.root / ".privacy/files.json").read_text())
        allowed = {entry["path"] for entry in manifest["files"]}
        tracked = set(command(["git", "ls-files", "-z"], self.root).decode().split("\0")) - {""}
        for name in sorted(allowed | tracked):
            if name not in allowed:
                self.findings["file-outside-allowlist"] += 1
            path = self.root / name
            if path.is_symlink() or not path.is_file():
                self.findings["missing-or-linked-file"] += 1
                continue
            self.scan(name, path.read_bytes())
        # All emitted artifacts, including browser outputs, must pass before upload.
        for directory in ["dist", "review-output", "test-results", "playwright-report"]:
            parent = self.root / directory
            if parent.exists():
                for path in sorted(parent.rglob("*")):
                    if path.is_symlink():
                        self.findings["linked-artifact"] += 1
                    elif path.is_file():
                        self.scan(
                            path.relative_to(self.root).as_posix(),
                            path.read_bytes(),
                            generated=True,
                        )
        if history:
            self.history()
        print(
            json.dumps(
                {
                    "gate": "privacy",
                    "pass": not self.findings,
                    "findings": dict(sorted(self.findings.items())),
                    "inspected": dict(sorted(self.inspected.items())),
                },
                sort_keys=True,
            )
        )
        return not self.findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-history", action="store_true", help="Local diagnostics only; CI always scans history"
    )
    args = parser.parse_args()
    try:
        return 0 if Gate().run(history=not args.no_history) else 1
    except Exception:
        print(
            json.dumps(
                {"gate": "privacy", "pass": False, "findings": {"required-inspection-failed": 1}}
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
