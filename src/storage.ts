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
