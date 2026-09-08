# Schemas and local interfaces

There is no network API or live gateway in this public build. Default requests fetch only same-origin static assets and five generated fixtures. External documentation links require an explicit user click.

| Interface                | Contract                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `fixtures/manifest.json` | Synthetic marker, generator version, five case entries with file, count and generated-byte SHA-256       |
| `fixtures/<case>.json`   | Closed `fixture.schema.json` with invented tables and six parallel arrays                                |
| Project export/import    | Closed `project.schema.json`; exact fixture provenance plus local view                                   |
| IndexedDB                | `synthetic-ble-lab`, store `projects`, key `current`; one validated project                              |
| Generator                | `python3 scripts/generate_synthetic.py`; no input observations accepted                                  |
| Determinism gate         | `python3 scripts/generate_synthetic.py --check`; compares two complete regenerations and committed bytes |

A view contains `time_ms`, nullable `selected`, `tau`, receiver `positions` and `clock_corrected`. Positions use fictional local XY metres in [−100, 100]. This deliberately restricted format cannot ingest real BLE observations. To add a teaching scenario, change the generator and schema, regenerate fixtures, update tests, and submit the resulting manifest for privacy review.

Exports use the name `synthetic-ble-project.json` and retain mandatory synthetic markers at project and fixture level. Import first validates bounded JSON and canonical fixture bytes, then displays a restore review. Confirming exports the current view as a backup before atomically replacing saved state. An export is user-controlled local download, never an upload.

A future real-data integration requires a separate design review, explicit authorization, privacy threat model and opt-in network configuration. The public default must remain synthetic and offline-capable after its local static resources load.
