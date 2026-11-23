"""Run with python -m unittest discover -s <skill>/scripts -p test_*.py."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from pypdf import PdfReader
from render_report import render, validate


EXAMPLE = Path(__file__).resolve().parent.parent / "assets/example-report.json"


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(EXAMPLE.read_text(encoding="utf-8"))

    def test_period_and_timezone_validation(self):
        for update in ({"period_start": "2026-11-06"},
                       {"period_end": "2026-11-07"},
                       {"as_of": "2026-11-06T09:00:00"},
                       {"timezone": "Invented/Timezone"}):
            with self.subTest(update=update), self.assertRaises((ValueError, KeyError)):
                validate({**self.data, **update})

    def test_evidence_references_must_resolve(self):
        self.data["accomplishments"][0]["sources"] = ["missing"]
        with self.assertRaisesRegex(ValueError, "Unknown source"):
            validate(self.data)
        self.data["accomplishments"][0]["sources"] = []
        with self.assertRaisesRegex(ValueError, "requires evidence"):
            validate(self.data)

    def test_duplicate_sources_rejected(self):
        self.data["sources"].append(deepcopy(self.data["sources"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate source"):
            validate(self.data)

    def test_pdf_retains_claims_dates_and_plain_text(self):
        self.data["accomplishments"][0]["title"] = 'Pilot <review> & "approval"'
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "brief.pdf"
            result = render(self.data, output)
            reader = PdfReader(output)
            text = "\n".join(page.extract_text() for page in reader.pages)
            self.assertEqual(result["pages"], len(reader.pages))
            self.assertIn('Pilot <review> & "approval"', text)
            for value in (self.data["period_start"], self.data["period_end"], "production deployment is still pending", "Synthetic Beads MER-12"):
                self.assertIn(value, text)

    def test_long_content_flows_without_losing_last_item(self):
        self.data["risks"] = [
            {"title": f"Dependency {i}", "detail": "Unconfirmed milestone and mitigation. " * 30,
             "sources": ["D1"]} for i in range(12)
        ]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "dense.pdf"
            render(self.data, output)
            reader = PdfReader(output)
            text = "\n".join(page.extract_text() for page in reader.pages)
            self.assertGreater(len(reader.pages), 2)
            self.assertIn("Dependency 11", text)
            self.assertIn("Evidence and coverage", text)
            self.assertIn("Unassigned", text)

    def test_failed_cli_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "invalid.json", Path(folder) / "prior.pdf"
            source.write_text("{invalid", encoding="utf-8")
            output.write_bytes(b"prior report")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("render_report.py")),
                                     str(source), str(output)], capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            envelope = json.loads(result.stdout)
            self.assertFalse(envelope["ok"])
            self.assertIsNone(envelope["data"])
            self.assertTrue(envelope["error"])
            self.assertEqual(output.read_bytes(), b"prior report")


if __name__ == "__main__":
    unittest.main()
