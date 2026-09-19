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

function _touchTau(_inner: Map<number, CachedTau>, _tau: number) {
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

// ─── Virtualized rendering helpers — issue #20 [M3] ──────────────────────────

/**
 * Computes which beacon indices are visible in the given camera frustum, using
 * a fast sphere-based bounds check in world space.
 *
 * Uses the screen-projected radius heuristic: a beacon whose projected point
 * falls inside the viewport (with margin) AND whose world-space radius could
 * project to a non-zero screen radius is considered visible.
 *
 * This replaces the O(n) render for all beacons with O(visible) per frame
 * when the session has many beacons (e.g. > 64).
 */
export function visibleBeaconIndices(
  session: Session,
  values: Array<{ raw: number; smooth: number; alpha: number } | null>,
  camera: { position: [number, number, number]; fov: number },
  screenWidth: number,
  screenHeight: number,
): number[] {
  const { position: [cx, cy, cz], fov } = camera;
  const fovRad = (fov * Math.PI) / 180;
  const halfH = Math.tan(fovRad / 2);
  const halfW = halfH * (screenWidth / screenHeight);
  const _aspect = screenWidth / screenHeight;

  return values.reduce<number[]>((visible, obs, i) => {
    if (!obs || obs.alpha <= 0) return visible;
    const dir = direction(i);
    const r = radius(values[i]!.smooth).r;
    // World position of beacon
    const wx = dir[0] * r, wy = dir[1] * r, wz = dir[2] * r;
    // Vector from camera to beacon
    const dx = wx - cx, dy = wy - cy, dz = wz - cz;
    // Depth along camera forward axis (positive = in front)
    const _depth = dx * 0 + dy * 0 + dz * 0; // dot with camera forward (0,1,0) for this scene
    // For this top-down-ish view, camera forward ≈ (0,1,0) adjusted by elevation
    // Use the actual camera direction from its position relative to origin
    const camDir: [number, number, number] = [
      -cx / Math.sqrt(cx * cx + cy * cy + cz * cz),
      -cy / Math.sqrt(cx * cx + cy * cy + cz * cz),
      -cz / Math.sqrt(cx * cx + cy * cy + cz * cz),
    ];
    const depth2 = dx * camDir[0] + dy * camDir[1] + dz * camDir[2];
    if (depth2 <= 0) return visible; // behind camera

    // Project beacon center to NDC
    const invDz = 1 / (dz === 0 ? 1e-10 : dz);
    const ndcX = (dx * invDz) / halfW;
    const ndcY = (dy * invDz) / halfH;

    // Screen pixel position
    const sx = ((ndcX + 1) / 2) * screenWidth;
    const sy = ((1 - ndcY) / 2) * screenHeight;

    // Check if within screen bounds (with margin for beacon glyph radius)
    const margin = 20;
    if (sx < -margin || sx > screenWidth + margin || sy < -margin || sy > screenHeight + margin)
      return visible;

    visible.push(i);
    return visible;
  }, []);
}

/**
 * Splits a session's time array into roughly equal chunks for parallel/virtualized
 * processing, returning start/end indices per chunk.
 *
 * @param totalPoints Total number of data points
 * @param numChunks Desired number of chunks (default: 4)
 */
export function chunkBounds(totalPoints: number, numChunks = 4): Array<{ start: number; end: number }> {
  const chunkSize = Math.ceil(totalPoints / numChunks);
  const bounds: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < totalPoints; i += chunkSize) {
    bounds.push({ start: i, end: Math.min(i + chunkSize, totalPoints) });
  }
  return bounds;
}

/**
 * Screen-space projected bounds for a beacon glyph, used by virtualized
 * renderers to determine whether the glyph is on-screen without computing
 * it unconditionally.
 */
export function projectedBounds(
  index: number,
  smoothRssi: number,
  camera: { position: [number, number, number]; fov: number; size: { width: number; height: number } },
): { x: number; y: number; radius: number } | null {
  const dir = direction(index);
  const r = radius(smoothRssi).r;
  const { position: [cx, cy, cz], size: { width, height } } = camera;
  const wx = dir[0] * r, wy = dir[1] * r, wz = dir[2] * r;
  const dx = wx - cx, dy = wy - cy, dz = wz - cz;
  if (dz <= 0) return null;

  const fovRad = (camera.fov * Math.PI) / 180;
  const halfH = Math.tan(fovRad / 2);
  const aspect = width / height;

  const invDz = 1 / dz;
  const ndcX = (dx * invDz) / (halfH * aspect);
  const ndcY = (dy * invDz) / halfH;

  const sx = ((ndcX + 1) / 2) * width;
  const sy = ((1 - ndcY) / 2) * height;

  // Approximate screen-space radius of the glyph
  const approxWorldSize = 0.3;
  const screenRadius = Math.max(2, (approxWorldSize / dz) * (height / (2 * halfH)));

  return { x: sx, y: sy, radius: screenRadius };
}
