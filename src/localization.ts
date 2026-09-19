import type { Sample, Receiver, Session } from "./data";
const quantile975 = [
  0, 12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306,
];
export type Model = {
  reference: number;
  exponent: number;
  sigma: number;
  n: number;
  mean: number;
  sxx: number;
  t: number;
};
export function calibrate(samples: Sample[]): Model {
  if (
    samples.length < 6 ||
    new Set(samples.map((p) => p.distance_m)).size < 3 ||
    samples.some(
      (p) => p.distance_m < 1 || p.distance_m > 100 || !Number.isFinite(p.rssi),
    )
  )
    throw new Error("Use at least six synthetic readings at three distances.");
  const xs = samples.map((p) => Math.log10(p.distance_m)),
    n = xs.length,
    mean = xs.reduce((a, b) => a + b) / n,
    ym = samples.reduce((a, b) => a + b.rssi, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mean) ** 2, 0),
    slope =
      xs.reduce((a, x, i) => a + (x - mean) * (samples[i].rssi - ym), 0) / sxx;
  const reference = ym - slope * mean,
    exponent = -slope / 10,
    sigma = Math.max(
      1,
      Math.sqrt(
        samples.reduce(
          (a, p, i) => a + (p.rssi - reference - slope * xs[i]) ** 2,
          0,
        ) /
          (n - 2),
      ),
    );
  if (!Number.isFinite(exponent) || exponent < 0.5 || exponent > 6)
    throw new Error("Calibration does not resolve a usable signal slope.");
  const df = n - 2,
    t = quantile975[df] ?? 1.96 + 2.3723 / df + 2.8225 / df ** 2;
  return { reference, exponent, sigma, n, mean, sxx, t };
}
export function distanceInterval(rssi: number, m: Model) {
  const beta = -10 * m.exponent,
    delta = rssi - (m.reference + beta * m.mean),
    h2 = (m.t * m.sigma) ** 2;
  const a = beta * beta - h2 / m.sxx,
    b = -2 * beta * delta,
    c = delta * delta - h2 * (1 + 1 / m.n),
    disc = b * b - 4 * a * c;
  if (a <= 0 || disc < 0)
    return {
      point: null,
      low: null,
      high: null,
      reason: "Calibration slope unresolved: no finite inverse interval.",
    };
  const low = 10 ** (m.mean + (-b - Math.sqrt(disc)) / (2 * a)),
    high = 10 ** (m.mean + (-b + Math.sqrt(disc)) / (2 * a));
  return {
    point: 10 ** ((m.reference - rssi) / (10 * m.exponent)),
    low,
    high,
    reason:
      "Conditional inverse prediction interval; simulated Gaussian model.",
  };
}
export function correctCounter(counter: number, r: Receiver) {
  return (counter - r.offset_ms) / (1 + r.drift_ppm / 1e6);
}
export type Fix = {
  point: { x: number; y: number } | null;
  reason: string;
  sensitivity: number | null;
};
export function locate(
  session: Session,
  selected: number,
  time: number,
  receivers: Receiver[],
  corrected: boolean,
): Fix {
  const no = (reason: string): Fix => ({
    point: null,
    reason,
    sensitivity: null,
  });
  if (
    !corrected &&
    receivers.some((r) => r.offset_ms !== 0 || r.drift_ppm !== 0)
  )
    return no("Clock corrections disabled: no fix.");
  const evidence = receivers.flatMap((r, ri) => {
    const readings: number[] = [],
      seen = new Set<string>();
    const indices = session.indices[selected];
    for (let p = indices.length - 1; p >= 0; p--) {
      const i = indices[p];
      if (session.t[i] > time) continue;
      if (time - session.t[i] > 2000) break;
      if (session.receiver[i] !== ri) continue;
      const key = session.t[i] + "/" + session.rssi[i];
      if (!seen.has(key)) {
        seen.add(key);
        readings.push(session.rssi[i]);
      }
    }
    if (!readings.length) return [];
    readings.sort((a, b) => a - b);
    const middle = Math.floor(readings.length / 2),
      rssi =
        readings.length % 2
          ? readings[middle]
          : (readings[middle - 1] + readings[middle]) / 2;
    const model = calibrate(r.calibration),
      interval = distanceInterval(rssi, model);
    return [{ r, model, interval, rssi }];
  });
  if (evidence.length < 3)
    return no("Fewer than three recent receivers: no unique fix.");
  if (evidence.some((e) => e.interval.point === null))
    return no("Calibration slope unresolved: no fix.");
  const [a, b, c] = evidence.map((e) => e.r),
    area = Math.abs(
      (b.x_m - a.x_m) * (c.y_m - a.y_m) - (c.x_m - a.x_m) * (b.y_m - a.y_m),
    );
  if (area < 3) return no("Receiver geometry is degenerate: no fix.");
  let best = { x: 0, y: 0, cost: Infinity, variance: 0 };
  for (let x = -18; x <= 18; x += 0.4)
    for (let y = -18; y <= 18; y += 0.4) {
      let cost = 0,
        variance = 0;
      for (const e of evidence) {
        const log = Math.log10(
            Math.max(1, Math.hypot(x - e.r.x_m, y - e.r.y_m)),
          ),
          v =
            e.model.sigma ** 2 *
            (1 + 1 / e.model.n + (log - e.model.mean) ** 2 / e.model.sxx),
          z =
            (e.model.reference - 10 * e.model.exponent * log - e.rssi) /
            Math.sqrt(v);
        cost += Math.abs(z) <= 1.5 ? (z * z) / 2 : 1.5 * (Math.abs(z) - 0.75);
        variance += v;
      }
      if (cost < best.cost) best = { x, y, cost, variance };
    }
  if (best.cost > 12) return no("Evidence and model disagree: no fix.");
  if (Math.abs(best.x) > 17.8 || Math.abs(best.y) > 17.8)
    return no("Estimate reaches the fictional search boundary: no fix.");
  let xx = 0,
    xy = 0,
    yy = 0;
  for (const e of evidence) {
    const dx = best.x - e.r.x_m,
      dy = best.y - e.r.y_m,
      d2 = Math.max(1, dx * dx + dy * dy),
      log = Math.log10(Math.sqrt(d2)),
      v =
        e.model.sigma ** 2 *
        (1 + 1 / e.model.n + (log - e.model.mean) ** 2 / e.model.sxx),
      factor = (-10 * e.model.exponent) / Math.LN10 / d2,
      jx = factor * dx,
      jy = factor * dy;
    xx += (jx * jx) / v;
    xy += (jx * jy) / v;
    yy += (jy * jy) / v;
  }
  const eigen = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 2;
  if (eigen <= 1e-8) return no("Position sensitivity is unresolved: no fix.");
  const sensitivity = 1 / Math.sqrt(eigen);
  return {
    point: { x: best.x, y: best.y },
    reason:
      "Conditional synthetic estimate. Sensitivity circle is not a confidence region.",
    sensitivity,
  };
}
