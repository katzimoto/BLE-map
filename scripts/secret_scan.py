#!/usr/bin/env python3
"""Complementary scanners; reports contain counts only, never findings or matches."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, timeout=600, check=False)


def main():
    outcomes = []
    try:
        pins = json.loads((ROOT / ".privacy/tools.json").read_text())
        for tool in ["gitleaks", "trufflehog"]:
            result = run([tool, "version" if tool == "gitleaks" else "--version"])
            if (
                result.returncode
                or pins[tool]["version"] not in (result.stdout + result.stderr).decode()
            ):
                raise RuntimeError("Scanner version mismatch")
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            staged = workspace / "candidate"
            staged.mkdir()
            entries = json.loads((ROOT / ".privacy/files.json").read_text())["files"]
            paths = [ROOT / entry["path"] for entry in entries]
            for folder in ["dist", "review-output", "test-results", "playwright-report"]:
                paths.extend(p for p in (ROOT / folder).rglob("*") if p.is_file())
            for source in paths:
                if source.is_symlink():
                    raise RuntimeError("Symlink forbidden")
                dest = staged / source.relative_to(ROOT)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, dest)
            # Materialize EVERY reachable object for the second scanner too.
            objects = run(["git", "rev-list", "--objects", "--all"])
            if objects.returncode:
                raise RuntimeError("Git inspection failed")
            history = staged / "reachable-history"
            history.mkdir()
            for index, line in enumerate(objects.stdout.decode().splitlines()):
                oid = line.split(" ", 1)[0]
                kind = run(["git", "cat-file", "-t", oid]).stdout.decode().strip()
                if kind in {"blob", "commit", "tag"}:
                    content = run(["git", "cat-file", kind, oid])
                    if content.returncode:
                        raise RuntimeError("Object read failed")
                    (history / f"object-{index}.txt").write_bytes(content.stdout)
            for mode, target in [("git", str(ROOT)), ("dir", str(staged))]:
                report = workspace / f"gitleaks-{mode}.json"
                args = [
                    "gitleaks",
                    mode,
                    target,
                    "--redact=100",
                    "--no-banner",
                    "--no-color",
                    "--ignore-gitleaks-allow",
                    "--max-archive-depth=4",
                    "--report-format=json",
                    "--report-path",
                    str(report),
                ]
                if mode == "git":
                    args += ["--log-opts=--all --full-history"]
                result = run(args)
                items = json.loads(report.read_text()) if report.exists() else []
                outcomes.append(
                    {
                        "scanner": "gitleaks",
                        "scope": mode,
                        "findings": len(items),
                        "pass": result.returncode == 0 and not items,
                    }
                )
            result = run(
                [
                    "trufflehog",
                    "filesystem",
                    str(staged),
                    "--no-update",
                    "--no-verification",
                    "--json",
                    "--fail",
                    "--archive-max-depth=4",
                    "--archive-max-size=32MB",
                ]
            )
            items = [
                json.loads(line) for line in result.stdout.decode().splitlines() if line.strip()
            ]
            outcomes.append(
                {
                    "scanner": "trufflehog",
                    "scope": "files-and-all-reachable-objects",
                    "findings": len(items),
                    "pass": result.returncode == 0 and not items,
                }
            )
        passed = all(item["pass"] for item in outcomes)
        print(
            json.dumps(
                {"gate": "secret-scanners", "pass": passed, "results": outcomes}, sort_keys=True
            )
        )
        return 0 if passed else 1
    except Exception:
        print(
            json.dumps(
                {
                    "gate": "secret-scanners",
                    "pass": False,
                    "error": "Required scanner failed; publication blocked.",
                }
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
