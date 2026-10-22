import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("OUTREACH_DB", str(Path(tempfile.mkdtemp()) / "t.db"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import common
import run_all


class ReportTests(unittest.TestCase):
    def test_report_sends_outcome_and_survives_errors(self):
        env = {"DASHBOARD_URL": "https://d.example/", "API_TOKEN": "tok"}
        with mock.patch.dict(os.environ, env), mock.patch.object(common, "http_request", return_value=(200, "", {}, b"{}")) as m:
            run_all.report("2000-01-01 00:00:00", False, ["visual.py"], [{"category": "plumber", "city": "Ocala"}])
        url, kw = m.call_args[0][0], m.call_args[1]
        self.assertEqual(url, "https://d.example/api/runs")
        self.assertFalse(kw["body"]["ok"])
        self.assertEqual(kw["body"]["failed"], ["visual.py"])
        self.assertEqual(kw["body"]["targets"], "plumber / Ocala")
        with mock.patch.dict(os.environ, env), mock.patch.object(common, "http_request", side_effect=RuntimeError("down")):
            run_all.report("2000-01-01 00:00:00", True, [], [])  # must not raise

    def test_report_is_skipped_without_dashboard_settings(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(common, "http_request") as m:
            run_all.report("2000-01-01 00:00:00", True, [], [])
        m.assert_not_called()


if __name__ == "__main__":
    unittest.main()
