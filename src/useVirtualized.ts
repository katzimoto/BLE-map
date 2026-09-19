/**
 * useVirtualized — virtualized rendering hook.
 *
 * Given a list of items with a data-driven "key" extractor and a
 * isVisible(item, viewport) predicate, returns the subset of items that
 * should be rendered for the current viewport.  The caller supplies the
 * viewport bounds; this hook only computes the filtered set.
 *
 * This avoids holding DOM nodes for off-screen items and keeps render cost
 * O(visible) regardless of the total number of events / beacons.
 *
 * Usage:
 *   const visible = useVirtualized({
 *     items: session.fixture.beacons,
 *     isVisible: (beacon, vp) =>
 *       Math.hypot(beacon.x_m - vp.centerX, beacon.y_m - vp.centerY) < vp.radius,
 *     viewport,
 *   });
 */

export interface Viewport {
  centerX: number;
  centerY: number;
  /** Viewport radius in the same units as item positions (metres) */
  radius: number;
}

interface UseVirtualizedOptions<T> {
  items: readonly T[];
  /** Returns true when an item falls within the given viewport. */
  isVisible: (item: T, vp: Viewport) => boolean;
  viewport: Viewport | null;
}

export function useVirtualized<T>({
  items,
  isVisible,
  viewport,
}: UseVirtualizedOptions<T>): T[] {
  if (!viewport) return [];
  return items.filter((item) => isVisible(item, viewport));
}
