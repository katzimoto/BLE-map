#!/usr/bin/env python3
"""Safe CI output: stage outcomes only; never upload unsanitized test logs."""

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STAGES = [
    ("format", ["npm", "run", "format:check"]),
    ("lint", ["npm", "run", "lint"]),
    ("python-lint", ["ruff", "check", "scripts"]),
    ("python-format", ["ruff", "format", "--check", "scripts"]),
    ("schemas", ["npm", "run", "schemas"]),
    ("schema-determinism", ["git", "diff", "--exit-code", "--", "src/generated"]),
    ("unit", ["npm", "test"]),
    (
        "integration-and-privacy-regressions",
        [sys.executable, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py"],
    ),
    ("synthetic-determinism", ["npm", "run", "fixtures:check"]),
    ("reproducible-build", [sys.executable, "scripts/reproducible_build.py"]),
    ("browser-and-accessibility", ["npm", "run", "test:e2e"]),
    ("dependency-audit", ["npm", "audit", "--audit-level=moderate"]),
    (
        "python-dependency-audit",
        ["pip-audit", "-r", "requirements-dev.txt", "--no-deps", "--disable-pip"],
    ),
    ("packages", [sys.executable, "scripts/package_review.py"]),
    ("privacy-and-artifacts", [sys.executable, "scripts/privacy_gate.py"]),
    ("secret-scanners", [sys.executable, "scripts/secret_scan.py"]),
]


def main():
    outcomes = []
    for name, args in STAGES:
        result = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=900, check=False)
        passed = result.returncode == 0
        outcomes.append({"stage": name, "pass": passed})
        print(json.dumps(outcomes[-1]), flush=True)
        if not passed:
            print(
                "Verification stopped. Inspect locally using synthetic inputs; do not upload raw logs."
            )
            return 1
    output = ROOT / "review-output"
    output.mkdir(exist_ok=True)
    (output / "verification.json").write_text(
        json.dumps({"synthetic": True, "results": outcomes}, indent=2) + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
