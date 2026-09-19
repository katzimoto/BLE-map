# Verification and repository controls

The candidate is awaiting human privacy approval. Automated results must be attached to the exact public commit through checks and issue #1; passing checks alone do not make it publishable.

## Clean-clone gate

Clone only the public repository and check out the public review branch or exact candidate commit. Use Node 24 and Python 3.14:

```sh
git clone https://github.com/katzimoto/BLE-map.git
cd BLE-map
git checkout bootstrap/synthetic-public-review
npm ci
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
npx playwright install chromium
python3 scripts/run_checks.py
```

Install Tesseract with English language data and ExifTool through your operating system package manager. Gitleaks 8.30.1 and TruffleHog 3.97.4 are required. `.privacy/tools.json` pins official Linux release archives by SHA-256; `python3 scripts/install_scanners.py --output <tool-directory>` installs those versions on Linux. Put that directory on PATH. Other platforms must install the same versions independently.

`run_checks.py` reports stage outcomes, withholding raw logs and matched values. On failure, reproduce privately with generated inputs. The privacy scanner must succeed before any workflow artifact is uploaded. It includes all generated browser screenshots, production files and both deterministic review archives. Unapproved binary/document formats are rejected rather than skipped. PNGs undergo chunk/metadata inspection, image decoding, ExifTool inspection and English OCR. There are no committed PDF or office documents.

The scanner reviews the entire reachable object graph in the local public clone. CI fetches all advertised public refs first. The private release process separately checks exact private values and confirms no private commit object is reachable; neither its denylist nor its source mapping is published.

## Required settings

Main is protected: pull requests, one approving review, approval after the latest push, dismissal of stale approvals, resolved conversations, up-to-date `verify`, `privacy-gate` and `codeql`, linear history, no force pushes, no deletion, and protections enforced for administrators. Require an independent reviewer when the code owner authors a change.

Enable GitHub secret scanning, push protection, private vulnerability reporting and dependency security updates. Actions default to read-only and may not approve pull requests. Only CodeQL's analysis job receives `security-events: write`. No workflow uses deployment credentials or a production environment. Third-party Actions are pinned to reviewed full commit SHAs. Dependabot updates require normal review and all gates.

Repository administrators must verify these settings at the candidate approval point. Any unavailable controls must be recorded explicitly in issue #1. The data owner and independent reviewer then record approval of the exact public commit. No release tag is created during bootstrap.
