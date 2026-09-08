#!/usr/bin/env python3
"""Install reviewed, checksum-pinned Linux scanner binaries into an explicit directory."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for name, pin in json.loads((ROOT / ".privacy/tools.json").read_text()).items():
        request = urllib.request.Request(
            pin["url"], headers={"User-Agent": "BLE-map-public-verifier"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(128 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != pin["sha256"]:
            raise RuntimeError("Scanner checksum mismatch")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            member = next(m for m in archive.getmembers() if m.name == name and m.isfile())
            content = archive.extractfile(member)
            if content is None:
                raise RuntimeError("Scanner binary absent")
            target = args.output / name
            target.write_bytes(content.read())
            target.chmod(0o755)
    print("Reviewed scanner versions installed; all download checksums match.")


if __name__ == "__main__":
    main()
