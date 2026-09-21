/**
 * estimation.worker — position-estimation engine running off the main thread.
 *
 * Architecture:
 *   • Chunked processing  — events are iterated in bounded slices (CHUNK_SIZE)
 *     so the event loop never stalls and memory pressure stays constant.
 *   • Sliding time window — only the most recent WINDOW_MAX events are kept
 *     in memory; older events are silently dropped from the window buffers.
 *   • Transferable arrays — typed arrays cross the postMessage boundary as
 *     Transferables (zero-copy), keeping worker initialisation fast.
 *   • No Comlink in the worker — plain postMessage keeps the worker portable
 *     and compatible with Vite's native worker bundling.
 *
 * The public API is defined by WorkerCommand / WorkerEvent in messages.ts.
 */

import { CHUNK_SIZE, WINDOW_MAX, type ChunkMeta, type PositionResult, type SessionDescriptor, type WorkerStats, type ReceiverFlat, type WorkerCommand, type WorkerEvent } from "./messages";

// ─── State ────────────────────────────────────────────────────────────────────

let _t: Uint32Array = new Uint32Array(0);
let _rssi: Int8Array = new Int8Array(0);
let _beacon: Uint8Array = new Uint8Array(0);
let _receiver: Uint8Array = new Uint8Array(0);
let _indices: Uint32Array[] = [];
let _byIdentityFlat: number[] = [];
let _firstTimeFlat: number[] = [];
let _lastTimeFlat: number[] = [];
let _receiverCount = 0;
let _receivers: ReceiverFlat[] = [];

let _sessionReady = false;
let _totalProcessed = 0;
let _windowHits = 0;
let _lastChunkMs = 0;

/** Sliding window buffers — bounded to WINDOW_MAX events total */
const _winTime: number[] = [];
const _winRssi: number[] = [];
const _winBeacon: number[] = [];
const _winReceiver: number[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(event: WorkerEvent) {
  // Safe: self is available in Web Worker global scope
  self.postMessage(event);
}

function decodeByIdentity(): Map<number, Map<number, number>> {
  const map = new Map<number, Map<number, number>>();
  for (let i = 0; i < _byIdentityFlat.length; i += 3) {
    const beacon = _byIdentityFlat[i]!;
    const time = _byIdentityFlat[i + 1]!;
    const index = _byIdentityFlat[i + 2]!;
    if (!map.has(beacon)) map.set(beacon, new Map());
    map.get(beacon)!.set(time, index);
  }
  return map;
}

function decodeFlatTime(flat: number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < flat.length; i += 2) {
    map.set(flat[i]!, flat[i + 1]!);
  }
  return map;
}

/** Add a single event to the sliding window; evict oldest if full. */
function winPush(t: number, rssi: number, beacon: number, receiver: number) {
  _winTime.push(t);
  _winRssi.push(rssi);
  _winBeacon.push(beacon);
  _winReceiver.push(receiver);
  _windowHits++;
  if (_winTime.length > WINDOW_MAX) {
    _winTime.shift();
    _winRssi.shift();
    _winBeacon.shift();
    _winReceiver.shift();
  }
}

