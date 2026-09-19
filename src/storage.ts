import type { Manifest, Project } from "./data";
import { validateProject } from "./data";

// ─── Floor-plan image store ────────────────────────────────────────────────
//
// Floor-plan images are stored in IndexedDB as JPEG blobs, not in localStorage.
// The 5 MB localStorage quota is easily exceeded by uncompressed canvas
// captures; JPEG compression at 0.85 keeps each image well under 100 KB
// while retaining enough fidelity for the fictional layout view.
// ──────────────────────────────────────────────────────────────────────────

export type FloorPlanImage = {
  id: string;
  captured_at: number;
  /** JPEG data URL (base64), already compressed */
  data: string;
};

function imagesDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ble-map-lab-images", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("floorplan-images")) {
        db.createObjectStore("floorplan-images", { keyPath: "id" });
      }
    };
    request.onerror = () => reject(new Error("Image database unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Capture an SVG element as a JPEG data URL, compressed to limit quota impact.
 * The JPEG quality of 0.85 yields ~80–120 KB for a 640×440 layout image,
 * well within the ~5 MB localStorage / IndexedDB budget even for dozens of
 * saved floor plans.
 */
export async function captureFloorPlanSvg(
  svgEl: SVGSVGElement,
  quality = 0.85,
): Promise<string> {
  const { width, height } = svgEl.getBoundingClientRect();
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const blob = new Blob([clone.outerHTML], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(height * devicePixelRatio));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#09121c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      res();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("SVG rasterisation failed."));
    };
    img.src = url;
  });

  return canvas.toDataURL("image/jpeg", quality);
}

/** Save a floor-plan image record to IndexedDB. */
export async function saveFloorPlanImage(img: FloorPlanImage): Promise<void> {
  const db = await imagesDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("floorplan-images", "readwrite");
      tx.objectStore("floorplan-images").put(img);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("Floor-plan image save failed."));
    });
  } finally {
    db.close();
  }
}

/** Load a single floor-plan image record by id, or null if not found. */
export async function loadFloorPlanImage(
  id: string,
): Promise<FloorPlanImage | null> {
  const db = await imagesDatabase();
  try {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("floorplan-images", "readonly");
      const r = tx.objectStore("floorplan-images").get(id);
      r.onsuccess = () => resolve((r.result as FloorPlanImage) ?? null);
      r.onerror = () => reject(new Error("Floor-plan image read failed."));
    });
  } finally {
    db.close();
  }
}

/** List all floor-plan image records ordered by capture time (newest first). */
export async function listFloorPlanImages(): Promise<FloorPlanImage[]> {
  const db = await imagesDatabase();
  try {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("floorplan-images", "readonly");
      const r = tx.objectStore("floorplan-images").getAll();
      r.onsuccess = () =>
        resolve(
          (r.result as FloorPlanImage[]).sort(
            (a, b) => b.captured_at - a.captured_at,
          ),
        );
      r.onerror = () =>
        reject(new Error("Floor-plan image list failed."));
    });
  } finally {
    db.close();
  }
}

/** Delete a floor-plan image record from IndexedDB. */
export async function deleteFloorPlanImage(id: string): Promise<void> {
  const db = await imagesDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("floorplan-images", "readwrite");
      tx.objectStore("floorplan-images").delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("Floor-plan image delete failed."));
    });
  } finally {
    db.close();
  }
}

// ─── Core project store ────────────────────────────────────────────────────

/**
 * Schema version history:
 * v1: single "projects" store; project stored under key "current"
 * v2: "captures" store keyed by fixture id; "current" alias; no meta store
 * v3 (current): adds "meta" store with schema_version and last_saved keys
 *
 * Migration is handled in onupgradeneeded (synchronous) and post-open
 * (asynchronous, after the database first opens). Each migration is idempotent
 * — it checks if its target state already exists before making changes.
 */
const SCHEMA_VERSION = 3;
const DB_NAME = "ble-map-lab";

/**
 * Synchronous migration functions run inside onupgradeneeded.
 * Each runs once when the database is at version v-1 and being upgraded to v.
 */
