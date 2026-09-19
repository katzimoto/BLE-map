import type { Session } from "./data";

/**
 * Per-Session smoothed-value cache with LRU eviction.
 *
 * Each Session holds at most `maxTau` tau values; when a new tau exceeds the
 * limit the least-recently-used entry is deleted.  The total number of cached
 * Sessions is bounded by `maxSessions`; the least-recently-used Session is
 * cleared when the limit is exceeded.
 *
 * Both limits are conservative defaults; tune `MAX_SESSIONS` and `MAX_TAU`
 * if your workload has different memory pressure profiles.
 */
const MAX_SESSIONS = 8;
const MAX_TAU = 10;

type CachedTau = {
  values: Float32Array;
  /** Tau this entry represents, stored so we can recreate the key */
  tau: number;
};

export const outer = new Map<Session, Map<number, CachedTau>>();
/** Insertion-order deque for LRU across Sessions (outer LRU) */
const sessionOrder: Session[] = [];

function touchSession(s: Session) {
  const idx = sessionOrder.indexOf(s);
  if (idx !== -1) sessionOrder.splice(idx, 1);
  sessionOrder.push(s);
}

function evictSession() {
  const oldest = sessionOrder.shift();
  if (oldest) outer.delete(oldest);
}

function touchTau(inner: Map<number, CachedTau>, tau: number) {
  // Move to end — done implicitly by re-inserting on next access (Map maintains
  // insertion order; we emulate LRU by re-adding on read miss)
  // For tau-level LRU we maintain per-session insertion order via the inner map.
}

export function radius(rssi: number) {
  const value = Math.max(-120, Math.min(-10, rssi));
  return { r: 1.5 + (10 * (-10 - value)) / 110, clamped: value !== rssi };
}
export function ema(previous: number, next: number, dt: number, tau: number) {
  if (dt < 0 || !Number.isFinite(dt) || tau <= 0)
    throw new Error("Invalid smoothing interval.");
  return previous + (next - previous) * -Math.expm1(-dt / tau);
}
export function opacity(age: number) {
  return age < 0 || age >= 8000 ? 0 : age <= 2000 ? 1 : 1 - (age - 2000) / 6000;
}
export function direction(index: number): [number, number, number] {
  const angle = index * 2.399963229728653,
    y = 0.12 + 0.3 * Math.sin(index * 1.7);
  return [
    Math.cos(angle) * Math.sqrt(1 - y * y),
    y,
    Math.sin(angle) * Math.sqrt(1 - y * y),
  ];
}
export function smoothed(s: Session, tau: number) {
  // Session-level LRU: evict oldest if at capacity
  if (outer.size >= MAX_SESSIONS && !outer.has(s)) evictSession();

  let inner = outer.get(s);
  if (!inner) {
    inner = new Map();
    outer.set(s, inner);
  }

  // Tau-level LRU: if at capacity, evict the oldest tau entry
  if (inner.size >= MAX_TAU) {
    // Map maintains insertion order; first key is least-recently-used tau
    const oldestTau = inner.keys().next().value;
    if (oldestTau !== undefined) inner.delete(oldestTau);
  }

  const existing = inner.get(tau);
  if (existing) {
    // Move to most-recently-used position by re-inserting
    inner.delete(tau);
    inner.set(tau, existing);
    return existing.values;
  }

  const values = new Float32Array(s.t.length);
  const last = new Map<string, number>();
  for (let i = 0; i < s.t.length; i++) {
    const key = s.beacon[i] + "/" + s.receiver[i],
      p = last.get(key);
    values[i] =
      p === undefined
        ? s.rssi[i]
        : ema(values[p], s.rssi[p], (s.t[i] - s.t[p]) / 1000, tau);
    last.set(key, i);
  }
  inner.set(tau, { values, tau });
  touchSession(s);
  return values;
}
export function observations(
  s: Session,
  time: number,
  receiver: number,
  tau: number,
) {
  const samples = smoothed(s, tau);
  return s.indices.map((ix) => {
    let p = ix.length - 1;
    while (p >= 0 && (s.t[ix[p]] > time || s.receiver[ix[p]] !== receiver)) p--;
    if (p < 0) return null;
    const i = ix[p],
      age = time - s.t[i];
    return {
      index: i,
      raw: s.rssi[i],
      smooth: ema(samples[i], s.rssi[i], age / 1000, tau),
      age,
      alpha: opacity(age),
    };
  });
}
