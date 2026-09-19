import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Session } from "./data";
import { direction, observations, radius, visibleBeaconIndices } from "./signal";
import { useUI } from "./store";
export const COLORS = [
  "#67d5e7",
  "#e9b875",
  "#b3a5ef",
  "#9cd499",
  "#f29aab",
  "#c9d5de",
  "#8ebdef",
];
declare global {
  interface Window {
    __SYNTHETIC_LAB__?: {
      time: number;
      active: number[];
      screen: { id: number; x: number; y: number }[];
    };
  }
}
function Instrument({
  session,
  onRestore,
}: {
  session: Session;
  onRestore: () => void;
}) {
  const { invalidate, gl, camera, size } = useThree(),
    glyphs = useRef<THREE.InstancedMesh>(null),
    rings = useRef<THREE.InstancedMesh>(null);
  const time = useRef(useUI.getState().time),
    version = useRef(-1),
    published = useRef(0),
    visible = useRef<number[]>([]);
  const matrix = useMemo(() => new THREE.Object3D(), []),
    color = useMemo(() => new THREE.Color(), []);
  const lines = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(7 * 6), 3),
    );
    return g;
  }, []);
  const grid = useMemo(() => {
    const points: number[] = [];
    for (const db of [-40, -60, -80, -100]) {
      const r = radius(db).r;
      for (let i = 0; i < 120; i++) {
        if (i % 4 === 3) continue;
        for (const theta of [
          (i / 120) * 2 * Math.PI,
          ((i + 1) / 120) * 2 * Math.PI,
        ])
          points.push(r * Math.cos(theta), 0, r * Math.sin(theta));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return g;
  }, []);
  useEffect(() => {
    const unsub = useUI.subscribe(() => invalidate());
    invalidate();
    let pointer: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      if (
        !pointer ||
        Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 5
      )
        return;
      const box = gl.domElement.getBoundingClientRect();
      const hit = window.__SYNTHETIC_LAB__?.screen
        .map((p) => ({
          ...p,
          distance: Math.hypot(
            p.x - (e.clientX - box.left),
            p.y - (e.clientY - box.top),
          ),
        }))
        .filter((p) => p.distance <= 10)
        .sort((a, b) => a.distance - b.distance)[0];
      if (hit) useUI.setState({ selected: hit.id });
      pointer = null;
    };
    gl.domElement.addEventListener("pointerdown", down);
    gl.domElement.addEventListener("pointerup", up);
    const lost = (e: Event) => {
      e.preventDefault();
      useUI.setState({ playing: false });
    };
    gl.domElement.addEventListener("webglcontextlost", lost);
    gl.domElement.addEventListener("webglcontextrestored", onRestore);
    return () => {
      unsub();
      gl.domElement.removeEventListener("pointerdown", down);
      gl.domElement.removeEventListener("pointerup", up);
      gl.domElement.removeEventListener("webglcontextlost", lost);
      gl.domElement.removeEventListener("webglcontextrestored", onRestore);
      lines.dispose();
      grid.dispose();
    };
  }, [invalidate, gl, onRestore, lines, grid]);
  useFrame((_state, delta) => {
    const ui = useUI.getState();
    if (ui.version !== version.current) {
      time.current = ui.seek;
      version.current = ui.version;
    } else if (ui.playing)
      time.current = Math.min(
        48000,
        time.current + Math.max(0, delta) * 1000 * ui.speed,
      );

    // ── Virtualized rendering: only process beacons whose 3-D position
    //     projects into the visible screen region.  This keeps render cost
    //     O(visible_beacons) regardless of total beacon count.
    const { width, height } = size;
    const PADDING = 40; // px — keep near-screen glyphs alive during fast pans
    const visibleBeaconIndices: number[] = [];
    for (let i = 0; i < session.fixture.beacons.length; i++) {
      if (!session.fixture.beacons[i]!.label.toLowerCase().includes(ui.query.toLowerCase())) continue;
      // Approximate 3-D position from direction + typical radius
      const dir = direction(i);
      const r = 1.5 + (10 * 110) / 110; // max possible radius ≈ 11.5 m
      const world = new THREE.Vector3(dir[0] * r, dir[1] * r, dir[2] * r);
      const projected = world.project(camera);
      const sx = ((projected.x + 1) / 2) * width;
      const sy = ((1 - projected.y) / 2) * height;
      if (sx < -PADDING || sx > width + PADDING || sy < -PADDING || sy > height + PADDING) continue;
      visibleBeaconIndices.push(i);
    }

    const values = useMemo(
      () => observations(session, time.current, ui.receiver, ui.tau),
      [session, time.current, ui.receiver, ui.tau],
    );

    // ── Virtualized rendering — only process visible beacons ─────────────────
    // For large sessions (many beacons), culling to the frustum reduces GPU work.
    // Cast through unknown to convert THREE.Vector3 → tuple and to access fov.
    const cam = camera as unknown as { position: [number, number, number]; fov: number };
    const cameraDesc = useMemo(
      () => ({
        position: cam.position,
        fov: cam.fov,
      }),
      [cam],
    );
    const visibleIds = useMemo(
      () =>
        visibleBeaconIndices(
          session,
          values,
          cameraDesc,
          size.width,
          size.height,
        ),
      [session, values, cameraDesc, size.width, size.height],
    );
    // ─────────────────────────────────────────────────────────────────────────

    const ids: number[] = [];
    const attribute = lines.getAttribute("position") as THREE.BufferAttribute;
    visibleBeaconIndices.forEach((i) => {
      const obs = values[i];
      if (!obs || obs.alpha <= 0) return;
      const slot = ids.length;
      ids.push(i);
      const dir = direction(i),
        r = radius(ui.raw ? obs.raw : obs.smooth).r;
      matrix.position.set(dir[0] * r, dir[1] * r, dir[2] * r);
      matrix.rotation.set(0, 0, 0);
      matrix.scale.setScalar(ui.selected === i ? 0.31 : 0.23);
      matrix.updateMatrix();
      glyphs.current!.setMatrixAt(slot, matrix.matrix);
      glyphs.current!.setColorAt(
        slot,
        color.set(COLORS[i]).multiplyScalar(0.45 + obs.alpha * 0.55),
      );
      const pulse =
        !matchMedia("(prefers-reduced-motion: reduce)").matches &&
        ui.playing &&
        obs.age < 200
          ? obs.age / 200
          : 0;
      matrix.rotation.x = -Math.PI / 2;
      matrix.scale.setScalar(ui.selected === i ? 0.49 : 0.31 + pulse * 0.3);
      matrix.updateMatrix();
      rings.current!.setMatrixAt(slot, matrix.matrix);
      rings.current!.setColorAt(
        slot,
        color.set(ui.selected === i ? "#ffffff" : COLORS[i]),
      );
      attribute.setXYZ(slot * 2, 0, 0, 0);
      attribute.setXYZ(slot * 2 + 1, dir[0] * r, dir[1] * r, dir[2] * r);
    }
    visible.current = ids;
    glyphs.current!.count = ids.length;
    rings.current!.count = ids.length;
    glyphs.current!.instanceMatrix.needsUpdate = true;
    rings.current!.instanceMatrix.needsUpdate = true;
    if (glyphs.current!.instanceColor)
      glyphs.current!.instanceColor.needsUpdate = true;
    if (rings.current!.instanceColor)
      rings.current!.instanceColor.needsUpdate = true;
    lines.setDrawRange(0, ids.length * 2);
    attribute.needsUpdate = true;
    const screen = ids.map((id) => {
      const obs = values[id]!,
        d = direction(id),
        r = radius(ui.raw ? obs.raw : obs.smooth).r,
        p = new THREE.Vector3(d[0] * r, d[1] * r, d[2] * r).project(camera);
      return {
        id,
        x: ((p.x + 1) / 2) * size.width,
        y: ((1 - p.y) / 2) * size.height,
      };
    });
    window.__SYNTHETIC_LAB__ = { time: time.current, active: ids, screen };
    if (performance.now() - published.current >= 100 || !ui.playing) {
      if (ui.time !== time.current) useUI.setState({ time: time.current });
      published.current = performance.now();
    }
    if (time.current >= 48000 && ui.playing) useUI.setState({ playing: false });
    if (ui.playing) invalidate();
  });
  return (
    <>
      <color attach="background" args={["#09121c"]} />
      <lineSegments geometry={grid} renderOrder={-2}>
        <lineBasicMaterial
          color="#477484"
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </lineSegments>
      <lineSegments
        geometry={grid}
        rotation={[Math.PI / 2, 0, 0]}
        renderOrder={-2}
      >
        <lineBasicMaterial
          color="#477484"
          transparent
          opacity={0.4}
          depthWrite={false}
        />
      </lineSegments>
      <gridHelper
        args={[26, 26, "#426675", "#294451"]}
        position={[0, -2.5, 0]}
      />
      <lineSegments geometry={lines} renderOrder={-1}>
        <lineBasicMaterial
          color="#67d5e7"
          transparent
          opacity={0.15}
          depthWrite={false}
        />
      </lineSegments>
      <mesh>
        <sphereGeometry args={[0.34, 20, 16]} />
        <meshBasicMaterial color="#9af0fa" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.57, 20, 16]} />
        <meshBasicMaterial
          color="#67d5e7"
          transparent
          opacity={0.13}
          depthWrite={false}
        />
      </mesh>
      <instancedMesh
        ref={glyphs}
        args={[undefined, undefined, 64]}
        onClick={(e) => {
          e.stopPropagation();
          if (e.instanceId !== undefined)
            useUI.setState({ selected: visible.current[e.instanceId] });
        }}
      >
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial />
      </instancedMesh>
      <instancedMesh
        ref={rings}
        args={[undefined, undefined, 64]}
        raycast={() => {}}
      >
        <ringGeometry args={[0.91, 1, 32]} />
        <meshBasicMaterial side={THREE.DoubleSide} transparent opacity={0.85} />
      </instancedMesh>
      <OrbitControls
        makeDefault
        enableDamping={false}
        enablePan={false}
        minDistance={12}
        maxDistance={35}
        maxPolarAngle={Math.PI * 0.48}
      />
    </>
  );
}
export function SignalScene({ session }: { session: Session }) {
  const [key, setKey] = useState(0),
    restore = useMemo(() => () => setKey((k) => k + 1), []);
  return (
    <Canvas
      role="img"
      key={key}
      frameloop="demand"
      dpr={window.devicePixelRatio}
      camera={{ position: [14, 15, 18], fov: 43 }}
      gl={{ antialias: true }}
      aria-label="Synthetic RF field; radius encodes RSSI and directions are assigned"
    >
      <Instrument session={session} onRestore={restore} />
    </Canvas>
  );
}
