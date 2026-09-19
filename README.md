# BLE Map — Synthetic Lab

A local browser laboratory for BLE signal replay, fictional receiver layouts, calibration and uncertainty. **Every demonstration observation is generated. This repository is awaiting human privacy review and has no release.**

The signal field is **not a map**: radius encodes RSSI and angle is assigned. The separate receiver layout uses fictional metric XY positions and a conditional propagation model. No real captures, live gateways, maps, geolocation, telemetry or vendor services are included.

## Run locally

Use Node 24, npm and Python 3.14. Install Python tools into a virtual environment:

```sh
npm ci
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
npm run fixtures
npm run dev
```

Open the localhost address printed by Vite. The app reads its own static synthetic JSON files. Exported projects contain only approved synthetic observations and your assigned fictional layout. Import rejects altered observations and unknown fields. Keep a separate exported backup; browser persistence is not a backup.

## Verify and build

```sh
npm run format:check
npm run lint
ruff check scripts
ruff format --check scripts
npm test
npm run test:integration
npm run fixtures:check
npm run build
npx playwright install chromium
npm run test:e2e
npm audit --audit-level=moderate
pip-audit -r requirements-dev.txt --no-deps --disable-pip
npm run package:review
npm run privacy
npm run audit:secrets
```

Privacy verification additionally requires Tesseract (English OCR), ExifTool, Gitleaks and TruffleHog on PATH. See [verification](docs/verification.md) for versions, workflow gates and clean-clone commands. Production files are in `dist`; `npm run preview` serves them locally. No deployment targets or production infrastructure templates are included. An operator must supply any hosting configuration separately, with HTTPS, restrictive headers, externally managed secrets and explicit approval for networked features.

## Included

- Instanced 3D signal field, receiver selection, raw RSSI and time-aware EMA.
- Linked packet timeline, selected-address evidence, keyboard controls and useful WebGL fallback.
- Fictional multi-receiver plane; calibration with inverse prediction intervals and explicit no-fix states.
- Synthetic clock correction, duplicate/tie preservation and an explicitly modeled address rotation.
- Schema-validated local projects, export, backup and reviewed restore.
- Five deterministic scenarios, automated accessibility/browser/privacy checks and independent public history.

Space toggles replay, arrows seek one second and Escape clears selection. Form controls retain their normal keyboard behavior. Playback starts paused. Reduced motion disables pulse animation. A worker is unnecessary for these small fixtures; consider one only after profiling sessions above roughly 10 MB.

## Synthetic review screenshots

[Desktop laboratory](docs/screenshots/synthetic-desktop.png) · [Mobile laboratory](docs/screenshots/synthetic-mobile.png)

These images render the documented generator and visibly identify all content as synthetic. Metadata is stripped; the privacy gate verifies their hashes, metadata and OCR text.

## Boundaries

This is a synthetic teaching and engineering tool, not a positioning accuracy claim or a system for tracking people. RSSI depends on propagation, orientation, obstruction and receiver behavior. Multiple receivers improve constraints only when clocks, geometry and calibration support the model. Unknown physical identities must not be inferred from rotating Bluetooth addresses.

See [architecture](docs/architecture.md), [data semantics and provenance](docs/data-semantics.md), [schemas and local interfaces](docs/api.md), [privacy model](docs/privacy.md), [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md). Licensed under Apache-2.0.
