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
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("synthetic-ble-lab", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("projects");
    request.onerror = () => reject(new Error("Browser storage unavailable."));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function saveProject(project: Project) {
  const status = await durability(true),
    db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put(project, "current");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(new Error("Project save failed; export a backup."));
    });
    return status;
  } finally {
    db.close();
  }
}
export async function loadProject(manifest: Manifest) {
  const db = await database();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("projects"),
        r = tx.objectStore("projects").get("current");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Project read failed."));
    });
    return value ? validateProject(value, manifest) : null;
  } finally {
    db.close();
  }
}
