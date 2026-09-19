/**
 * Domain model v2 — issue #17 [M1]
 *
 * Explicitly separates observed BLE identifiers from probabilistic associations,
 * makes scanner clock quality first-class, and binds calibration validity to
 * its exact inputs and scope.
 *
 * Core entities:
 *   Observation      — raw BLE evidence with provenance and timestamp uncertainty
 *   EphemeralAddress — a MAC or UUID seen on a specific PHY/channel at a moment
 *   AssetIdentity    — a probabilistically-associated physical asset (one or more addresses)
 *   TrackHypothesis  — an active track with provenance, confidence, and window
 *   Scanner          — hardware identity, placement, PHY capabilities
 *   ClockDomain      — clock offset, drift, sync quality, health
 *   CalibrationProfile — fitted path-loss model with input fingerprint and validity
 *   MapSpace         — building/floor metric coordinates and transforms
 *   PositionEstimate — backend, point/distribution, uncertainty, integrity, provenance
 */

// ─── Primitive aliases ────────────────────────────────────────────────────────

/** Wall-clock milliseconds since an arbitrary epoch. */
export type TimestampMs = number;
/** Counter value in scanner-local ms (before clock correction). */
export type CounterMs = number;
/** Received Signal Strength Indicator in dBm. */
export type Rssi = number;
/** PHY layer indicator: 1 = BLE 1M, 2 = BLE 2M, 4 = BLE Coded. */
export type Phy = 1 | 2 | 4;
/** BLE channel index (0–39). */
export type Channel = number;

// ─── Evidence ───────────────────────────────────────────────────────────────

/**
 * Raw BLE observation as captured by a scanner.
 *
 * Includes everything needed to reason about provenance, ambiguity, and clock
 * quality — none of which should be implicit in a raw MAC address string.
 */
export interface Observation {
  /** Wall-clock ms when the scanner processed this frame. */
  timestamp_ms: TimestampMs;
  /** Scanner-local counter ms at time of reception (before clock correction). */
  counter_ms: CounterMs;
  /** Scanner identifier (must resolve to a Scanner entity). */
  scanner_id: string;
  /** The address as advertised — may be rotated, cloned, or ambiguous. */
  address: EphemeralAddress;
  /** RSSI in dBm at the scanner antenna. */
  rssi: Rssi;
  /** PHY layer the frame was received on. */
  phy: Phy;
  /** BLE channel index (0–39). */
  channel: Channel;
  /**
   * Raw advertising payload bytes.
   * `null` when the payload was malformed, truncated, or otherwise unreadable.
   */
  payload: Uint8Array | null;
  /**
   * Sequence number assigned by the source asset for de-duplication.
   * `null` when the source does not provide one or it is unknown.
   */
  seq: number | null;
  /**
   * Provenance hint — how this observation entered the system.
   * Used for audit and for weighting evidence from different capture paths.
   */
  provenance: Provenance;
  /**
   * Estimated timestamp uncertainty (ms, 1-sigma).
   * Accounts for scanner clock drift and the method used to align counters.
   * `null` when uncertainty has not been characterised.
   */
  timestamp_uncertainty_ms: number | null;
}

/** How an observation entered the system. */
export type Provenance =
  | { type: "live-capture" }
  | { type: "imported"; format: string }
  | { type: "synthetic"; generator: string; seed: number };

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * An address as observed on a specific PHY/channel at a moment in time.
 *
 * The same physical asset may simultaneously or serially present different
 * addresses due to:
 *   - Address rotation (privacy spinners, scheduled rotation)
 *   - Multi-role devices (per-connection addresses)
 *   - Firmware or stack-level randomness
 *
 * An EphemeralAddress is NOT an asset identity — it is only evidence of one.
 */
export interface EphemeralAddress {
  /** The address bytes as transmitted. */
  address: string; // hex, no separators
  /** Address type classification from the BLE advertising report. */
  type: AddressType;
  /**
   * Whether this address is resolvable (RPA) or non-resolvable.
   * Distinguishes privacy-enabled rotation from static addresses.
   */
  resolvable: boolean;
  /**
   * PHY/channel on which this address was observed.
   * Multiple PHYs simultaneously imply a dual-mode or dual-radio device.
   */
  phy: Phy;
  channel: Channel;
}

/** BLE address type from the HCI advertising report event. */
export type AddressType =
  | "public"
  | "random-static"
  | "random-resolvable-private"
  | "random-non-resolvable-private";

