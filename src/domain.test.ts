import { describe, expect, it } from "vitest";
import {
  Observation,
  EphemeralAddress,
  AssetIdentity,
  Scanner,
  ClockDomain,
  CalibrationProfile,
  MapSpace,
  PositionEstimate,
  PositionBackend,
} from "./domain";

describe("domain model v2 — issue #17 [M1]", () => {
  describe("Observation", () => {
    it("accepts a fully-specified live-capture observation", () => {
      const obs: Observation = {
        timestamp_ms: 1_700_000_000_000,
        counter_ms: 42_000,
        scanner_id: "scanner-001",
        address: {
          address: "AA:BB:CC:DD:EE:FF",
          type: "random-resolvable-private",
          resolvable: true,
          phy: 1,
          channel: 37,
        },
        rssi: -72,
        phy: 1,
        channel: 37,
        payload: new Uint8Array([0x02, 0x01, 0x1a]),
        seq: 17,
        provenance: { type: "live-capture" },
        timestamp_uncertainty_ms: 1.5,
      };
      expect(obs.rssi).toBe(-72);
      expect(obs.address.resolvable).toBe(true);
      expect(obs.provenance).toEqual({ type: "live-capture" });
    });

    it("accepts an imported synthetic observation with null payload", () => {
      const obs: Observation = {
        timestamp_ms: 1_700_000_000_000,
        counter_ms: 0,
        scanner_id: "scanner-001",
        address: {
          address: "112233445566",
          type: "public",
          resolvable: false,
          phy: 1,
          channel: 37,
        },
        rssi: -65,
        phy: 1,
        channel: 37,
        payload: null,
        seq: null,
        provenance: { type: "synthetic", generator: "ble-map-fixture", seed: 42 },
        timestamp_uncertainty_ms: null,
      };
      expect(obs.payload).toBeNull();
      expect(obs.seq).toBeNull();
      expect(obs.timestamp_uncertainty_ms).toBeNull();
    });

    it("distinguishes address types", () => {
      const types: Array<Observation["address"]["type"]> = [
        "public",
        "random-static",
        "random-resolvable-private",
        "random-non-resolvable-private",
      ];
      expect(types).toHaveLength(4);
    });
  });

  describe("EphemeralAddress", () => {
    it("carries PHY and channel as evidence, not as identity", () => {
      const addr: EphemeralAddress = {
        address: "AA:BB:CC:DD:EE:FF",
        type: "random-resolvable-private",
        resolvable: true,
        phy: 4, // Coded PHY
        channel: 38,
      };
      // Changing channel does not change identity — same asset observed on different channel
      expect(addr.channel).toBe(38);
    });

    it("distinguishes resolvable from non-resolvable RPA", () => {
      const rpa: EphemeralAddress = {
        address: "ABCD12345678",
        type: "random-resolvable-private",
        resolvable: true,
        phy: 1,
        channel: 37,
      };
      const nrpa: EphemeralAddress = {
        address: "ABCD12345679",
        type: "random-non-resolvable-private",
        resolvable: false,
        phy: 1,
        channel: 37,
      };
      expect(rpa.resolvable).toBe(true);
      expect(nrpa.resolvable).toBe(false);
    });
  });

  describe("AssetIdentity", () => {
    it("links multiple addresses with per-link confidence", () => {
      const identity: AssetIdentity = {
        id: "asset-001",
        address_links: [
          {
            address: {
              address: "AA:BB:CC:DD:EE:FF",
              type: "random-resolvable-private",
              resolvable: true,
              phy: 1,
              channel: 37,
            },
            confidence: 0.95,
            established_ms: 1_700_000_000_000,
            last_support_ms: 1_700_000_100_000,
            supporting_sessions: 3,
          },
          {
            address: {
              address: "11:22:33:44:55:66",
              type: "random-resolvable-private",
              resolvable: true,
              phy: 1,
              channel: 37,
            },
            confidence: 0.6,
            established_ms: 1_700_000_050_000,
            last_support_ms: 1_700_000_100_000,
            supporting_sessions: 1,
          },
        ],
        track_hypotheses: [],
        last_seen_ms: 1_700_000_100_000,
      };
      expect(identity.address_links).toHaveLength(2);
      expect(identity.address_links[0].confidence).toBe(0.95);
      expect(identity.address_links[1].confidence).toBe(0.6);
    });

    it("carries track hypotheses for provenance and confidence tracking", () => {
      const identity: AssetIdentity = {
        id: "asset-001",
        address_links: [],
        track_hypotheses: [
          {
            id: "track-001",
            asset_id: "asset-001",
            confidence: 0.88,
            provenance: {
              method: "Multi-address correlation (2 links)",
              algorithm_version: "1.0.0",
              evidence_fingerprint: null,
            },
            window: { oldest_ms: 1_699_999_800_000, newest_ms: 1_700_000_000_000 },
            active: true,
          },
        ],
        last_seen_ms: 1_700_000_000_000,
      };
      expect(identity.track_hypotheses[0].active).toBe(true);
      expect(identity.track_hypotheses[0].confidence).toBe(0.88);
    });
  });

  describe("ClockDomain", () => {
    it("represents unsynchronized, offset-only, and characterized states", () => {
      const unsynced: ClockDomain = {
        scanner_id: "scanner-001",
        offset_ms: 0,
        drift_ppm: 0,
        offset_uncertainty_ms: null,
        drift_uncertainty_ppm: null,
        sync_quality: "unsynchronized",
        last_sync_ms: null,
        sync_point_count: 0,
      };
      expect(unsynced.sync_quality).toBe("unsynchronized");

      const locked: ClockDomain = {
        scanner_id: "scanner-002",
        offset_ms: 150,
        drift_ppm: 12.5,
        offset_uncertainty_ms: 0.3,
        drift_uncertainty_ppm: 0.8,
        sync_quality: "locked",
        last_sync_ms: 1_700_000_000_000,
        sync_point_count: 250,
      };
      expect(locked.sync_quality).toBe("locked");
      expect(locked.offset_uncertainty_ms).toBeCloseTo(0.3);
    });
  });

  describe("Scanner", () => {
    it("groups scanner identity with its clock domain", () => {
      const scanner: Scanner = {
        id: "scanner-001",
        label: "Lab corner",
        position: { x_m: 3.5, y_m: 7.2 },
        phy_supported: [1, 2, 4],
        clock: {
          scanner_id: "scanner-001",
          offset_ms: 0,
          drift_ppm: 0,
          offset_uncertainty_ms: null,
          drift_uncertainty_ppm: null,
          sync_quality: "unsynchronized",
          last_sync_ms: null,
          sync_point_count: 0,
        },
        active: true,
      };
      expect(scanner.phy_supported).toContain(4); // Coded PHY
      expect(scanner.clock.scanner_id).toBe(scanner.id);
    });
  });

  describe("CalibrationProfile", () => {
    it("binds validity to input fingerprint and environment scope", () => {
      const profile: CalibrationProfile = {
        id: "cal-001",
        scanner_id: "scanner-001",
        asset_id: "asset-001",
        environment: "floor-2",
        model: {
          reference: -55.2,
          exponent: 2.1,
          sigma: 3.4,
          n: 24,
          mean_log_dist: 0.8,
          sxx: 5.6,
          t_quantile: 2.068,
        },
        input_fingerprint:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        samples: [
          { distance_m: 1, rssi: -55, timestamp_ms: 1_700_000_000_000 },
          { distance_m: 5, rssi: -67, timestamp_ms: 1_700_000_100_000 },
        ],
        method: "linear-regression-log-distance",
        algorithm_version: "1.0.0",
        validity: {
          valid: true,
          reason: null,
          validated_against_fingerprint:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          max_age_ms: 86_400_000, // 24 hours
        },
        created_ms: 1_700_000_000_000,
        last_validated_ms: 1_700_000_000_000,
      };
      expect(profile.validity.valid).toBe(true);
      expect(profile.model.exponent).toBeCloseTo(2.1);
    });

    it("marks a stale profile invalid when fingerprint does not match", () => {
      const profile: CalibrationProfile = {
        id: "cal-stale",
        scanner_id: "scanner-001",
        asset_id: null,
        environment: null,
        model: {
          reference: -60,
          exponent: 2.0,
          sigma: 4.0,
          n: 6,
          mean_log_dist: 0.5,
          sxx: 2.0,
          t_quantile: 2.015,
        },
        input_fingerprint: "old-fingerprint",
        samples: [],
        method: "linear-regression-log-distance",
        algorithm_version: "1.0.0",
        validity: {
          valid: false,
          reason: "Input fingerprint mismatch: calibration samples have changed",
          validated_against_fingerprint: "current-fingerprint",
          max_age_ms: null,
        },
        created_ms: 1_699_900_000_000,
        last_validated_ms: 1_699_900_000_000,
      };
      expect(profile.validity.valid).toBe(false);
      expect(profile.validity.reason).toContain("fingerprint");
    });

    it("rejects invalid method variants at the type level", () => {
      const methods: Array<CalibrationProfile["method"]> = [
        "linear-regression-log-distance",
        "wls-log-distance",
        "robust-log-distance",
      ];
      expect(methods).toHaveLength(3);
    });
  });

  describe("MapSpace", () => {
    it("represents a floor with origin offset and rotation", () => {
      const space: MapSpace = {
        id: "floor-2",
        name: "Second floor",
        kind: "floor",
        dimensions: { width_m: 40, height_m: 30 },
        origin_offset: { x_m: 100, y_m: 200 },
        rotation_deg: 0,
        scale: null,
      };
      expect(space.kind).toBe("floor");
      expect(space.dimensions?.width_m).toBe(40);
    });
  });

  describe("PositionEstimate", () => {
    it("carries full uncertainty and integrity metadata", () => {
      const estimate: PositionEstimate = {
        id: "fix-001",
        backend: "multilateration-grid-search",
        point: { x_m: 5.3, y_m: 7.1 },
        covariance: { var_x: 1.5, var_y: 2.0, cov_xy: 0.4, correlation: 0.26 },
        confidence_radius_m: 2.4,
        has_fix: true,
        integrity: {
          nofix_reason: null,
          false_alarm_rate: 0.05,
          quality_gate_passed: true,
        },
        evidence_window: {
          oldest_ms: 1_700_000_000_000,
          newest_ms: 1_700_000_050_000,
        },
        provenance: {
          algorithm_version: "1.0.0",
          scanner_ids: ["scanner-001", "scanner-002", "scanner-003"],
          asset_id: "asset-001",
          evidence_fingerprint: null,
        },
        computed_at_ms: 1_700_000_100_000,
      };
      expect(estimate.has_fix).toBe(true);
      expect(estimate.confidence_radius_m).toBeCloseTo(2.4);
      expect(estimate.integrity.quality_gate_passed).toBe(true);
    });

    it("represents a no-fix with integrity metadata", () => {
      const nofix: PositionEstimate = {
        id: "nofix-001",
        backend: "multilateration-grid-search",
        point: { x_m: 0, y_m: 0 },
        covariance: null,
        confidence_radius_m: null,
        has_fix: false,
        integrity: {
          nofix_reason: "Fewer than three recent receivers: no unique fix.",
          false_alarm_rate: null,
          quality_gate_passed: false,
        },
        evidence_window: null,
        provenance: {
          algorithm_version: "1.0.0",
          scanner_ids: ["scanner-001"],
          asset_id: null,
          evidence_fingerprint: null,
        },
        computed_at_ms: 1_700_000_100_000,
      };
      expect(nofix.has_fix).toBe(false);
      expect(nofix.integrity.nofix_reason).toContain("Fewer than three");
    });

    it("covers all known backend types", () => {
      const backends: PositionBackend[] = [
        "multilateration-least-squares",
        "multilateration-grid-search",
        "fingerprinting-knn",
        "particle-filter",
        "kalman-filter",
        "dead-reckoning",
        "user-input",
      ];
      expect(backends).toHaveLength(7);
    });
  });
});