const MIGRATIONS: Record<number, (db: IDBDatabase) => void> = {
  /**
   * v1 → v2: create the "captures" store.
   * Data migration from "projects/current" → "captures" happens asynchronously
   * in runPostOpenMigrations after the database opens.
   */
  2(db) {
    if (!db.objectStoreNames.contains("captures")) {
      db.createObjectStore("captures");
    }
  },

  /**
   * v2 → v3: add the "meta" object store.
   */
  3(db) {
    if (!db.objectStoreNames.contains("meta")) {
      db.createObjectStore("meta", { keyPath: "key" });
    }
  },
};

/**
 * After the database opens, migrate any legacy data from v1.
 * Called once per database open; safe to invoke repeatedly because
 * each step checks whether migration has already been applied.
 */
async function runPostOpenMigrations(db: IDBDatabase): Promise<void> {
  // Read schema version from meta store (fall back to 1 if meta is empty)
  const storedVersion = await new Promise<number>((resolve) => {
    const tx = db.transaction("meta", "readonly");
    const r = tx.objectStore("meta").get("schema_version");
    r.onsuccess = () =>
      resolve(
        (r.result as { key: string; value: number } | undefined)?.value ?? 1,
      );
    r.onerror = () => resolve(1);
  });

  if (storedVersion < 2 && db.objectStoreNames.contains("projects")) {
    await migrateV1ProjectsToCaptures(db);
  }
}

async function migrateV1ProjectsToCaptures(db: IDBDatabase): Promise<void> {
  const project = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction("projects", "readonly");
    const r = tx.objectStore("projects").get("current");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error("V1 project read failed."));
  });

  if (!project) return;

  const p = project as Project;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("captures", "readwrite");
    tx.objectStore("captures").put(p, p.fixture.id);
    tx.objectStore("captures").put(p, "current");
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error("V1→V2 migration failed."));
  });
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    request.onerror = () => reject(new Error("Browser storage unavailable."));
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      // Run all migrations from oldVersion through SCHEMA_VERSION
      for (
        let v = Math.max(oldVersion + 1, 1);
        v <= SCHEMA_VERSION;
        v++
      ) {
        const mig = MIGRATIONS[v];
        if (mig) mig(db);
      }

      // Always ensure the required stores exist after migrations
      if (!db.objectStoreNames.contains("captures")) {
        db.createObjectStore("captures");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
        const meta = db.transaction("meta", "readwrite").objectStore("meta");
        meta.put({ key: "schema_version", value: SCHEMA_VERSION });
        meta.put({ key: "last_saved", value: null });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      runPostOpenMigrations(db).catch(() => {
        // Non-fatal: the next save will retry migration if needed.
      });
      resolve(db);
    };
  });
}

export async function durability(request = false) {
  const s = navigator.storage;
  if (!s?.persisted)
    return "Persistence unavailable; retain an exported synthetic project.";
  try {
    const granted = await s.persisted();
    if (granted) return "Persistent storage granted; keep a separate backup.";
    if (!request)
      return "Best-effort storage; persistence has not been requested.";
    return (await s.persist())
      ? "Persistent storage granted; keep a separate backup."
      : "Persistence not granted; keep an exported project.";
  } catch {
    return "Persistence could not be checked; keep an exported project.";
  }
}

/**
 * Saves the project as an individual capture record keyed by its fixture ID.
 * Also maintains a "current" alias so loadProject() can find it without
 * needing to scan.
 */
export async function saveProject(project: Project) {
  const status = await durability(true),
    db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["captures", "meta"], "readwrite");
      tx.objectStore("captures").put(project, project.fixture.id);
      tx.objectStore("captures").put(project, "current");
      tx.objectStore("meta").put({ key: "last_saved", value: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("Project save failed; export a backup."));
    });
    return status;
  } finally {
    db.close();
  }
}

/**
 * Loads the project the user most recently saved. First tries the "current"
 * alias; falls back to the most-recent capture by fixture id sort order.
 */
