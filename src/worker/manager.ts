/**
 * estimation.manager — main-thread client for the estimation Web Worker.
 *
 * Wraps the worker in a typed, promise-based API so callers don't deal with
 * raw postMessage.  The manager serialises the Session to the flat form needed
 * by the worker and handles all message routing internally.
 *
 * Memory contract: the manager itself holds no event data — it only holds the
 * SessionDescriptor (typed-array references that are shared with the worker via
 * transfer) and the accumulated position cache (bounded Map).
 */

import type {
  ChunkMeta,
  PositionResult,
  ReceiverFlat,
  SessionDescriptor,
  WorkerCommand,
  WorkerEvent,
  WorkerStats,
} from "./messages";

/** Map from beacon index → latest PositionResult */
export type PositionCache = ReadonlyMap<number, PositionResult>;

interface ActiveRequest {
  timeMs: number;
  windowMs: number;
  resolve: (positions: PositionResult[]) => void;
  reject: (err: unknown) => void;
}

export class EstimationManager {
  private _worker: Worker;
  private _ready = false;
  private _pendingInit: Promise<void> | null = null;
  private _activeRequest: ActiveRequest | null = null;
  private _positionCache = new Map<number, PositionResult>();
  private _stats: WorkerStats = {
    totalEventsProcessed: 0,
    windowHits: 0,
    lastChunkMs: 0,
    memoryMB: 0,
  };

  constructor() {
    this._worker = new Worker(
      new URL("./estimation.worker.ts", import.meta.url),
      { type: "module" },
    );
    this._worker.onmessage = this._onWorkerMessage.bind(this);
    this._worker.onmessageerror = (e) => {
      console.error("[EstimationManager] messageerror", e);
    };
  }

  /** Initialise the worker with a session. Transferable typed arrays = zero-copy. */
  async init(session: SessionDescriptor, receivers: ReceiverFlat[]): Promise<void> {
    if (this._pendingInit) return this._pendingInit;
    this._pendingInit = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        this._ready = true;
        resolve();
      };
      const handler = (ev: MessageEvent<WorkerEvent>) => {
        if (ev.data.type === "ready") {
          this._worker.removeEventListener("message", handler as EventListener);
          onReady();
        }
        if (ev.data.type === "error") {
          this._worker.removeEventListener("message", handler as EventListener);
          reject(new Error(ev.data.message));
        }
      };
      this._worker.addEventListener("message", handler as EventListener);
    });

    this._send({ type: "init", session, receivers });
    return this._pendingInit;
  }

  /**
   * Request position estimates for a given time and window.
   * Returns a promise that resolves to all beacon positions.
   * While a request is in-flight, subsequent calls replace the pending one.
   */
  async getPositions(
    timeMs: number,
    windowMs: number,
  ): Promise<PositionResult[]> {
    // Cancel any in-flight request — it is superseded by this one
    if (this._activeRequest) {
      this._activeRequest.reject(new Error("Superseded by a newer request"));
      this._activeRequest = null;
    }

    return new Promise<PositionResult[]>((resolve, reject) => {
      this._activeRequest = { timeMs, windowMs, resolve, reject };
      this._send({ type: "requestChunk", timeMs, windowMs });
    });
  }

  /** Update receiver positions / calibration without re-init. */
  updateReceivers(receivers: ReceiverFlat[]): void {
    this._send({ type: "updateReceivers", receivers });
  }

  /** Explicitly free the sliding-window buffers inside the worker. */
  gc(): void {
    this._send({ type: "gc" });
  }

  /** Latest accumulated positions for all beacons. */
  get positionCache(): PositionCache {
    return this._positionCache;
  }

  /** Latest worker memory / processing stats. */
  get stats(): WorkerStats {
    return this._stats;
  }

  get isReady(): boolean {
    return this._ready;
  }

  terminate(): void {
    this._worker.terminate();
    this._ready = false;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private _send(cmd: WorkerCommand): void {
    this._worker.postMessage(cmd);
  }

  private _onWorkerMessage(e: MessageEvent<WorkerEvent>): void {
    const ev = e.data;
    switch (ev.type) {
      case "chunk": {
        // Merge new positions into the cache
        for (const pos of ev.positions) {
          this._positionCache.set(pos.beacon, pos);
        }
        // Resolve the pending request with only the positions from this chunk
        if (this._activeRequest) {
          this._activeRequest.resolve(ev.positions);
          this._activeRequest = null;
        }
        break;
      }
      case "stats": {
        this._stats = ev.stats;
        break;
      }
      case "ready": {
        this._ready = true;
        break;
      }
      case "error": {
        console.error("[EstimationManager] worker error:", ev.message);
        if (this._activeRequest) {
          this._activeRequest.reject(new Error(ev.message));
          this._activeRequest = null;
        }
        break;
      }
    }
  }
}
