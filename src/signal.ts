import type { Session } from "./data";
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
const cache = new WeakMap<Session, Map<number, Float32Array>>();
const MAX_TAU_PER_SESSION = 20;
export function smoothed(s: Session, tau: number) {
  let sessionMap = cache.get(s);
  if (!sessionMap) {
    sessionMap = new Map();
    cache.set(s, sessionMap);
  } else {
    const hit = sessionMap.get(tau);
    if (hit) return hit;
  }
  // LRU eviction: remove oldest if at capacity
  if (sessionMap.size >= MAX_TAU_PER_SESSION) {
    const firstKey = sessionMap.keys().next().value;
    sessionMap.delete(firstKey);
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
  sessionMap.set(tau, values);
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
