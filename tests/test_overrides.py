import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("OUTREACH_DB", str(Path(tempfile.mkdtemp()) / "t.db"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import common
import overrides
import push_to_dashboard


def make(conn, website, status="polished"):
    cur = conn.execute("INSERT INTO leads (place_id, company, website, city, category, email, status) VALUES (?,?,?,?,?,?,?)",
                       (website, "Acme " + website, website, "Ocala", "plumber", "a@" + website, status))
    lid = cur.lastrowid
    conn.execute("INSERT INTO visual_audits (lead_id, findings_json, mobile_path, desktop_path, token, page_url, polish) VALUES (?,?,?,?,?,?,?)",
                 (lid, '[{"text":"Footer year is old"}]', "m", "d", "tok", None, 4))
    conn.commit()
    return lid


class OverrideTests(unittest.TestCase):
    def setUp(self):
        self.conn = common.connect(Path(tempfile.mkdtemp()) / "x.db")

    def test_skipped_sites_are_collected_once(self):
        make(self.conn, "a.com")
        got = push_to_dashboard.collect_skipped(self.conn)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["polish"], 4)
        self.assertEqual(got[0]["findings"], ["Footer year is old"])
        self.conn.execute("UPDATE leads SET skip_pushed=1")
        self.assertEqual(push_to_dashboard.collect_skipped(self.conn), [])

    def test_send_anyway_resets_the_lead_for_drafting(self):
        lid = make(self.conn, "a.com")
        make(self.conn, "b.com", status="drafted")
        done = overrides.apply_overrides(self.conn, ["a.com", "b.com", "zzz.com"])
        self.assertEqual(done, ["Acme a.com"])
        row = self.conn.execute("SELECT status, force_send FROM leads WHERE id=?", (lid,)).fetchone()
        self.assertEqual((row["status"], row["force_send"]), ("audited", 1))
        self.assertIsNone(self.conn.execute("SELECT 1 FROM visual_audits WHERE lead_id=?", (lid,)).fetchone())


if __name__ == "__main__":
    unittest.main()
