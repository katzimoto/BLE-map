import type { Manifest, Project } from "./data";
import { validateProject } from "./data";

const SCHEMA_VERSION = 2;
const DB_NAME = "synthetic-ble-lab";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    request.onerror = () => reject(new Error("Browser storage unavailable."));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // Version 1: initial schema with only 'projects' store
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects");
      }
      // Version 2: add 'meta' store for schema version and last-saved timestamp
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
        const meta = db.transaction("meta", "readwrite").objectStore("meta");
        meta.put({ key: "schema_version", value: SCHEMA_VERSION });
        meta.put({ key: "last_saved", value: null });
      }
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

export async function saveProject(project: Project) {
  const status = await durability(true),
    db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["projects", "meta"], "readwrite");
      tx.objectStore("projects").put(project, "current");
      tx.objectStore("meta").put(
        { key: "last_saved", value: Date.now() },
      );
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
    if (!value) return null;
    return validateProject(value, manifest);
  } finally {
    db.close();
  }
}

export async function getLastSaved(): Promise<number | null> {
  const db = await database();
  try {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly"),
        r = tx.objectStore("meta").get("last_saved");
      r.onsuccess = () => resolve(r.result?.value ?? null);
      r.onerror = () => reject(new Error("Meta read failed."));
    });
  } finally {
    db.close();
  }
}

export async function getSchemaVersion(): Promise<number | null> {
  const db = await database();
  try {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly"),
        r = tx.objectStore("meta").get("schema_version");
      r.onsuccess = () => resolve(r.result?.value ?? null);
      r.onerror = () => reject(new Error("Meta read failed."));
    });
  } finally {
    db.close();
  }
}

/**
 * Attempt structured recovery from a corrupted or unreadable stored project.
 * Returns null if recovery is not possible or the data is not a valid project.
 */
export async function recoverProject(
  manifest: Manifest,
): Promise<Project | null> {
  const db = await database();
  try {
    // Try to read with a fresh transaction; if the stored data is somehow
    // partial it may still be loadable via validateProject.
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("projects", "readonly"),
        r = tx.objectStore("projects").get("current");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error("Recovery read failed."));
    });
    if (!raw) return null;
    try {
      return validateProject(raw, manifest);
    } catch {
      return null;
    }
  } finally {
    db.close();
  }
}

/**
 * Clear all stored data and reset schema to current version.
 * Use only when recovery has failed and the user has confirmed data loss.
 */
export async function resetStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error("Storage reset failed; the browser may deny access."));
  });
}