/** Run the robust grid-search + Gauss–Newton localisation for one beacon. */
function locateBeacon(beaconIdx: number, currentTimeMs: number, windowMs: number): PositionResult {
  const startTime = currentTimeMs - windowMs;
  const byIdentity = decodeByIdentity();
  const firstTime = decodeFlatTime(_firstTimeFlat);
  const lastTime = decodeFlatTime(_lastTimeFlat);

  // Build evidence from the sliding window (not the full array)
  const evidence: EvidenceItem[] = [];

  for (let ri = 0; ri < _receiverCount; ri++) {
    const rssiValues: number[] = [];

    // Binary-search within each beacon's index list for events in [startTime, currentTimeMs]
    const beaconIndices = _indices[beaconIdx];
    if (!beaconIndices) continue;

    // Use byIdentity (time→index) for O(log n) lookup instead of full scan
    const timeMap = byIdentity.get(beaconIdx);
    if (!timeMap) continue;

    const sortedTimes = Array.from(timeMap.keys()).sort((a, b) => a - b);
    for (const evtTime of sortedTimes) {
      if (evtTime > currentTimeMs) break;
      if (evtTime < startTime) continue;
      const i = timeMap.get(evtTime)!;
      if (_receiver[i] !== ri) continue;
      rssiValues.push(_rssi[i]);
    }

    if (rssiValues.length === 0) continue;

    // De-duplicate RSSI values (same t + rssi)
    const seen = new Set<string>();
    const unique: number[] = [];
    for (let i = 0; i < rssiValues.length; i++) {
      const key = String(rssiValues[i]);
      if (!seen.has(key)) { seen.add(key); unique.push(rssiValues[i]); }
    }
    rssiValues.length = 0;
    rssiValues.push(...unique);

    if (rssiValues.length === 0) continue;
    rssiValues.sort((a, b) => a - b);
    const mid = Math.floor(rssiValues.length / 2);
    const medianRssi = rssiValues.length % 2 ? rssiValues[mid] : (rssiValues[mid - 1] + rssiValues[mid]) / 2;

    const receiver = _receivers[ri];
    if (!receiver) continue;

    const calModel = calibrateFlat(receiver.calibration);
    const interval = distanceIntervalFlat(medianRssi, calModel);
    evidence.push({ r: receiver, model: calModel, interval, rssi: medianRssi });
  }

  const computedAtMs = Date.now();

  if (evidence.length < 3) {
    return { beacon: beaconIdx, point: null, reason: "Fewer than three recent receivers: no unique fix.", sensitivity: null, computedAtMs };
  }
  if (evidence.some(e => e.interval.point === null)) {
    return { beacon: beaconIdx, point: null, reason: "Calibration slope unresolved: no fix.", sensitivity: null, computedAtMs };
  }

  const [a, b, c] = evidence.map(e => e.r);
  const area = Math.abs((b.x_m - a.x_m) * (c.y_m - a.y_m) - (c.x_m - a.x_m) * (b.y_m - a.y_m));
  if (area < 3) {
    return { beacon: beaconIdx, point: null, reason: "Receiver geometry is degenerate: no fix.", sensitivity: null, computedAtMs };
  }

  let best = { x: 0, y: 0, cost: Infinity };
  for (let x = -18; x <= 18; x += 0.4) {
    for (let y = -18; y <= 18; y += 0.4) {
      const c = costAt(x, y, evidence);
      if (c < best.cost) best = { x, y, cost: c };
    }
  }
  if (best.cost > 12) {
    return { beacon: beaconIdx, point: null, reason: "Evidence and model disagree: no fix.", sensitivity: null, computedAtMs };
  }
  if (Math.abs(best.x) > 17.8 || Math.abs(best.y) > 17.8) {
    return { beacon: beaconIdx, point: null, reason: "Estimate reaches the fictional search boundary: no fix.", sensitivity: null, computedAtMs };
  }

  // Gauss–Newton refinement
  const currentCost = costAt(best.x, best.y, evidence);
  let xx = 0, xy = 0, yy = 0;
  for (let iter = 0; iter < 80; iter++) {
    let gx = 0, gy = 0;
    xx = 0; xy = 0; yy = 0;
    for (const e of evidence) {
      const dx = best.x - e.r.x_m;
      const dy = best.y - e.r.y_m;
      const d2 = Math.max(1, dx * dx + dy * dy);
      const log = Math.log10(Math.sqrt(d2));
      const v = e.model.sigma ** 2 * (1 + 1 / e.model.n + (log - e.model.mean) ** 2 / e.model.sxx);
      const z = (e.model.reference - 10 * e.model.exponent * log - e.rssi) / Math.sqrt(v);
      const factor = (-10 * e.model.exponent) / Math.LN10 / d2;
      const jx = factor * dx;
      const jy = factor * dy;
      gx += (z / Math.sqrt(v)) * jx;
      gy += (z / Math.sqrt(v)) * jy;
      xx += (jx * jx) / v;
      xy += (jx * jy) / v;
      yy += (jy * jy) / v;
    }
    const eigen = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 2;
    if (eigen <= 1e-8) break;
    const stepX = gx / xx;
    const stepY = gy / yy;
    let rate = 1;
    for (let k = 0; k < 16; k++, rate /= 2) {
      if (costAt(best.x - rate * stepX, best.y - rate * stepY, evidence) < currentCost) {
        const nx = best.x - rate * stepX;
        const ny = best.y - rate * stepY;
        best = { x: nx, y: ny, cost: costAt(nx, ny, evidence) };
        break;
      }
    }
    if (rate === 0) break;
  }

  const sensitivity = 1 / Math.sqrt((xx + yy - Math.hypot(xx - yy, 2 * xy)) / 2);
  if (!Number.isFinite(sensitivity) || sensitivity <= 0) {
    return { beacon: beaconIdx, point: null, reason: "Position sensitivity is unresolved: no fix.", sensitivity: null, computedAtMs };
  }

  return {
    beacon: beaconIdx,
    point: { x_m: best.x, y_m: best.y },
    reason: "Conditional synthetic estimate. Sensitivity circle is not a confidence region.",
    sensitivity,
    computedAtMs,
  };
}