/**
 * A physical asset that may present one or more ephemeral addresses.
 *
 * Tracks the probabilistic association between observed addresses and the
 * underlying asset — not a deterministic mapping.
 */
export interface AssetIdentity {
  /** Stable identifier for this asset hypothesis (opaque string). */
  id: string;
  /**
   * All addresses that have been linked to this asset, with the confidence
   * and last-seen timestamp for each.
   *
   * An address appearing in this list does NOT prove it belongs to this asset —
   * the `confidence` field encodes that assessment.
   */
  address_links: AddressLink[];
  /**
   * Rolling window of track hypotheses driving this identity.
   * Allows downstream to reason about how stable the association is.
   */
  track_hypotheses: TrackHypothesis[];
  /** ISO-8601 timestamp (ms) of the most recent evidence incorporated. */
  last_seen_ms: TimestampMs;
}

export interface AddressLink {
  address: EphemeralAddress;
  /**
   * Confidence that this address belongs to this asset (0–1).
   * A value of 1.0 means the link is treated as definitive; 0 means excluded.
   * Values between are weighted in probabilistic inference.
   */
  confidence: number;
  /** Timestamp (ms) of the observation that established this link. */
  established_ms: TimestampMs;
  /** Timestamp (ms) of the most recent supporting observation. */
  last_support_ms: TimestampMs;
  /**
   * Number of distinct observation sessions supporting this link.
   * More sessions → higher confidence in a stable association.
   */
  supporting_sessions: number;
}

/**
 * An active track with provenance, confidence, and evidence window metadata.
 *
 * A TrackHypothesis represents a belief about a physical asset's location
 * over time, not a single observation.
 */
export interface TrackHypothesis {
  /** Stable identifier for this track (opaque string). */
  id: string;
  /** The asset this track is attributed to. */
  asset_id: string;
  /**
   * Confidence in this track's validity (0–1).
   * Degrades when gaps appear, when identity is ambiguous, or when evidence
   * contradicts the track's motion model.
   */
  confidence: number;
  /**
   * Provenance summary for display and audit.
   */
  provenance: TrackProvenance;
  /**
   * Evidence window: oldest and newest observation timestamps in this track.
   */
  window: { oldest_ms: TimestampMs; newest_ms: TimestampMs } | null;
  /**
   * Whether this track is currently active (has recent evidence).
   */
  active: boolean;
}

export interface TrackProvenance {
  /**
   * Human-readable description of how this track was formed.
   * e.g. "Single static MAC", "Multi-address correlation (3 links)",
   *      "Probabilistic identity disambiguation"
   */
  method: string;
  /**
   * Version of the tracking algorithm that produced this hypothesis.
   * Enables reproducibility and regression detection.
   */
  algorithm_version: string;
  /**
   * SHA-256 of the input evidence set that produced this track.
   * Allows exact reproduction of the track from the same evidence pool.
   */
  evidence_fingerprint: string | null;
}

// ─── Scanner and Clock ───────────────────────────────────────────────────────

/**
 * A BLE scanner — a device that receives advertising frames.
 *
 * Multiple scanners observing the same asset provide the evidence needed for
 * multilateration.  Scanner identity and placement are critical inputs.
 */
export interface Scanner {
  /** Unique identifier for this scanner (opaque string). */
  id: string;
  /** Human-readable label for UI display. */
  label: string;
  /** Physical position in map coordinates (metres). */
  position: { x_m: number; y_m: number };
  /**
   * PHY capabilities of this scanner.
   * A scanner that only advertises on 1M cannot receive Coded PHY frames.
   */
  phy_supported: Phy[];
  /** Associated clock domain for timestamp correction. */
  clock: ClockDomain;
  /**
   * Whether this scanner is considered active and healthy.
   * Inactive scanners are excluded from position estimation.
   */
  active: boolean;
}

/**
 * Clock quality and synchronization state for a scanner.
 *
 * BLE scanners typically use cheap crystals that drift and offset over time.
 * Without correction, position estimates can be systematically biased.
 *
 * Clock quality flows into `Observation.timestamp_uncertainty_ms`.
 */
