#!/usr/bin/env python3
"""Compare every production output byte across two independent build invocations."""

import hashlib
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def build():
    shutil.rmtree(ROOT / "dist", ignore_errors=True)
    run = subprocess.run(["npm", "run", "build"], cwd=ROOT, capture_output=True, check=False)
    if run.returncode:
        raise RuntimeError("Production build failed; raw output withheld")
    return {
        p.relative_to(ROOT / "dist").as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (ROOT / "dist").rglob("*")
        if p.is_file()
    }


if __name__ == "__main__":
    if build() != build():
        raise RuntimeError("Production outputs differ")
    print("Two production builds produced byte-identical files.")
