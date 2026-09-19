/**
 * useSignalWorker — issue #20 [M3]
 *
 * Manages the lifecycle of the signal-processing Web Worker and exposes
 * a typed async API for smoothed signals, observation windows, and histograms.
 * The worker runs off the main thread so UI frames are never blocked by
 * large-session computation.
 */

import { useEffect, useRef, useState } from "react";
import type { Session } from "../data";

let workerInstance: Worker | null = null;
let nextId = 0;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL("../workers/signal.worker.ts", import.meta.url),
      { type: "module" },
    );
  }
  return workerInstance;
}

function callWorker<T>(type: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const pending: Pending = {
      resolve: resolve as (value: unknown) => void,
      reject,
    };
    getWorker().postMessage({ id, type, payload });
    // Stash the handler keyed by id — cleaned up when the response arrives
    handlers.set(id, pending);
  });
}

// Module-level handler map so we can respond to out-of-order messages
const handlers = new Map<number, Pending>();

// Register the onmessage handler once when the module loads.
// The worker posts responses as { id, result | error }.
function initWorker() {
  if (handlers.size === 0) {
    getWorker().onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data;
      const pending = handlers.get(id);
      if (pending) {
        handlers.delete(id);
        if (error !== undefined) pending.reject(error);
        else pending.resolve(result);
      }
    };
  }
}

initWorker();

// ─── Public API ───────────────────────────────────────────────────────────────

export function useSmoothedWorker(session: Session, tau: number) {
  const [smoothed, setSmoothed] = useState<Float32Array | null>(null);
  const cache = useRef<Map<number, Float32Array>>(new Map());

  useEffect(() => {
    const cached = cache.current.get(tau);
    if (cached) {
      setSmoothed(cached);
      return;
    }
    let cancelled = false;
    void callWorker<{ values: number[] }>("smoothed", {
      t: Array.from(session.t),
      rssi: Array.from(session.rssi),
      beacon: Array.from(session.beacon),
      receiver: Array.from(session.receiver),
      tau,
    }).then((res) => {
      if (cancelled) return;
      const arr = Float32Array.from(res.values);
      cache.current.set(tau, arr);
      setSmoothed(arr);
    });
    return () => {
      cancelled = true;
    };
  }, [session, tau]);

  return smoothed;
}

export interface ObsResult {
  index: number;
  raw: number;
  smooth: number;
  age: number;
  alpha: number;
}

export function useObservationsWorker(
  session: Session,
  time: number,
  receiverIdx: number,
  tau: number,
) {
  const [obs, setObs] = useState<Array<ObsResult | null> | null>(null);
  const cache = useRef<Map<string, Array<ObsResult | null>>>(new Map());

  useEffect(() => {
    const key = `${time}-${receiverIdx}-${tau}`;
    const cached = cache.current.get(key);
    if (cached) {
      setObs(cached);
      return;
    }
    let cancelled = false;
    void callWorker<Array<ObsResult | null>>("observations", {
      t: Array.from(session.t),
      rssi: Array.from(session.rssi),
      beacon: Array.from(session.beacon),
      receiver: Array.from(session.receiver),
      indices: session.indices.map((a) => Array.from(a)),
      tau,
      time,
      receiverIdx,
    }).then((res) => {
      if (cancelled) return;
      cache.current.set(key, res);
      setObs(res);
    });
    return () => {
      cancelled = true;
    };
  }, [session, time, receiverIdx, tau]);

  return obs;
}

export function useHistogramWorker(
  session: Session,
  bins: number,
  binMs: number,
) {
  const [hist, setHist] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void callWorker<number[]>("histogram", {
      t: Array.from(session.t),
      bins,
      binMs,
    }).then((res) => {
      if (cancelled) return;
      setHist(res);
    });
    return () => {
      cancelled = true;
    };
  }, [session, bins, binMs]);

  return hist;
}