export interface ClockDomain {
  /** Identifier linking this clock domain to a scanner. */
  scanner_id: string;
  /**
   * Current estimated offset (scanner counter ms → wall-clock ms).
   * Applied as: wall_clock_ms = counter_ms + offset_ms
   */
  offset_ms: number;
  /**
   * Current estimated drift rate (parts per million).
   * Applied as: corrected_counter_ms = counter_ms / (1 + drift_ppm / 1e6)
   */
  drift_ppm: number;
  /**
   * Estimated uncertainty in offset_ms (1-sigma ms).
   * `null` when no characterization has been performed.
   */
  offset_uncertainty_ms: number | null;
  /**
   * Estimated uncertainty in drift_ppm (1-sigma ppm).
   * `null` when no characterisation has been performed.
   */
  drift_uncertainty_ppm: number | null;
  /**
   * Quality indicator for clock synchronization.
   * Used to weight scanner evidence in position estimation.
   */
  sync_quality: ClockSyncQuality;
  /**
   * Timestamp (ms, wall-clock) of the most recent clock synchronization event.
   * `null` when no sync has ever been performed.
   */
  last_sync_ms: TimestampMs | null;
  /**
   * Number of synchronization points used in the current estimate.
   * More points → higher confidence in offset/drift estimates.
   */
  sync_point_count: number;
}

export type ClockSyncQuality =
  /** No synchronization performed — timestamps are raw counter values. */
  | "unsynchronized"
  /** One-time offset correction, no drift tracking. */
  | "offset-only"
  /** Offset + drift estimated from two or more sync points. */
  | "characterized"
  /** Continuous or frequent sync, drift tracked and corrected in real time. */
  | "locked";

// ─── Calibration ─────────────────────────────────────────────────────────────

/**
 * A fitted path-loss calibration profile for a (scanner, asset, environment) tuple.
 *
 * Calibration validity is explicitly bound to its inputs, device/environment
 * scope, method, and model version — preventing silent misapplication of
 * profiles from different contexts.
 */
export interface CalibrationProfile {
  /** Unique identifier for this calibration profile. */
  id: string;
  /** Scanner this profile applies to. */
  scanner_id: string;
  /**
   * Asset identifier this profile was collected for.
   * `null` when the profile is an environment-wide average.
   */
  asset_id: string | null;
  /**
   * Environment identifier (e.g. building floor, room).
   * `null` when the environment scope is unknown or global.
   */
  environment: string | null;
  /** Fitted path-loss model parameters. */
  model: CalibrationModel;
  /**
   * SHA-256 fingerprint of the input calibration samples used to fit this profile.
   * Enables exact reproducibility and detection of staleness.
   */
  input_fingerprint: string;
  /** The samples used to fit this profile (for reproducibility). */
  samples: CalibrationSample[];
  /** Method used to fit the model. */
  method: CalibrationMethod;
  /** Version of the fitting algorithm. */
  algorithm_version: string;
  /**
   * Validity state — profiles become invalid when inputs or context change.
   */
  validity: CalibrationValidity;
  /** ISO-8601 timestamp (ms) when this profile was created. */
  created_ms: TimestampMs;
  /** ISO-8600 timestamp (ms) of the most recent re-validation. */
  last_validated_ms: TimestampMs;
}

export interface CalibrationModel {
  /** RSSI at 1 metre (dBm), intercept of the log-distance model. */
  reference: number;
  /**
   * Path-loss exponent.
   * Typical values: 2.0 (free space), 2.5–3.5 (indoor with walls).
   */
  exponent: number;
  /**
   * Residual standard deviation (dB).
   * Characterises typical RSSI variation around the model.
   */
  sigma: number;
  /**
   * Number of input samples used to fit this model.
   */
  n: number;
  /**
   * Sample mean of log10(distance) values.
   */
  mean_log_dist: number;
  /**
   * Sum of squared deviations of log10(distance) from the mean.
   * Needed for prediction interval construction without re-summing.
   */
  sxx: number;
  /**
   * t-quantile for 97.5% prediction intervals with (n-2) degrees of freedom.
   */
  t_quantile: number;
}

export interface CalibrationSample {
  distance_m: number;
  rssi: number;
  timestamp_ms: TimestampMs;
}

export type CalibrationMethod =
  "linear-regression-log-distance" | "wls-log-distance" | "robust-log-distance";

export interface CalibrationValidity {
  /**
   * Whether this profile is currently considered valid for position estimation.
   */
  valid: boolean;
  /**
   * Reason for invalidity or deprecation.
   * `null` when valid or when no determination has been made.
   */
  reason: string | null;
  /**
   * The input fingerprint this profile was last validated against.
   * If the current input fingerprint does not match, the profile is stale.
   */
  validated_against_fingerprint: string | null;
  /**
   * Time window (ms) after which this profile should be re-validated.
   * `null` means no time-based expiry.
   */
  max_age_ms: number | null;
}

