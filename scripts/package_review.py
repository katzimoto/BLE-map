#!/usr/bin/env python3
"""Deterministic review archives from the explicit public allowlist and dist only."""

import gzip
import io
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def archive(entries):
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as output:
            for name, data in sorted(entries):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o644
                entry.mtime = 0
                output.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


def main():
    manifest = json.loads((ROOT / ".privacy/files.json").read_text())
    files = [(entry["path"], (ROOT / entry["path"]).read_bytes()) for entry in manifest["files"]]
    built = [
        (p.relative_to(ROOT / "dist").as_posix(), p.read_bytes())
        for p in (ROOT / "dist").rglob("*")
        if p.is_file()
    ]
    if not built:
        raise RuntimeError("Build required before packaging")
    output = ROOT / "review-output/packages"
    output.mkdir(parents=True, exist_ok=True)
    for name, entries in [("source-review.tar.gz", files), ("static-review.tar.gz", built)]:
        first = archive(entries)
        if first != archive(entries):
            raise RuntimeError("Package determinism failed")
        (output / name).write_bytes(first)
    print("Two deterministic review packages created from explicit public inputs.")


if __name__ == "__main__":
    main()
