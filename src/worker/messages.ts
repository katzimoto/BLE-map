/**
 * Message types for the position-estimation Web Worker.
 * Uses the Transferable-pattern (postMessage with no Comlink dependency in the worker itself).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of events to process per micro-batch inside the worker. */
export const CHUNK_SIZE = 5000;

/** Maximum number of events to retain in the sliding window. */
export const WINDOW_MAX = 50_000;

// ─── Input / Output ────────────────────────────────────────────────────────────

export interface SessionDescriptor {
  // Typed arrays are transferred (not cloned) for zero-copy passage to the worker.
  t: Uint32Array;
  rssi: Int8Array;
  beacon: Uint8Array;
  receiver: Uint8Array;
  /** Per-beacon sorted index arrays */
  indices: Uint32Array[];
  /** beacon → (time → first index), encoded as flat [beacon, time, index, ...] */
  byIdentityFlat: number[];
  /** beacon → first event time, encoded as flat [beacon, time, ...] */
  firstTimeFlat: number[];
  /** beacon → last event time, encoded as flat [beacon, time, ...] */
  lastTimeFlat: number[];
  /** Number of receivers in the fixture */
  receiverCount: number;
}

export interface ChunkMeta {
  chunkIndex: number;   // 0-based
  chunkCount: number;   // total chunks
  startTime: number;    // ms — window start
  endTime: number;      // ms — window end
  eventCount: number;   // total events in this chunk
  inWindow: number;     // events that fell inside the time window
}

export interface PositionResult {
  beacon: number;
  point: { x_m: number; y_m: number } | null;
  reason: string;
  sensitivity: number | null;
  computedAtMs: number;
}

export interface WorkerStats {
  totalEventsProcessed: number;
  windowHits: number;
  lastChunkMs: number;
  memoryMB: number;
}

// ─── Inbound commands (main → worker) ───────────────────────────────────────

export type WorkerCommand =
  | { type: "init"; session: SessionDescriptor; receivers: ReceiverFlat[] }
  | { type: "requestChunk"; timeMs: number; windowMs: number }
  | { type: "updateReceivers"; receivers: ReceiverFlat[] }
  | { type: "cancel" }
  | { type: "gc" };

/** Flat receiver description — plain serialisable object for worker transfer */
export interface ReceiverFlat {
  id: string;
  x_m: number;
  y_m: number;
  offset_ms: number;
  drift_ppm: number;
  /** Flat calibration: [distance0, rssi0, distance1, rssi1, ...] */
  calibration: number[];
}

// ─── Outbound events (worker → main) ─────────────────────────────────────────

export type WorkerEvent =
  | { type: "chunk"; meta: ChunkMeta; positions: PositionResult[] }
  | { type: "stats"; stats: WorkerStats }
  | { type: "ready" }
  | { type: "error"; message: string };
