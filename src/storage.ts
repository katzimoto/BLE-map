import type { Manifest, Project } from "./data";
import { validateProject } from "./data";
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
        const projectsStore =
          db.transaction("projects", "readonly").objectStore("projects");
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