// ─── Map space ───────────────────────────────────────────────────────────────

/**
 * A map coordinate space — typically a building floor with metric coordinates
 * and transforms to/from other reference frames.
 */
export interface MapSpace {
  /** Unique identifier for this map space. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Type of space. */
  kind: "building" | "floor" | "room" | "outdoor" | "other";
  /**
   * Physical dimensions in metres.
   * `null` when dimensions are unknown or unbounded.
   */
  dimensions: { width_m: number; height_m: number } | null;
  /**
   * Origin offset: local (0,0) in map coordinates corresponds to this
   * point in the parent or global coordinate frame.
   */
  origin_offset: { x_m: number; y_m: number };
  /**
   * Rotation of the local coordinate frame relative to the parent or global
   * frame, in degrees clockwise.
   */
  rotation_deg: number;
  /**
   * Scale factor (metres per unit in the raw coordinate system).
   * `null` means 1:1 (each unit = 1 metre).
   */
  scale: number | null;
}

// ─── Position estimate ───────────────────────────────────────────────────────

/**
 * A position estimate produced by the localization backend.
 *
 * Carries full uncertainty, integrity, and provenance metadata so that
 * consumers can decide how much to trust the estimate without peeking inside.
 */
export interface PositionEstimate {
  /** Unique identifier for this estimate. */
  id: string;
  /**
   * Backend that produced this estimate.
   * Discriminates between different algorithms and their characteristics.
   */
  backend: PositionBackend;
  /** Point estimate in map coordinates (metres). */
  point: { x_m: number; y_m: number };
  /**
   * Uncertainty as a covariance ellipse.
   * `null` when the backend does not provide uncertainty (e.g. point cloud).
   */
  covariance: PositionCovariance | null;
  /**
   * 95% confidence radius (m) — equivalent to the semi-major axis of the
   * 95% confidence ellipse.
   * `null` when uncertainty is not characterised.
   */
  confidence_radius_m: number | null;
  /**
   * Whether a unique, finite estimate was available.
   * `false` means the backend returned no-fix.
   */
  has_fix: boolean;
  /**
   * Integrity and no-fix metadata.
   */
  integrity: PositionIntegrity;
  /**
   * Evidence window used to produce this estimate.
   * `null` when the backend does not expose this.
   */
  evidence_window: { oldest_ms: TimestampMs; newest_ms: TimestampMs } | null;
  /** Provenance summary for this estimate. */
  provenance: PositionProvenance;
  /** ISO-8601 timestamp (ms) at which this estimate was computed. */
  computed_at_ms: TimestampMs;
}

export type PositionBackend =
  | "multilateration-least-squares"
  | "multilateration-grid-search"
  | "fingerprinting-knn"
  | "particle-filter"
  | "kalman-filter"
  | "dead-reckoning"
  | "user-input";

export interface PositionCovariance {
  /** Variance in x (m²). */
  var_x: number;
  /** Variance in y (m²). */
  var_y: number;
  /** Covariance of x and y (m²). */
  cov_xy: number;
  /**
   * Correlation coefficient (unitless, range [-1, 1]).
   * Convenience derived from var_x, var_y, cov_xy.
   */
  correlation: number;
}

export interface PositionIntegrity {
  /**
   * Reason string when `has_fix` is false.
   * `null` when `has_fix` is true.
   */
  nofix_reason: string | null;
  /**
   * Estimated false-alarm rate for this fix (mis-specified confidence region).
   * `null` when not characterised.
   */
  false_alarm_rate: number | null;
  /**
   * Whether the solution satisfied all internal quality gates.
   * When `false`, downstream users should treat `has_fix` as uncertain
   * even when a point is returned.
   */
  quality_gate_passed: boolean | null;
}

export interface PositionProvenance {
  /** Version of the localization algorithm. */
  algorithm_version: string;
  /** Which scanners contributed to this estimate. */
  scanner_ids: string[];
  /** Which asset identity was assumed. */
  asset_id: string | null;
  /**
   * SHA-256 fingerprint of the raw observations used.
   * Enables exact reproduction of this estimate.
   */
  evidence_fingerprint: string | null;
}
