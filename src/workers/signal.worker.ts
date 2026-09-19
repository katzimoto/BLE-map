/**
 * Signal-processing Web Worker — issue #20 [M3]
 *
 * Runs EMA smoothing and observation-window computation off the main thread,
 * keeping the UI responsive even with sessions containing millions of events.
 *
 * Memory is bounded by:
 *   - CHUNK_SIZE: number of events processed per micro-task yield
 *   - MAX_CACHED_TAUS: max tau values cached per session (LRU evicted)
 *   - MAX_CACHED_SESSIONS: max sessions kept in memory (LRU evicted)
 *
 * Transfers rather than copies typed arrays where possible to minimise GC
 * pressure during large-batch processing.
 */

const CHUNK_SIZE = 50_000;
const MAX_CACHED_TAUS = 10;
const MAX_CACHED_SESSIONS = 8;

// ─── LRU cache for smoothed values ──────────────────────────────────────────

type CachedTau = {
  values: Float32Array;
  tau: number;
};

const outer = new Map<string, Map<number, CachedTau>>();
const sessionOrder: string[] = [];

function sessionKey(
  t: Uint32Array,
  beacon: Uint8Array,
  receiver: Uint8Array,
): string {
  // Simple fingerprint: first/last timestamps + lengths
  return `${t[0]}-${t[t.length - 1]}-${t.length}-${beacon[0]}-${receiver[0]}`;
}

function touchSession(key: string) {
  const idx = sessionOrder.indexOf(key);
  if (idx !== -1) sessionOrder.splice(idx, 1);
  sessionOrder.push(key);
}

function evictSession() {
  const oldest = sessionOrder.shift();
  if (oldest) outer.delete(oldest);
}

// ─── EMA helper (pure, no side effects) ──────────────────────────────────────

function ema(previous: number, next: number, dt: number, tau: number): number {
  return previous + (next - previous) * -Math.expm1(-dt / tau);
}

// ─── Chunked smoothed computation with explicit yield points ──────────────────

/**
 * Compute EMA-smoothed values in chunks, yielding to the event loop between
 * chunks so the worker never blocks the browser for extended periods.
 */
async function smoothedChunked(
  t: Uint32Array,
  rssi: Int8Array,
  beacon: Uint8Array,
  receiver: Uint8Array,
  tau: number,
  sessionKeyStr: string,
): Promise<Float32Array> {
  const n = t.length;
  const values = new Float32Array(n);

  // Session-level LRU
  if (outer.size >= MAX_CACHED_SESSIONS && !outer.has(sessionKeyStr)) {
    evictSession();
  }

  let inner = outer.get(sessionKeyStr);
  if (!inner) {
    inner = new Map();
    outer.set(sessionKeyStr, inner);
  }

  // Tau-level LRU
  if (inner.size >= MAX_CACHED_TAUS) {
    const oldestTau = inner.keys().next().value;
    if (oldestTau !== undefined) inner.delete(oldestTau);
  }

  const existing = inner.get(tau);
  if (existing) {
    inner.delete(tau);
    inner.set(tau, existing);
    touchSession(sessionKeyStr);
    return existing.values;
  }

  // Process in chunks to avoid blocking — yield every CHUNK_SIZE iterations
  const last = new Map<string, number>();

  for (let start = 0; start < n; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, n);
    for (let i = start; i < end; i++) {
      const key = beacon[i] + "/" + receiver[i];
      const p = last.get(key);
      values[i] =
        p === undefined
          ? rssi[i]
          : ema(values[p], rssi[p], (t[i] - t[p]) / 1000, tau);
      last.set(key, i);
    }
    // Yield to the event loop between chunks
    if (end < n) await 0;
  }

  inner.set(tau, { values, tau });
  touchSession(sessionKeyStr);
  return values;
}

// ─── Chunked observations ────────────────────────────────────────────────────

async function observationsChunked(
  t: Uint32Array,
  rssi: Int8Array,
  beacon: Uint8Array,
  receiver: Uint8Array,
  indices: Uint32Array[],
  samples: Float32Array,
  time: number,
  receiverIdx: number,
  tau: number,
): Promise<
  Array<{
    index: number;
    raw: number;
    smooth: number;
    age: number;
    alpha: number;
  } | null>
> {
  const result: Array<{
    index: number;
    raw: number;
    smooth: number;
    age: number;
    alpha: number;
  } | null> = new Array(indices.length);

  for (let b = 0; b < indices.length; b++) {
    // Binary search for last index at or before `time` for this receiver
    const ix = indices[b];
    let lo = 0,
      hi = ix.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (t[ix[mid]] <= time) lo = mid + 1;
      else hi = mid;
    }
    // lo-1 is the last valid index
    let p = lo - 1;
    while (p >= 0 && (t[ix[p]] > time || receiver[ix[p]] !== receiverIdx)) p--;
    if (p < 0) {
      result[b] = null;
      continue;
    }
    const i = ix[p];
    const age = time - t[i];

    // opacity: 1 if age < 2000ms, linear fade to 0 at 8000ms
    const alpha =
      age < 0 || age >= 8000 ? 0 : age <= 2000 ? 1 : 1 - (age - 2000) / 6000;

    result[b] = {
      index: i,
      raw: rssi[i],
      smooth: ema(samples[i], rssi[i], age / 1000, tau),
      age,
      alpha,
    };

    // Yield periodically so UI stays responsive
    if (b % CHUNK_SIZE === 0) await 0;
  }

  return result;
}

// ─── Chunked histogram ───────────────────────────────────────────────────────

async function histogramChunked(
  t: Uint32Array,
  bins: number,
  binMs: number,
): Promise<number[]> {
  const h = new Array(bins).fill(0);
  for (let i = 0; i < t.length; i++) {
    h[Math.min(bins - 1, Math.floor(t[i] / binMs))]++;
    if (i % CHUNK_SIZE === 0 && i > 0) await 0;
  }
  return h;
}

// ─── Message handling ────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const { id, type, payload } = e.data;

  try {
    switch (type) {
      case "smoothed": {
        const { t, rssi, beacon, receiver, tau } = payload;
        const key = sessionKey(t, beacon, receiver);
        const values = await smoothedChunked(
          t,
          rssi,
          beacon,
          receiver,
          tau,
          key,
        );
        // Transfer the buffer to avoid a copy on the main thread
        self.postMessage(
          { id, result: { values: Array.from(values) } },
          {
            transfer: [values.buffer],
          },
        );
        break;
      }

      case "observations": {
        const { t, rssi, beacon, receiver, indices, tau, time, receiverIdx } =
          payload;
        // First ensure we have smoothed values cached
        const key = sessionKey(t, beacon, receiver);
        if (!outer.has(key) || !outer.get(key)!.has(tau)) {
          await smoothedChunked(t, rssi, beacon, receiver, tau, key);
        }
        const samples = outer.get(key)!.get(tau)!.values;
        const result = await observationsChunked(
          t,
          rssi,
          beacon,
          receiver,
          indices,
          samples,
          time,
          receiverIdx,
          tau,
        );
        self.postMessage({ id, result });
        break;
      }

      case "histogram": {
        const { t, bins, binMs } = payload;
        const result = await histogramChunked(t, bins, binMs);
        self.postMessage({ id, result });
        break;
      }

      case "clear": {
        outer.clear();
        sessionOrder.length = 0;
        self.postMessage({ id, result: true });
        break;
      }

      default:
        self.postMessage({
          id,
          error: `Unknown message type: ${type}`,
        });
    }
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