export async function loadProject(manifest: Manifest): Promise<Project | null> {
  const db = await database();
  try {
    const current = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("captures"),
        r = tx.objectStore("captures").get("current");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Project read failed."));
    });
    if (current) return validateProject(current as Project, manifest);

    const all = await new Promise<Project[]>((resolve, reject) => {
      const tx = db.transaction("captures"),
        req = tx.objectStore("captures").getAll();
      req.onsuccess = () => resolve(req.result as Project[]);
      req.onerror = () => reject(new Error("Capture list failed."));
    });
    const captures = all.filter((p) => p.fixture.id !== "current");
    if (captures.length === 0) return null;
    const fallback = captures.sort((a, b) =>
      b.fixture.id.localeCompare(a.fixture.id),
    )[0];
    return validateProject(fallback, manifest);
  } finally {
    db.close();
  }
}

/**
 * Lists all stored capture records (excluding the "current" alias),
 * sorted by fixture id descending as a stable proxy for recency.
 */
export async function listCaptures(): Promise<Project[]> {
  const db = await database();
  try {
    const all = await new Promise<Project[]>((resolve, reject) => {
      const tx = db.transaction("captures"),
        req = tx.objectStore("captures").getAll();
      req.onsuccess = () => resolve(req.result as Project[]);
      req.onerror = () => reject(new Error("Capture list failed."));
    });
    return all
      .filter((p) => p.fixture.id !== "current")
      .sort((a, b) => b.fixture.id.localeCompare(a.fixture.id));
  } finally {
    db.close();
  }
}

/** Loads a specific capture by fixture ID. Returns null if not found. */
export async function loadCapture(id: string): Promise<Project | null> {
  const db = await database();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("captures"),
        r = tx.objectStore("captures").get(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Capture read failed."));
    });
    return (value as Project) ?? null;
  } finally {
    db.close();
  }
}

/** Deletes a specific capture by fixture ID. */
export async function deleteCapture(id: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("captures", "readwrite");
      tx.objectStore("captures").delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("Capture delete failed."));
    });
  } finally {
    db.close();
  }
}

/** Returns the timestamp of the last successful save, or null if none. */
export async function getLastSaved(): Promise<number | null> {
  const db = await database();
  try {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly"),
        r = tx.objectStore("meta").get("last_saved");
      r.onsuccess = () =>
        resolve(
          (r.result as { key: string; value: number } | undefined)?.value ??
            null,
        );
      r.onerror = () => reject(new Error("Meta read failed."));
    });
  } finally {
    db.close();
  }
}

/** Returns the current schema version stored in meta, or null if not set. */
export async function getSchemaVersion(): Promise<number | null> {
  const db = await database();
  try {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly"),
        r = tx.objectStore("meta").get("schema_version");
      r.onsuccess = () =>
        resolve(
          (r.result as { key: string; value: number } | undefined)?.value ??
            null,
        );
      r.onerror = () => reject(new Error("Meta read failed."));
    });
  } finally {
    db.close();
  }
}

/**
 * Attempt structured recovery from a corrupted or unreadable stored project.
 *
 * Recovery strategy:
 * 1. Try "current" alias with validateProject — catches schema violations
 * 2. If that fails, scan all captures and try validateProject on each
 * 3. Return null if no valid project found (caller should offer resetStorage)
 */
export async function recoverProject(
  manifest: Manifest,
): Promise<Project | null> {
  const db = await database();
  try {
    // Strategy 1: validate the "current" alias
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("captures", "readonly"),
        r = tx.objectStore("captures").get("current");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Recovery read failed."));
    });
    if (raw) {
      try {
        return validateProject(raw, manifest);
      } catch {
        // Fall through to scan
      }
    }

    // Strategy 2: scan all captures and try each
    const all = await new Promise<Project[]>((resolve, reject) => {
      const tx = db.transaction("captures", "readonly"),
        req = tx.objectStore("captures").getAll();
      req.onsuccess = () => resolve(req.result as Project[]);
      req.onerror = () => reject(new Error("Recovery scan failed."));
    });
    for (
      const candidate of all.filter((p) => p.fixture.id !== "current")
    ) {
      try {
        return validateProject(candidate, manifest);
      } catch {
        // Try next
      }
    }

    return null;
  } finally {
    db.close();
  }
}

/**
 * Clear all stored data and delete both databases (project store and
 * floor-plan image store). Use only when recovery has failed and the
 * user has confirmed data loss.
 */
export async function resetStorage(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error("Storage reset failed; the browser may deny access."));
  });

  // Also clear the floor plan images database (non-fatal if it fails)
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("ble-map-lab-images");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}
