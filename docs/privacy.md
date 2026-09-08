# Privacy model and non-surveillance boundaries

This repository contains a synthetic laboratory, not a capture archive. It has no current-deployment configuration, live receiver defaults, real positions, observation-derived identifiers or imported source Git history. Historical data, deployment material, reports, screenshots and generated documentation were excluded. The public application, generator, tests, documentation and automation were written separately.

Do not add real advertisements, Bluetooth addresses, local names, serials, floor plans, calibration readings, timestamps, infrastructure details or linkable hashes. Even apparently anonymous RF data can identify people or equipment through payloads, names, repeated schedules and movement. Rotating addresses are not permission to re-identify a person. Do not use this project for covert tracking, occupancy inference about identifiable people or surveillance without informed authorization.

The default app makes no external requests. It does not geolocate, discover hardware, contact gateways, load remote fonts or map tiles, or report telemetry. Imported project observations must exactly match generator output. User-assigned XY positions are local, bounded and fictional by contract; never enter a real deployment layout. User exports are not automatically approved for public contribution.

## Automated gates

The repository file allowlist is `.privacy/files.json`. It documents only public files and their origin class; private source mappings and exact comparisons never belong here. The scanner checks tracked and allowlisted content, refs, reachable blobs and commit messages, build output and review packages. It rejects identifying formats, unapproved binaries and suspicious configuration. Approved synthetic screenshots undergo metadata inspection and OCR. The dependency lockfile is structurally checked and secret-scanned; registry integrity fields are third-party package checksums, not observation identifiers.

Gitleaks and TruffleHog are complementary scanners. GitHub secret scanning and push protection add server-side protection. Scanners report only rule classes and counts, never matched values. A possible active secret stops publication work and requires private remediation. No scanner or OCR engine can prove absence of personal data; visual review and an independent reviewer remain essential.

## Human gate

The data owner must review the public file manifest. A second reviewer must independently inspect the exact public commit, synthetic fixtures, documentation, screenshots, generated artifacts and scan results. Record both approvals against that public SHA in issue #1. Complete repository security settings before approval. Do not create a release tag or describe a candidate as publishable until these conditions hold.

Only high-level public-safe migration progress belongs in public issues. Report vulnerabilities through GitHub private vulnerability reporting. Maintainer infrastructure belongs in a separate private configuration system and must never appear here, even redacted or hashed.
