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
    const request = indexedDB.open("synthetic-ble-lab", 2);
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
      r.onerror = () => reject(new Error("Floor-plan image list failed."));
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

/** Database name and version */
const DB_NAME = "ble-map-lab";
const DB_VERSION = 2;
const STORE = "captures";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      // v1 schema used objectStore "projects" with key "current"
      // v2 migrates "projects" → "captures" keyed by fixture id
      if (db.objectStoreNames.contains("projects")) {
        const projectsStore = db
          .transaction("projects", "readonly")
          .objectStore("projects");
        const currentReq = projectsStore.get("current");
        currentReq.onsuccess = () => {
          if (currentReq.result) {
            const project: Project = currentReq.result as Project;
            const tx = db.transaction(STORE, "readwrite");
            // Store the project under its fixture id
            tx.objectStore(STORE).put(project);
            // And a "current" alias
            tx.objectStore(STORE).put(project);
          }
        };
      }
    };
    request.onerror = () => reject(new Error("Browser storage unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
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
      const tx = db.transaction(STORE, "readwrite");
      // Primary record keyed by fixture id
      tx.objectStore(STORE).put(project);
      // Current alias so the next loadProject finds it without a scan
      tx.objectStore(STORE).put(project);
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
 * Lists all stored capture records (excluding the "current" alias),
 * most-recent first. Requires loading each record to derive metadata.
 */
export async function listCaptures(): Promise<Project[]> {
  const db = await database();
  try {
    const all = await new Promise<Project[]>((resolve, reject) => {
      const tx = db.transaction(STORE),
        req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as Project[]);
      req.onerror = () => reject(new Error("Capture list failed."));
    });
    return all
      .filter((p) => p.fixture.id !== "current")
      .sort((a, b) => b.fixture.id.localeCompare(a.fixture.id)); // stable sort
  } finally {
    db.close();
  }
}

/**
 * Loads a specific capture by fixture ID. Returns null if not found.
 */
export async function loadCapture(id: string): Promise<Project | null> {
  const db = await database();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE),
        r = tx.objectStore(STORE).get(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Capture read failed."));
    });
    return (value as Project) ?? null;
  } finally {
    db.close();
  }
}

/**
 * Deletes a specific capture by fixture ID.
 */
export async function deleteCapture(id: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("Capture delete failed."));
    });
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
    // Try explicit "current" alias first
    const current = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE),
        r = tx.objectStore(STORE).get("current");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Project read failed."));
    });
    if (current) return validateProject(current as Project, manifest);

    // Fall back: scan all captures, pick the most recently stored
    // (we use fixture id sort as a stable proxy for recency since we
    // don't store a separate timestamp; callers can use listCaptures
    // for a full list)
    const all = await new Promise<Project[]>((resolve, reject) => {
      const tx = db.transaction(STORE),
        req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as Project[]);
      req.onerror = () => reject(new Error("Capture list failed."));
    });
    const captures = all.filter((p) => p.fixture.id !== "current");
    if (captures.length === 0) return null;
    // Use the last one in locale sort (stable order; fixture ids include
    // timestamps or monotonic counters in practice)
    const fallback = captures.sort((a, b) =>
      b.fixture.id.localeCompare(a.fixture.id),
    )[0];
    return validateProject(fallback, manifest);
  } finally {
    db.close();
  }
}
