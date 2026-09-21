/**
 * viewport3d — compute the visible frustum in world-space metres from a Three.js camera.
 *
 * Used by virtualized rendering to limit DOM / scene-graph work to only the
 * beacons that fall within the current camera frustum.  The frustum is
 * approximated as a sphere (inscribed in the view frustum) for simplicity;
 * switch to a proper Frustum if non-uniform aspect ratios cause culling issues.
 */

import type { Camera } from "three";
import { Vector3, PerspectiveCamera } from "three";

const _tmp = new Vector3();

/**
 * Returns a world-space sphere (centre + radius in metres) that is guaranteed
 * to be fully contained within the camera frustum.  All items inside this
 * sphere are definitely visible; items outside may or may not be visible
 * (conservative — some off-screen items may pass the test on wide aspect ratios).
 */
export function frustumToSphere(camera: Camera): { cx: number; cy: number; cz: number; radius: number } {
  // Only PerspectiveCamera has fov / aspect
  const pcam = camera as PerspectiveCamera;
  const d = camera.position.distanceTo(camera.userData.target ?? camera.position.clone().addScaledVector(camera.getWorldDirection(_tmp), 1));
  const fovRad = (pcam.fov * Math.PI) / 180;
  const aspect = pcam.aspect;
  const halfH = d * Math.tan(fovRad / 2);
  const halfW = halfH * aspect;
  const radius = Math.sqrt(halfH * halfH + halfW * halfW);
  _tmp.copy(camera.position).addScaledVector(camera.getWorldDirection(_tmp), d);
  return { cx: _tmp.x, cy: _tmp.y, cz: _tmp.z, radius };
}

/**
 * Returns true when a world-space point is inside the camera frustum.
 * Uses a sphere approximation for speed; exact frustum checks require
 * calling `frustum.containsPoint` after `frustum.setFromProjectionMatrix`.
 */
export function isPointVisible(
  camera: Camera,
  x: number,
  y: number,
  z: number,
): boolean {
  const { cx, cy, cz, radius } = frustumToSphere(camera);
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2);
  return dist <= radius;
}
