# Contributing

Use a branch and pull request. All changes require passing `verify`, `privacy-gate` and `codeql`, an approving review and resolved conversations. Do not commit personal data, infrastructure configuration, credentials, real BLE captures or artifacts generated from them.

Follow the README setup and run every verification command. Add new scenarios through the deterministic generator, update schema and tests, and review each changed fixture byte. Add public files to `.privacy/files.json` with their origin class; never include a private source mapping. Binary additions require an explicit asset policy, metadata inspection, OCR and human review.

Use GitHub's noreply commit identity. Keep issue text, commits, test output and screenshots synthetic and public-safe. Do not paste incident details into a public issue. Submissions are licensed under Apache-2.0. Keep dependency updates exact and lockfiles committed; pin third-party Actions by full commit SHA.
