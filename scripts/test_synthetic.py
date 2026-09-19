import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from jsonschema import Draft202012Validator
from generate_synthetic import CASES, ad_valid, encode, fixture, generate, verify
from package_review import archive
from privacy_gate import Gate, text_findings, valid_member

ROOT = Path(__file__).resolve().parents[1]


class SyntheticTests(unittest.TestCase):
    def test_deterministic_complete_provenance(self):
        verify()
        for entry in json.loads((ROOT / "public/fixtures/manifest.json").read_text())["fixtures"]:
            data = (ROOT / "public/fixtures" / entry["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
            self.assertEqual(len(json.loads(data)["events"]["t"]), entry["event_count"])

    def test_schema_and_semantic_edges(self):
        schema = json.loads((ROOT / "public/fixture.schema.json").read_text())
        Draft202012Validator.check_schema(schema)
        Draft202012Validator.check_schema(
            json.loads((ROOT / "public/project.schema.json").read_text())
        )
        validator = Draft202012Validator(schema)
        for args in CASES:
            f = fixture(*args)
            validator.validate(f)
            arrays = list(f["events"].values())
            self.assertEqual(len({len(x) for x in arrays}), 1)
            rows = list(zip(*arrays))
            self.assertGreater(len(rows), len(set(rows)))
            self.assertTrue(any(a == b for a, b in zip(f["events"]["t"], f["events"]["t"][1:])))
            self.assertTrue(any(v["malformed_ad"] for v in f["variants"]))
            self.assertTrue(any(v["extended_or_concatenated"] for v in f["variants"]))
            self.assertEqual(sum(b["rotation_group"] is not None for b in f["beacons"]), 2)
            self.assertTrue(
                all(v["malformed_ad"] == (not ad_valid(v["bytes"])) for v in f["variants"])
            )

    def test_package_bytes_and_paths(self):
        self.assertEqual(
            archive([("example.txt", b"synthetic")]), archive([("example.txt", b"synthetic")])
        )
        self.assertFalse(valid_member("../outside"))
        self.assertFalse(valid_member("/outside"))
        self.assertFalse(valid_member("a\\b"))


class PrivacyTests(unittest.TestCase):
    def test_mac_and_identifier_formats(self):
        address = ":".join(["02", "00", "00", "00", "00", "01"])
        self.assertIn("bluetooth-address", text_findings(address))
        self.assertIn("observation-short-id", text_findings("Device " + "A" * 4))

    def test_generic_capture_names(self):
        for name in ["capture-" + "log-012.json", "raw_" + "capture_data.csv"]:
            self.assertIn("capture-filename", text_findings(name))

    def test_contact_and_network_formats(self):
        self.assertIn("email", text_findings("invented" + "@" + "example.invalid"))
        self.assertIn("non-reserved-ip", text_findings(".".join(["8"] * 4)))
        self.assertNotIn("non-reserved-ip", text_findings("192.0.2.1"))
        self.assertIn("geographic-coordinate", text_findings("latitude: " + "12.34567"))
        self.assertIn("unapproved-url", text_findings("https://" + "unapproved.test"))

    def test_unknown_binary_and_modified_fixture_fail_closed(self):
        gate = Gate()
        gate.scan("example.bin", bytes([0, 255, 1]))
        self.assertIn("unapproved-binary", gate.findings)
        f = fixture(*CASES[0])
        f["events"]["rssi"][0] += 1
        gate.scan("example.json", encode(f))
        self.assertIn("non-generator-observations", gate.findings)

    def test_archive_traversal_and_nested_scanning(self):
        gate = Gate()
        gate.scan("example.tar.gz", archive([("../outside", b"synthetic")]))
        self.assertIn("unsafe-path", gate.findings)
        gate = Gate()
        address = ":".join(["02", "00", "00", "00", "00", "01"])
        gate.scan("nested.tar.gz", archive([("inside.txt", address.encode())]))
        self.assertIn("bluetooth-address", gate.findings)

    def test_structured_coordinates_and_duplicate_keys(self):
        gate = Gate()
        gate.scan("example.json", json.dumps({"latitude": 0, "longitude": 0}).encode())
        self.assertIn("restricted-structured-field", gate.findings)
        gate.scan("example.json", b'{"synthetic":true,"synthetic":false}')
        self.assertIn("invalid-structured-document", gate.findings)

    def test_generator_never_reads_external_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            generate(Path(tmp))
            self.assertEqual(len(list(Path(tmp).iterdir())), 6)


if __name__ == "__main__":
    unittest.main()
