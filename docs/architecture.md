# Architecture

The public application is a clean-room implementation with a new public history. No source history or infrastructure configuration is imported. The root README predating the bootstrap was reviewed separately and retained.

`generate_synthetic.py` produces bounded parallel arrays and a SHA-256 fixture manifest. The browser validates JSON Schema, array consistency, monotonic relative time and exact generator provenance before hydrating typed arrays and per-address indices. The manifest authenticates consistency with this checked-out generator; it is not a cryptographic signature against a compromised host.

React renders accessible controls and analytical views. Zustand holds selection and publishes replay time about ten times per second. The WebGL loop owns its frame clock in a ref and renders on demand when paused. The layout and fallback use a low-rate clock while the canvas is unmounted. Three.js uses instanced glyphs/rings and one reception-line buffer; there are no shadows, bloom, telemetry or workers.

The estimator combines recent receiver evidence, applies conditional calibration uncertainty, checks clock correction and geometry, then performs a bounded fictional XY search. UI layout edits are assigned simulation parameters; observations remain immutable. No gateway, REST backend or device discovery runs in the public application.

Projects live in IndexedDB. Import validates before presenting a replacement review. Confirming restore exports the current view, writes the replacement atomically and then updates the UI. Persistence refusals and unavailable APIs have distinct messages. Exported backups remain the durable handoff.

The privacy gate reviews explicit allowlisted files, reachable Git objects and refs, generated output, archives, and image metadata/OCR. Gitleaks and TruffleHog complement repository-specific checks. Private release comparisons remain outside this repository. Human review of the exact public commit is mandatory even when automated checks pass.
