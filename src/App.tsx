import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Download,
  Play,
  Pause,
  RotateCcw,
  Upload,
  Radio,
  Map,
  FlaskConical,
} from "lucide-react";
import {
  approvedFixture,
  download,
  hydrate,
  upperBound,
  validateProject,
} from "./data";
import type { Fixture, Manifest, Project, Receiver, Session } from "./data";
import { observations } from "./signal";
import { useSmoothedWorker, useHistogramWorker } from "./hooks/useSignalWorker";
import {
  calibrate,
  correctCounter,
  distanceInterval,
  locate,
} from "./localization";
import { durability, loadProject, saveProject } from "./storage";
import { useUI } from "./store";
import { COLORS, SignalScene } from "./Scene";
class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function Fallback({ session }: { session: Session }) {
  const ui = useUI();
  useEffect(() => {
    if (!ui.playing) return;
    let previous = performance.now();
    const id = setInterval(() => {
      const now = performance.now(),
        state = useUI.getState(),
        t = Math.min(48000, state.time + (now - previous) * state.speed);
      previous = now;
      state.seekTo(t);
      if (t === 48000) useUI.setState({ playing: false });
    }, 100);
    return () => clearInterval(id);
  }, [ui.playing]);
  return (
    <div className="fallback">
      <Radio size={38} />
      <h2>Signal evidence remains available</h2>
      <p>
        WebGL is unavailable. Use the address table, local layout and linked
        timeline.
      </p>
      <p>{session.fixture.label} · synthetic only</p>
    </div>
  );
}
function Timeline({ session }: { session: Session }) {
  const ui = useUI();
  // Use worker-computed histogram when available, fall back to main-thread computation
  const workerHist = useHistogramWorker(session, 96, 500);
  const histogram = workerHist ?? useMemo(() => {
    const h = new Array(96).fill(0);
    session.t.forEach((t) => h[Math.min(95, Math.floor(t / 500))]++);
    return h;
  }, [session]);
  const smoothWorker = useSmoothedWorker(session, ui.tau);
  const indices =
    ui.selected === null
      ? []
      : Array.from(session.indices[ui.selected]).filter(
          (i) => session.receiver[i] === ui.receiver,
        );
  // Use worker-computed smoothed values for the polyline when available
  const smooth = smoothWorker && indices.length > 0
    ? indices
        .map(
          (i) =>
            `${20 + (session.t[i] / 48000) * 960},${150 - ((smoothWorker[i] + 120) / 110) * 78}`,
        )
        .join(" ")
    : indices
        .map(
          (i) =>
            `${20 + (session.t[i] / 48000) * 960},${150 - ((session.rssi[i] + 120) / 110) * 78}`,
        )
        .join(" ");
  const maximum = Math.max(...histogram),
    x = 20 + (ui.time / 48000) * 960;
  return (
    <section className="timeline" aria-label="Synthetic packet timeline">
      <div className="section-title">
        <span>PACKET DENSITY · 500 ms BINS</span>
        <span>
          {ui.selected === null
            ? "Choose an address for its RSSI trace"
            : "RAW POINTS + HELD-INPUT EMA · dBm"}
        </span>
      </div>
      <svg
        viewBox="0 0 1000 174"
        role="img"
        aria-label="Packet histogram and selected synthetic RSSI trace"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          ui.seekTo(
            Math.round(
              Math.max(
                0,
                Math.min(
                  48000,
                  ((((e.clientX - box.left) / box.width) * 1000 - 20) / 960) *
                    48000,
                ),
              ),
            ),
          );
        }}
      >
        {histogram.map((n, i) => (
          <rect
            key={i}
            x={20 + i * 10}
            y={55 - (n / maximum) * 38}
            width="7"
            height={(n / maximum) * 38}
            fill="#5795a7"
          />
        ))}
        <line x1="20" y1="65" x2="980" y2="65" stroke="#294455" />
        {[-100, -60, -20].map((db) => (
          <g key={db}>
            <text
              x="2"
              y={150 - ((db + 120) / 110) * 78}
              fill="#b6cbd5"
              fontSize="10"
            >
              {db}
            </text>
            <line
              x1="25"
              x2="980"
              y1={150 - ((db + 120) / 110) * 78}
              y2={150 - ((db + 120) / 110) * 78}
              stroke="#203541"
            />
          </g>
        ))}
        {indices.map((i) => (
          <circle
            key={i}
            cx={20 + (session.t[i] / 48000) * 960}
            cy={150 - ((session.rssi[i] + 120) / 110) * 78}
            r="1.5"
            fill="#bfd2df"
            opacity=".5"
          >
            <title>
              {(session.t[i] / 1000).toFixed(3)} s · {session.rssi[i]} dBm
            </title>
          </circle>
        ))}
        <polyline
          data-testid="signal-trace"
          points={smooth}
          fill="none"
          stroke="#71dceb"
          strokeWidth="1.7"
        />
        <line x1={x} x2={x} y1="5" y2="154" stroke="white" />
        {[0, 12, 24, 36, 48].map((t) => (
          <text
            key={t}
            x={20 + (t / 48) * 950}
            y="170"
            fontSize="11"
            fill="#b6cbd5"
          >
            {t} s
          </text>
        ))}
      </svg>
      <label className="sr-only" htmlFor="seek">
        Replay time in milliseconds
      </label>
      <input
        id="seek"
        aria-label="Replay time in milliseconds"
        type="range"
        min="0"
        max="48000"
        value={Math.round(ui.time)}
        onChange={(e) => ui.seekTo(Number(e.target.value))}
      />
    </section>
  );
}
function Layout({
  session,
  receivers,
  corrected,
}: {
  session: Session;
  receivers: Receiver[];
  corrected: boolean;
}) {
  const ui = useUI();
  useEffect(() => {
    if (!ui.playing) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(),
        s = useUI.getState(),
        time = Math.min(48000, s.time + (now - previous) * s.speed);
      previous = now;
      s.seekTo(time);
      if (time === 48000) useUI.setState({ playing: false });
    }, 100);
    return () => clearInterval(timer);
  }, [ui.playing]);
  const fix = useMemo(
    () =>
      ui.selected === null
        ? {
            point: null,
            reason: "Select a synthetic advertiser.",
            sensitivity: null,
          }
        : locate(session, ui.selected, ui.time, receivers, corrected),
    [session, ui.selected, ui.time, receivers, corrected],
  );
  const extent = Math.max(
      20,
      ...receivers.flatMap((r) => [Math.abs(r.x_m) + 6, Math.abs(r.y_m) + 6]),
    ),
    scale = 180 / extent;
  return (
    <div className="layout-view">
      <div className="figure-title">
        <span>FICTIONAL LOCAL PLANE</span>
        <span>METRES · NO GEOGRAPHIC LOCATION</span>
      </div>
      <svg
        viewBox="0 0 640 440"
        role="img"
        aria-label="Synthetic receiver positions on a fictional metric XY grid"
      >
        {Array.from({ length: 9 }, (_, i) => (
          <g key={i}>
            <line
              x1={140 + i * 45}
              y1="35"
              x2={140 + i * 45}
              y2="395"
              stroke="#21394a"
            />
            <line
              x1="140"
              y1={35 + i * 45}
              x2="500"
              y2={35 + i * 45}
              stroke="#21394a"
            />
          </g>
        ))}
        {receivers.map((r, i) => (
          <g key={r.id}>
            <rect
              x={320 + r.x_m * scale - 6}
              y={215 - r.y_m * scale - 6}
              width="12"
              height="12"
              fill="#73dcea"
            />
            <text
              x={320 + r.x_m * scale + 12}
              y={215 - r.y_m * scale}
              fill="#e2f0f5"
              fontSize="14"
            >
              Receiver {String.fromCharCode(65 + i)}
            </text>
          </g>
        ))}
        {fix.point && (
          <g data-testid="position-fix">
            <circle
              cx={320 + fix.point.x * scale}
              cy={215 - fix.point.y * scale}
              r={Math.min(170, (fix.sensitivity ?? 0) * scale)}
              fill="#ffffff"
              fillOpacity=".08"
              stroke="#d3eaf1"
              strokeDasharray="4 5"
            />
            <circle
              cx={320 + fix.point.x * scale}
              cy={215 - fix.point.y * scale}
              r="5"
              fill="white"
            />
          </g>
        )}
        <text x="140" y="423" fill="#c4d6df" fontSize="12">
          Equal XY scale · grid interval = {(extent / 4).toFixed(1)} m
        </text>
      </svg>
      <p className="fix-status" role="status">
        {fix.reason}
      </p>
      <p className="muted">
        Squares: assigned receivers. White point: model estimate. Circle: local
        sensitivity in metres, with no confidence-coverage claim.
      </p>
    </div>
  );
}
export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null),
    [fixture, setFixture] = useState<Fixture | null>(null),
    [receivers, setReceivers] = useState<Receiver[]>([]),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [pending, setPending] = useState<Project | null>(null),
    [mode, setMode] = useState<"signal" | "layout">("signal"),
    [corrected, setCorrected] = useState(true),
    [loading, setLoading] = useState(false),
    [storage, setStorage] = useState("Checking browser storage…");
  const request = useRef(0),
    ui = useUI(),
    session = useMemo(() => (fixture ? hydrate(fixture) : null), [fixture]);
  const apply = (p: Project) => {
    setFixture(p.fixture);
    setReceivers(
      p.fixture.receivers.map((r) => ({
        ...r,
        ...p.view.positions.find((x) => x.id === r.id),
      })),
    );
    setCorrected(p.view.clock_corrected);
    useUI.setState({
      selected: p.view.selected,
      tau: p.view.tau,
      receiver: 0,
      playing: false,
    });
    useUI.getState().seekTo(p.view.time_ms);
  };
  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const response = await fetch("fixtures/manifest.json");
        if (!response.ok) throw new Error();
        const m = (await response.json()) as Manifest;
        const f = await approvedFixture(
          await (await fetch("fixtures/triangle.json")).json(),
          m,
        );
        if (cancelled) return;
        setManifest(m);
        setFixture(f);
        setReceivers(f.receivers);
        // Request persistent storage before the first capture import so the
        // browser cannot evict the capture library stored in IndexedDB.
        setStorage(await durability(true));
        try {
          const saved = await loadProject(m);
          if (saved && !cancelled) {
            apply(saved);
            setStatus("Restored saved synthetic project.");
          }
        } catch {
          setStorage("Browser storage is unavailable; use project exports.");
        }
      } catch {
        if (!cancelled)
          setError(
            "Could not load the synthetic fixture. Reload the local application.",
          );
      }
    }
    void start();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,select,textarea,button"))
        return;
      if (e.code === "Space") {
        e.preventDefault();
        useUI.setState((s) => ({ playing: !s.playing }));
      }
      if (e.key === "Escape") useUI.setState({ selected: null });
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        useUI
          .getState()
          .seekTo(
            Math.max(
              0,
              Math.min(
                48000,
                useUI.getState().time + (e.key === "ArrowRight" ? 1000 : -1000),
              ),
            ),
          );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const snapshot = (): Project => ({
    kind: "synthetic-ble-project",
    schema_version: 1,
    synthetic: true,
    fixture: fixture!,
    view: {
      time_ms: Math.round(ui.time),
      selected: ui.selected,
      tau: ui.tau,
      positions: receivers.map(({ id, x_m, y_m }) => ({ id, x_m, y_m })),
      clock_corrected: corrected,
    },
  });
  async function change(id: string) {
    if (!manifest) return;
    const version = ++request.current;
    setLoading(true);
    setError("");
    useUI.setState({ playing: false });
    try {
      const entry = manifest.fixtures.find((x) => x.id === id)!;
      const response = await fetch("fixtures/" + entry.file);
      const f = await approvedFixture(await response.json(), manifest);
      if (version !== request.current) return;
      setFixture(f);
      setReceivers(f.receivers);
      setCorrected(true);
      useUI.setState({ receiver: 0, selected: 0, query: "" });
      ui.seekTo(12000);
    } catch {
      setError("Synthetic scenario could not be loaded.");
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  const obs = useMemo(
    () => (session ? observations(session, ui.time, ui.receiver, ui.tau) : []),
    [session, ui.time, ui.receiver, ui.tau],
  );
  const selected = ui.selected === null ? null : obs[ui.selected];
  const beacon =
      fixture && ui.selected !== null ? fixture.beacons[ui.selected] : null;
  const selectedIndices =
    session && ui.selected !== null
      ? Array.from(session.indices[ui.selected]).filter(
          (i) => session.receiver[i] === ui.receiver,
        )
      : [];
  const raw = selectedIndices
      .map((i) => session!.rssi[i])
      .sort((a, b) => a - b),
    median = raw.length ? raw[Math.floor(raw.length / 2)] : null;
  const active = obs.filter((o) => o && o.alpha > 0).length,
    rate = session
      ? upperBound(session.t, ui.time) - upperBound(session.t, ui.time - 1000)
      : 0;
  const interval =
    selected && receivers[ui.receiver]
      ? distanceInterval(
          selected.raw,
          calibrate(receivers[ui.receiver].calibration),
        )
      : null;
  const fallback = session ? <Fallback session={session} /> : null;
  return (
    <>
      <a className="skip" href="#workspace">
        Skip to laboratory
      </a>
      <header>
        <div className="brand">
          <Activity size={25} />
          <div>
            <h1>
              BLE Map <span>/ Synthetic Lab</span>
            </h1>
            <p>LOCAL SIGNAL ANALYSIS</p>
          </div>
        </div>
        <div className="synthetic-badge">SYNTHETIC DATA ONLY</div>
        <a
          href="https://github.com/katzimoto/BLE-map"
          target="_blank"
          rel="noreferrer"
        >
          Project & docs ↗
        </a>
      </header>
      <div className="review-state">
        Public bootstrap · awaiting data-owner and independent privacy review ·
        no real observations
      </div>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="message">
          {status}
        </p>
      )}
      {session && fixture && manifest ? (
        <>
          <section className="hud" aria-label="Replay controls">
            <label>
              SCENARIO
              <select
                aria-label="Synthetic scenario"
                disabled={loading}
                value={fixture.id}
                onChange={(e) => void change(e.target.value)}
              >
                {manifest.fixtures.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="counter">
              <b>
                {(ui.time / 1000).toFixed(1)} <span>/ 48.0 s</span>
              </b>
              <small>RELATIVE SIMULATION TIME</small>
            </div>
            <div className="counter">
              <b>
                {active}
                <span> / {fixture.beacons.length}</span>
              </b>
              <small>ADVERTISER ADDRESSES</small>
            </div>
            <div className="counter">
              <b>{rate}</b>
              <small>OBSERVATIONS / s</small>
            </div>
            <button
              className="primary"
              aria-label={ui.playing ? "Pause replay" : "Play replay"}
              onClick={() => useUI.setState({ playing: !ui.playing })}
            >
              {ui.playing ? <Pause size={16} /> : <Play size={16} />}{" "}
              {ui.playing ? "Pause" : "Play"}
            </button>
            <button aria-label="Restart replay" onClick={() => ui.seekTo(0)}>
              <RotateCcw size={16} />
            </button>
            <label>
              SPEED
              <select
                aria-label="Replay speed"
                value={ui.speed}
                onChange={(e) =>
                  useUI.setState({ speed: Number(e.target.value) })
                }
              >
                {[0.5, 1, 2, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
          </section>
          <main id="workspace" className="workspace">
            <aside className="left-rail" aria-label="Synthetic addresses">
              <div className="section-title">
                <span>OBSERVE</span>
                <Radio size={14} />
              </div>
              <label>
                RECEIVER
                <select
                  aria-label="Receiver"
                  value={ui.receiver}
                  onChange={(e) =>
                    useUI.setState({ receiver: Number(e.target.value) })
                  }
                >
                  {receivers.map((r, i) => (
                    <option key={r.id} value={i}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                FIND ADDRESS
                <input
                  aria-label="Filter synthetic addresses"
                  value={ui.query}
                  onChange={(e) => useUI.setState({ query: e.target.value })}
                  placeholder="Synthetic Beacon…"
                />
              </label>
              <div
                className="address-list"
                role="group"
                aria-label="Advertiser address table"
              >
                {fixture.beacons.map((b, i) =>
                  b.label.toLowerCase().includes(ui.query.toLowerCase()) ? (
                    <button
                      key={b.id}
                      aria-pressed={ui.selected === i}
                      onClick={() => useUI.setState({ selected: i })}
                    >
                      <i style={{ background: COLORS[i] }} />
                      <span>
                        {b.label}
                        <small>
                          {obs[i]?.alpha ? `${obs[i]!.raw} dBm` : "inactive"}
                        </small>
                      </span>
                      {ui.selected === i && <span aria-hidden="true">↗</span>}
                    </button>
                  ) : null,
                )}
              </div>
              <p className="muted">
                Rotating addresses are separate advertiser addresses. The
                fixture explicitly models one rotation; it does not infer real
                identity.
              </p>
              <details>
                <summary>Replay settings</summary>
                <label>
                  EMA WINDOW · {ui.tau.toFixed(2)} s
                  <input
                    aria-label="Smoothing window seconds"
                    type="range"
                    min="0.05"
                    max="3"
                    step="0.05"
                    value={ui.tau}
                    onChange={(e) =>
                      useUI.setState({ tau: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={ui.raw}
                    onChange={(e) => useUI.setState({ raw: e.target.checked })}
                  />
                  Raw RSSI motion
                </label>
              </details>
            </aside>
            <section
              className="visual"
              aria-label="Linked synthetic visualization"
            >
              <nav aria-label="Visualization mode">
                <button
                  aria-pressed={mode === "signal"}
                  onClick={() => setMode("signal")}
                >
                  <Radio size={14} />
                  Signal field
                </button>
                <button
                  aria-pressed={mode === "layout"}
                  onClick={() => setMode("layout")}
                >
                  <Map size={14} />
                  Receiver layout
                </button>
              </nav>
              {mode === "signal" ? (
                <>
                  <div className="canvas-shell" data-testid="rf-scene">
                    {new URLSearchParams(location.search).has("fallback") ? (
                      fallback
                    ) : (
                      <SceneBoundary key={fixture.id} fallback={fallback}>
                        <SignalScene key={fixture.id} session={session} />
                      </SceneBoundary>
                    )}
                    <div className="scene-note">
                      SCANNER (RECEIVER)
                      <br />
                      <span>Reference arcs: −40 / −60 / −80 / −100 dBm</span>
                    </div>
                  </div>
                  <p className="persistent-legend">
                    <b>Not a map.</b> Radius = received signal strength (dBm).
                    Direction is assigned arbitrarily and carries no physical
                    meaning. All observations are synthetic.
                  </p>
                </>
              ) : (
                <Layout
                  session={session}
                  receivers={receivers}
                  corrected={corrected}
                />
              )}
            </section>
            <aside
              className="inspector"
              aria-label="Selected advertiser inspector"
            >
              <div className="section-title">
                <span>INSPECT</span>
                <FlaskConical size={14} />
              </div>
              <h2>{beacon?.label ?? "Select an address"}</h2>
              <p className="muted">
                {beacon
                  ? "Invented fixture identifier · no physical device"
                  : "Use the address table or select a glyph."}
              </p>
              <div className="readings">
                <div>
                  <small>RAW RSSI</small>
                  <strong>
                    {selected?.raw ?? "—"}
                    <em>dBm</em>
                  </strong>
                </div>
                <div>
                  <small>EMA RSSI</small>
                  <strong>
                    {selected?.smooth.toFixed(1) ?? "—"}
                    <em>dBm</em>
                  </strong>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Min / median / max</dt>
                  <dd>
                    {raw.length
                      ? `${raw[0]} / ${median} / ${raw.at(-1)} dBm`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Observations</dt>
                  <dd>{selectedIndices.length}</dd>
                </div>
                <div>
                  <dt>Current age</dt>
                  <dd>
                    {selected
                      ? (selected.age / 1000).toFixed(3) + " s"
                      : "not yet seen"}
                  </dd>
                </div>
                <div>
                  <dt>First / last seen</dt>
                  <dd>
                    {selectedIndices.length
                      ? `${(session.t[selectedIndices[0]] / 1000).toFixed(3)} / ${(session.t[selectedIndices.at(-1)!] / 1000).toFixed(3)} s`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Advertisement flags</dt>
                  <dd>
                    {selected
                      ? fixture.variants[fixture.events.variant[selected.index]]
                          .malformed_ad
                        ? "malformed structure"
                        : fixture.variants[
                              fixture.events.variant[selected.index]
                            ].extended_or_concatenated
                          ? "extended or concatenated"
                          : "generated short payload"
                      : "—"}
                  </dd>
                </div>
              </dl>
              <details open>
                <summary>Model and clock diagnostics</summary>
                <p className="muted">
                  Calibration readings are synthetic. A finite interval assumes
                  this simulated model; it is not measured field accuracy.
                </p>
                <p>
                  {interval?.point !== null && interval?.point !== undefined ? (
                    <>
                      <b>{interval.point.toFixed(1)} m</b> ·{" "}
                      {interval.low!.toFixed(1)}–{interval.high!.toFixed(1)} m
                      conditional inverse interval
                    </>
                  ) : (
                    (interval?.reason ?? "No current observation.")
                  )}
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={corrected}
                    onChange={(e) => setCorrected(e.target.checked)}
                  />
                  Apply synthetic clock correction
                </label>
                <p className="muted">
                  Assigned offset: {receivers[ui.receiver].offset_ms} ms; drift:{" "}
                  {receivers[ui.receiver].drift_ppm} ppm.
                </p>
                {selected && (
                  <p className="muted">
                    Corrected counter:{" "}
                    {correctCounter(
                      fixture.events.counter_ms[selected.index],
                      receivers[ui.receiver],
                    ).toFixed(1)}{" "}
                    ms.
                  </p>
                )}
              </details>
            </aside>
          </main>
          <Timeline session={session} />
          <section
            className="project-tools"
            aria-label="Synthetic project tools"
          >
            <div>
              <h2>Synthetic project</h2>
              <p>{storage}</p>
            </div>
            <button onClick={() => download(snapshot())}>
              <Download size={15} />
              Export / back up
            </button>
            <button
              onClick={async () => {
                try {
                  setStorage(await saveProject(snapshot()));
                  setStatus("Synthetic project saved in this browser.");
                } catch {
                  setError("Could not save locally. Export a project backup.");
                }
              }}
            >
              Save locally
            </button>
            <label className="file-button">
              <Upload size={15} />
              Import / restore
              <input
                aria-label="Import synthetic project"
                type="file"
                accept=".json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !manifest) return;
                  setError("");
                  try {
                    if (file.size > 2000000) throw new Error();
                    const p = await validateProject(
                      JSON.parse(await file.text()),
                      manifest,
                    );
                    setPending(p);
                  } catch {
                    setError(
                      "Import rejected. Use an unmodified synthetic project export below 2 MB.",
                    );
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </section>
          <details className="layout-editor">
            <summary>Edit fictional receiver layout</summary>
            <p>
              Assigned local metric XY values only. This is not a real floor
              plan or geographical location.
            </p>
            <div>
              {receivers.map((r, i) => (
                <fieldset key={r.id}>
                  <legend>{r.label}</legend>
                  {(["x_m", "y_m"] as const).map((key) => (
                    <label key={key}>
                      {key === "x_m" ? "X" : "Y"} (m)
                      <input
                        aria-label={`${r.label} ${key}`}
                        type="number"
                        min="-100"
                        max="100"
                        step="1"
                        value={r[key]}
                        onChange={(e) => {
                          const value = Number(e.target.value);
                          if (Number.isFinite(value) && Math.abs(value) <= 100)
                            setReceivers((rs) =>
                              rs.map((v, j) =>
                                i === j ? { ...v, [key]: value } : v,
                              ),
                            );
                        }}
                      />
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </details>
          {pending && (
            <section
              className="restore-review"
              role="region"
              aria-label="Review synthetic restore"
            >
              <h2>Review synthetic restore</h2>
              <p>
                {pending.fixture.label} · {pending.fixture.events.t.length}{" "}
                generated observations. This replaces the currently saved
                synthetic project.
              </p>
              <button
                className="primary"
                onClick={async () => {
                  try {
                    download(snapshot());
                    setStorage(await saveProject(pending));
                    apply(pending);
                    setPending(null);
                    setStatus(
                      "Synthetic project restored. The previous view was exported as a backup.",
                    );
                  } catch {
                    setError(
                      "Restore failed; current project was not replaced.",
                    );
                  }
                }}
              >
                Back up current and restore
              </button>
              <button onClick={() => setPending(null)}>Cancel restore</button>
            </section>
          )}
        </>
      ) : (
        <div className="loading" role="status">
          Loading the synthetic laboratory…
        </div>
      )}
      <footer>
        SYNTHETIC LAB · Local processing · No telemetry or live receiver
        connections ·{" "}
        <a
          href="https://github.com/katzimoto/BLE-map/blob/main/docs/data-semantics.md"
          target="_blank"
          rel="noreferrer"
        >
          Data semantics ↗
        </a>
      </footer>
    </>
  );
}