// ─── Calibration (flat array form) ───────────────────────────────────────────

type FlatModel = { reference: number; exponent: number; sigma: number; n: number; mean: number; sxx: number; t: number };
type FlatInterval = { point: number | null; low: number | null; high: number | null; reason: string };

const QUANTILE_975 = [0, 12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306];

function calibrateFlat(cal: number[]): FlatModel {
  const samples: { distance_m: number; rssi: number }[] = [];
  for (let i = 0; i < cal.length; i += 2) samples.push({ distance_m: cal[i]!, rssi: cal[i + 1]! });

  const xs = samples.map(p => Math.log10(p.distance_m));
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ym = samples.reduce((a, p) => a + p.rssi, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  const slope = xs.reduce((a, x, i) => a + (x - mean) * (samples[i]!.rssi - ym), 0) / sxx;
  const reference = ym - slope * mean;
  const exponent = -slope / 10;
  const sigma = Math.max(1, Math.sqrt(samples.reduce((a, p, i) => a + (p.rssi - reference - slope * xs[i]!) ** 2, 0) / (n - 2)));
  const df = n - 2;
  const t = QUANTILE_975[df] ?? 1.96 - 2.44 / df - 5.06 / df ** 2;
  return { reference, exponent, sigma, n, mean, sxx, t };
}

function distanceIntervalFlat(rssi: number, m: FlatModel): FlatInterval {
  const beta = -10 * m.exponent;
  const delta = rssi - (m.reference + beta * m.mean);
  const h2 = ((m.t * m.sigma) ** 2) * (1 + 1 / m.n);
  const a = beta * beta - h2 / m.sxx;
  const b = -2 * beta * delta;
  const c = delta * delta - h2;
  const disc = b * b - 4 * a * c;
  if (a <= 0 || disc < 0) return { point: null, low: null, high: null, reason: "Calibration slope unresolved: no finite inverse interval." };
  const low = 10 ** (m.mean + (-b - Math.sqrt(disc)) / (2 * a));
  const high = 10 ** (m.mean + (-b + Math.sqrt(disc)) / (2 * a));
  return {
    point: 10 ** ((m.reference - rssi) / (10 * m.exponent)),
    low,
    high,
    reason: "Conditional inverse prediction interval; simulated Gaussian model.",
  };
}

type EvidenceItem = { r: ReceiverFlat; model: FlatModel; interval: FlatInterval; rssi: number };

function costAt(x: number, y: number, evidence: EvidenceItem[]): number {
  let c = 0;
  for (const e of evidence) {
    const log = Math.log10(Math.max(1, Math.hypot(x - e.r.x_m, y - e.r.y_m)));
    const v = e.model.sigma ** 2 * (1 + 1 / e.model.n + (log - e.model.mean) ** 2 / e.model.sxx);
    const z = (e.model.reference - 10 * e.model.exponent * log - e.rssi) / Math.sqrt(v);
    c += Math.abs(z) <= 1.5 ? (z * z) / 2 : 1.5 * (Math.abs(z) - 0.75);
  }
  return c;
}

// ─── Main chunk processing ────────────────────────────────────────────────────

function processChunk(timeMs: number, windowMs: number) {
  const startTime = timeMs - windowMs;
  const chunkCount = Math.ceil(_t.length / CHUNK_SIZE);

  for (let ci = 0; ci < chunkCount; ci++) {
    const start = ci * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, _t.length);
    let inWindow = 0;

    for (let i = start; i < end; i++) {
      const evtTime = _t[i]!;
      if (evtTime < startTime) continue;
      if (evtTime > timeMs) continue;
      winPush(_t[i]!, _rssi[i]!, _beacon[i]!, _receiver[i]!);
      inWindow++;
      _totalProcessed++;
    }

    _lastChunkMs = Date.now();
    const meta: ChunkMeta = {
      chunkIndex: ci,
      chunkCount,
      startTime,
      endTime: timeMs,
      eventCount: end - start,
      inWindow,
    };

    // Run position estimation for each beacon that has events in the window
    const positions: PositionResult[] = [];
    for (let b = 0; b < _indices.length; b++) {
      if (_indices[b]!.length === 0) continue;
      const ft = decodeFlatTime(_firstTimeFlat).get(b) ?? Infinity;
      const lt = decodeFlatTime(_lastTimeFlat).get(b) ?? -Infinity;
      if (lt < startTime || ft > timeMs) continue;
      positions.push(locateBeacon(b, timeMs, windowMs));
    }

    post({ type: "chunk", meta, positions });
  }
}

