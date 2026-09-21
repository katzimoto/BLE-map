import { check, checkProject } from "./generated/validators.mjs";
export type Sample = { distance_m: number; rssi: number };
export type Receiver = {
  id: string;
  label: string;
  x_m: number;
  y_m: number;
  offset_ms: number;
  drift_ppm: number;
  calibration: Sample[];
};
export type Beacon = {
  id: string;
  label: string;
  x_m: number;
  y_m: number;
  rotation_group: string | null;
};
export type Fixture = {
  kind: "synthetic-ble-fixture";
  schema_version: 1;
  synthetic: true;
  id: string;
  label: string;
  generator: {
    name: string;
    version: number;
    seed: number;
    duration_ms: number;
    step_ms: number;
  };
  receivers: Receiver[];
  beacons: Beacon[];
  variants: {
    bytes: number[];
    malformed_ad: boolean;
    extended_or_concatenated: boolean;
  }[];
  events: {
    t: number[];
    rssi: number[];
    beacon: number[];
    receiver: number[];
    counter_ms: number[];
    variant: number[];
  };
};
export type Manifest = {
  synthetic: true;
  generator_version: number;
  fixtures: {
    id: string;
    label: string;
    file: string;
    event_count: number;
    sha256: string;
  }[];
};
export type Project = {
  kind: "synthetic-ble-project";
  schema_version: 1;
  synthetic: true;
  fixture: Fixture;
  view: {
    time_ms: number;
    selected: number | null;
    tau: number;
    positions: { id: string; x_m: number; y_m: number }[];
    clock_corrected: boolean;
  };
};
export function validateFixture(value: unknown): Fixture {
  if (!check(value))
    throw new Error("Only supported synthetic fixture files are accepted.");
  const f = value as Fixture;
  const n = f.events.t.length;
  if (Object.values(f.events).some((a) => a.length !== n))
    throw new Error("Parallel event arrays have different lengths.");
  if (f.events.t.some((t, i, a) => i > 0 && t < a[i - 1]))
    throw new Error("Event time must be nondecreasing; ties are preserved.");
  if (f.events.receiver.some((i) => i >= f.receivers.length))
    throw new Error("Unknown receiver index.");
  return f;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function digestFixture(f: Fixture): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(f) + "\n");
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function approvedFixture(
  value: unknown,
  manifest: Manifest,
): Promise<Fixture> {
  const f = validateFixture(value);
  if (
    (await digestFixture(f)) !==
    manifest.fixtures.find((x) => x.id === f.id)?.sha256
  )
    throw new Error(
      "Fixture does not match the documented synthetic generator. Real or modified observations are rejected.",
    );
  return f;
}
export async function validateProject(
  value: unknown,
  manifest: Manifest,
): Promise<Project> {
  if (!checkProject(value))
    throw new Error("Invalid synthetic project schema.");
  const p = value as Project;
  await approvedFixture(p.fixture, manifest);
  if (
    new Set(p.view.positions.map((x) => x.id)).size !==
      p.fixture.receivers.length ||
    p.view.positions.some(
      (x) => !p.fixture.receivers.some((r) => r.id === x.id),
    )
  )
    throw new Error("Receiver layout does not match the fixture.");
  return p;
}
export type Session = {
  fixture: Fixture;
  t: Uint32Array;
  rssi: Int8Array;
  beacon: Uint8Array;
  receiver: Uint8Array;
  indices: Uint32Array[];
  /** identity → (time → first matching index), built once at hydration */
  byIdentity: Map<number, Map<number, number>>;
  /** identity → time of first event */
  firstTime: Map<number, number>;
  /** identity → time of last event */
  lastTime: Map<number, number>;
};

/** Flat (transfer-friendly) representation of a Session for the Web Worker. */
export type SessionDescriptor = {
  t: Uint32Array;
  rssi: Int8Array;
  beacon: Uint8Array;
  receiver: Uint8Array;
  indices: Uint32Array[];
  /** beacon → (time → first index), encoded as flat [beacon, time, index, ...] */
  byIdentityFlat: number[];
  /** beacon → first event time, encoded as flat [beacon, time, ...] */
  firstTimeFlat: number[];
  /** beacon → last event time, encoded as flat [beacon, time, ...] */
  lastTimeFlat: number[];
  receiverCount: number;
};

/**
 * Serialize a Session into a flat, worker-safe descriptor.
 * The typed arrays are NOT copied — they are transferred (zero-copy).
 * The Map structures are encoded as sorted flat arrays for fast iteration.
 */
export function toDescriptor(s: Session): SessionDescriptor {
  const byIdentityFlat: number[] = [];
  for (const [beacon, timeMap] of s.byIdentity) {
    for (const [time, index] of timeMap) {
      byIdentityFlat.push(beacon, time, index);
    }
  }

  const firstTimeFlat: number[] = [];
  for (const [beacon, time] of s.firstTime) {
    firstTimeFlat.push(beacon, time);
  }

  const lastTimeFlat: number[] = [];
  for (const [beacon, time] of s.lastTime) {
    lastTimeFlat.push(beacon, time);
  }

  return {
    t: s.t,
    rssi: s.rssi,
    beacon: s.beacon,
    receiver: s.receiver,
    indices: s.indices,
    byIdentityFlat,
    firstTimeFlat,
    lastTimeFlat,
    receiverCount: s.fixture.receivers.length,
  };
}
export function hydrate(f: Fixture): Session {
  const indices: number[][] = f.beacons.map(() => []);
  const firstTime = new Map<number, number>();
  const lastTime = new Map<number, number>();
  const byIdentity = new Map<number, Map<number, number>>();
  f.events.t.forEach((t, i) => {
    const b = f.events.beacon[i];
    indices[b].push(i);
    if (!firstTime.has(b)) firstTime.set(b, t);
    lastTime.set(b, t);
    if (!byIdentity.has(b)) byIdentity.set(b, new Map());
    // time → first occurrence for this identity (times are nondecreasing)
    if (!byIdentity.get(b)!.has(t)) byIdentity.get(b)!.set(t, i);
  });
  return {
    fixture: f,
    t: Uint32Array.from(f.events.t),
    rssi: Int8Array.from(f.events.rssi),
    beacon: Uint8Array.from(f.events.beacon),
    receiver: Uint8Array.from(f.events.receiver),
    indices: indices.map((a) => Uint32Array.from(a)),
    byIdentity,
    firstTime,
    lastTime,
  };
}
export function upperBound(a: ArrayLike<number>, value: number): number {
  let lo = 0,
    hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function download(project: Project) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(project, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "synthetic-ble-project.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
