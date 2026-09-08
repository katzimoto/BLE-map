#!/usr/bin/env python3
"""Create fictional relative-time BLE fixtures. No external input is read."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    ("triangle", "Three receivers", 101, 3),
    ("clock-drift", "Clock offset and drift", 202, 3),
    ("collinear", "Degenerate geometry", 303, 3),
    ("sparse", "Sparse reception", 404, 2),
    ("weak-fit", "Unresolved calibration", 505, 3),
]


def canonical(value):
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def encode(value):
    return (json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def ad_valid(data):
    i = 0
    while i < len(data):
        length = data[i]
        if length == 0 or i + length + 1 > len(data):
            return False
        i += length + 1
    return i == len(data)


def fixture(case, label, seed, count):
    rng = random.Random(seed)
    positions = [(-9, -6), (11, -4), (1, 12)]
    if case == "collinear":
        positions = [(-12, 0), (0, 0), (12, 0)]
    receivers = []
    for i in range(count):
        samples = []
        for d in [1, 2, 3] if case == "weak-fit" else [1, 2, 4, 8]:
            for noise in [-9, 9] if case == "weak-fit" else [-1, 1]:
                samples.append({"distance_m": d, "rssi": round(-55 - 20 * math.log10(d) + noise)})
        receivers.append(
            {
                "id": f"example-receiver-{chr(97 + i)}",
                "label": f"Example Receiver {chr(65 + i)}",
                "x_m": positions[i][0],
                "y_m": positions[i][1],
                "offset_ms": [80, -120, 40][i] if case == "clock-drift" else 0,
                "drift_ppm": [200, -150, 90][i] if case == "clock-drift" else 0,
                "calibration": samples,
            }
        )
    beacons = [
        {
            "id": f"synthetic-beacon-{i + 1:03}",
            "label": f"Synthetic Beacon {i + 1:03}",
            "x_m": [-3, 5, 1, -6, 7, 4, 4][i],
            "y_m": [3, 2, -3, -1, 6, -5, -5][i],
            "rotation_group": "simulated-rotation" if i in (5, 6) else None,
        }
        for i in range(7)
    ]
    variants = []
    for data in [[3, 255, 255, 255], [9, 255, 255], [39, 255, 255, 255] + [0] * 36]:
        variants.append(
            {
                "bytes": data,
                "malformed_ad": not ad_valid(data),
                "extended_or_concatenated": len(data) > 31,
            }
        )
    rows = []
    for t in range(0, 48001, 200):
        for b in range(7):
            if b == 5 and t >= 24000 or b == 6 and t < 24000:
                continue
            if b == 4 and t != 4000:
                continue
            if case == "sparse" and b > 1 and t % 3000:
                continue
            for r, receiver in enumerate(receivers):
                time = min(48000, t + b * 3)
                distance = math.hypot(
                    receiver["x_m"] - beacons[b]["x_m"], receiver["y_m"] - beacons[b]["y_m"]
                )
                rssi = max(
                    -120,
                    min(-10, round(-55 - 20 * math.log10(max(1, distance)) + rng.gauss(0, 1.6))),
                )
                counter = round(time * (1 + receiver["drift_ppm"] / 1e6) + receiver["offset_ms"])
                variant = 1 if (t // 200 + b) % 41 == 0 else 2 if (t // 200 + b) % 17 == 0 else 0
                row = [time, rssi, b, r, counter, variant]
                rows.append(row)
                if t % 1400 == 0:
                    rows.append(row[:])
    rows.sort(key=lambda row: row[0])
    return {
        "kind": "synthetic-ble-fixture",
        "schema_version": 1,
        "synthetic": True,
        "id": case,
        "label": label,
        "generator": {
            "name": "ble-map-synthetic",
            "version": 1,
            "seed": seed,
            "duration_ms": 48000,
            "step_ms": 200,
        },
        "receivers": receivers,
        "beacons": beacons,
        "variants": variants,
        "events": {
            key: [row[i] for row in rows]
            for i, key in enumerate(["t", "rssi", "beacon", "receiver", "counter_ms", "variant"])
        },
    }


def generate(output):
    output.mkdir(parents=True, exist_ok=True)
    entries = []
    for case, label, seed, count in CASES:
        data = fixture(case, label, seed, count)
        encoded = encode(data)
        (output / (case + ".json")).write_bytes(encoded)
        entries.append(
            {
                "id": case,
                "label": label,
                "file": case + ".json",
                "event_count": len(data["events"]["t"]),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }
        )
    (output / "manifest.json").write_bytes(
        encode({"synthetic": True, "generator_version": 1, "fixtures": entries})
    )


def verify():
    with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
        generate(Path(a))
        generate(Path(b))
        for f in Path(a).iterdir():
            assert f.read_bytes() == (Path(b) / f.name).read_bytes(), "Synthetic determinism failed"
            assert f.read_bytes() == (ROOT / "public/fixtures" / f.name).read_bytes(), (
                "Committed fixture differs from generator"
            )
        assert {f.name for f in Path(a).iterdir()} == {
            f.name for f in (ROOT / "public/fixtures").iterdir()
        }, "Unapproved fixture"
    print(
        "Synthetic fixtures: two byte-identical regenerations; every committed observation matches."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "public/fixtures")
    args = parser.parse_args()
    if args.check:
        verify()
    else:
        generate(args.output)
        print("Generated five fictional scenarios and their manifest.")