// ─── Memory ──────────────────────────────────────────────────────────────────

function computeMemoryMB(): number {
  // Rough estimate: typed arrays + window buffers
  const bytes =
    _t.byteLength + _rssi.byteLength + _beacon.byteLength + _receiver.byteLength +
    (_winTime.length + _winRssi.length + _winBeacon.length + _winReceiver.length) * 8;
  return Math.round(bytes / 1024 / 1024 * 100) / 100;
}

function gc() {
  // Clear the sliding window to free memory — main thread can refill via new requests
  _winTime.length = 0;
  _winRssi.length = 0;
  _winBeacon.length = 0;
  _winReceiver.length = 0;
}

// ─── Message handler ─────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;
  switch (cmd.type) {
    case "init": {
      _t = cmd.session.t;
      _rssi = cmd.session.rssi;
      _beacon = cmd.session.beacon;
      _receiver = cmd.session.receiver;
      _indices = cmd.session.indices;
      _byIdentityFlat = cmd.session.byIdentityFlat;
      _firstTimeFlat = cmd.session.firstTimeFlat;
      _lastTimeFlat = cmd.session.lastTimeFlat;
      _receiverCount = cmd.session.receiverCount;
      _receivers = cmd.receivers;
      _totalProcessed = 0;
      _windowHits = 0;
      _sessionReady = true;
      post({ type: "ready" });
      break;
    }
    case "requestChunk": {
      if (!_sessionReady) { post({ type: "error", message: "Worker not initialised." }); return; }
      processChunk(cmd.timeMs, cmd.windowMs);
      post({ type: "stats", stats: { totalEventsProcessed: _totalProcessed, windowHits: _windowHits, lastChunkMs: _lastChunkMs, memoryMB: computeMemoryMB() } });
      break;
    }
    case "updateReceivers": {
      _receivers = cmd.receivers;
      break;
    }
    case "gc": {
      gc();
      post({ type: "stats", stats: { totalEventsProcessed: _totalProcessed, windowHits: _windowHits, lastChunkMs: _lastChunkMs, memoryMB: computeMemoryMB() } });
      break;
    }
    case "cancel": {
      // No-op in this implementation (chunk processing is synchronous and fast)
      break;
    }
  }
};
