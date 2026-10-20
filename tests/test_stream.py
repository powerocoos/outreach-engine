import datetime
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("OUTREACH_DB", os.path.join(tempfile.mkdtemp(), "t.db"))  # never touch the real data dir
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import social_stream as ss
from common import connect

MON = datetime.date(2026, 10, 19)   # Monday
SUN = datetime.date(2026, 10, 18)
TOPICS = [{"id": "a", "title": "Tap to call: make it easy", "facts": ["Many people search on phones.", "A button helps."]},
          {"id": "b", "title": "Answer reviews", "facts": ["Reply politely."]}]
STAT = {"id": "no-call-button", "n": 38, "count": 14, "pct": 37, "scope": "local HVAC company websites",
        "desc": "had no visible call button or phone number on the first phone screen"}
SITE = "https://ocooswebconsulting.com"


def good_draft(kind):
    fb = ("Many people search on their phones, so a call button matters. " * 2 + "Reply politely to reviews and keep your "
          "button visible. Message us with questions about your own website and we will gladly take a look at it together.")
    ig = ("Many people search on phones, so make the button easy to tap, and keep it visible on every page.\n\nReply politely to "
          "every review you get, good or bad.\n\nMessage us with questions about your website and we will take a look.\n\nLink in bio.\n\n#OcalaFlorida #NorthCentralFlorida #SmallBusiness "
          "#WebDesign #LocalBusiness")
    if kind == "teardown":
        fb = (f"Of 38 local HVAC company websites checked on a phone, 14 (37%) had no visible call button on the first screen. "
              "That is a quick fix: put a call button where the thumb can reach it. We offer a free 15-minute website audit "
              "and you can message us to get one. It only takes a short chat and you will leave with a clear list of changes.")
        ig = ("38 local HVAC websites checked on a phone, 14 (37%) had no call button on the first screen.\n\nThat is an easy fix "
              "and it can make a real difference to a customer who is ready to call.\n\nWe offer a free 15-minute website audit. "
              "Message us to get one.\n\nLink in bio.\n\n#OcalaFlorida #NorthCentralFlorida #SmallBusiness #HVAC #WebDesign")
    return {"facebook": fb, "instagram": ig}


class ChooseTests(unittest.TestCase):
    def test_only_on_stream_days_unless_forced(self):
        self.assertEqual(ss.choose(set(), TOPICS, [], 0, SUN), [])
        self.assertEqual(len(ss.choose(set(), TOPICS, [], 0, SUN, force=True)), 2)

    def test_queue_limit(self):
        self.assertEqual(ss.choose(set(), TOPICS, [], ss.QUEUE_TARGET, MON), [])

    def test_one_per_run_and_known_topics_are_skipped(self):
        got = ss.choose({f"{SITE}/#tip-a"}, TOPICS, [], 0, MON)
        self.assertEqual([(k, key) for k, key, _ in got], [("tip", f"{SITE}/#tip-b")])

    def test_teardown_follows_a_tip_and_is_once_per_month(self):
        known = {f"{SITE}/#tip-a"}
        kind, key, _ = ss.choose(known, TOPICS, [STAT], 0, MON)[0]
        self.assertEqual((kind, key), ("teardown", f"{SITE}/#check-no-call-button-2026-10"))
        known.add(key)
        self.assertEqual(ss.choose(known, TOPICS, [STAT], 0, MON)[0][0], "tip")


class StatsTests(unittest.TestCase):
    def fill(self, n, with_problem):
        conn = connect(os.path.join(tempfile.mkdtemp(), "stream.db"))
        conn.execute("DELETE FROM visual_audits"); conn.execute("DELETE FROM leads")
        for i in range(n):
            conn.execute("INSERT INTO leads (id, company, category) VALUES (?,?,?)", (i + 1, f"Co {i}", "HVAC contractor"))
            text = "On a phone, no phone number or call/quote button is visible on the first screen." if i < with_problem else "Fine."
            conn.execute("INSERT INTO visual_audits (lead_id, findings_json) VALUES (?,?)",
                         (i + 1, json.dumps([{"text": text, "service": "design", "source": "page"}])))
        conn.commit()
        return conn

    def test_stat_needs_a_big_enough_sample(self):
        self.assertEqual(ss.compute_stats(self.fill(10, 6)), [])

    def test_counts_and_wording(self):
        stats = ss.compute_stats(self.fill(20, 8))
        self.assertEqual(len(stats), 1)
        s = stats[0]
        self.assertEqual((s["n"], s["count"], s["pct"]), (20, 8, 40))
        self.assertEqual(s["scope"], "local HVAC company websites")
        self.assertIn("8 (40%)", ss.stat_sentence(s))
        self.assertNotIn("Co ", ss.stat_sentence(s))   # never names a business

    def test_rare_problems_are_not_reported(self):
        self.assertEqual(ss.compute_stats(self.fill(30, 2)), [])


class DraftTests(unittest.TestCase):
    def test_good_drafts_pass_and_bad_ones_are_retried_then_dropped(self):
        self.assertEqual(ss.stream_problems(good_draft("tip"), "tip", {"title": "x", "facts": ["Many people search on phones."]}), [])
        self.assertEqual(ss.stream_problems(good_draft("teardown"), "teardown", STAT), [])
        calls = []

        def drafter(kind, item, key, problems=None):
            calls.append(1)
            d = good_draft("teardown")
            d["facebook"] = d["facebook"].replace("14 (37%)", "20 (90%)")   # numbers not in the result
            return d
        self.assertIsNone(ss.make_stream_draft("teardown", STAT, "k", drafter))
        self.assertEqual(len(calls), 2)

    def test_teardown_must_offer_the_free_audit(self):
        d = good_draft("teardown")
        d["facebook"] = d["facebook"].replace("free", "complimentary")
        d["instagram"] = d["instagram"].replace("free", "complimentary")
        self.assertTrue(any("free audit" in p for p in ss.stream_problems(d, "teardown", STAT)))

    def test_payload_shape(self):
        p = ss.to_stream_payload("teardown", f"{SITE}/#check-x-2026-10", STAT, good_draft("teardown"), "https://d/x.jpg", MON)
        self.assertEqual(p["kind"], "teardown")
        self.assertIn("utm_campaign=site-checks", p["link"])
        self.assertTrue(p["post_url"].startswith("https://"))



class EmojiTests(unittest.TestCase):
    def test_emoji_limits(self):
        d = good_draft("tip")
        item = {"title": "x", "facts": ["Many people search on phones."]}
        d["instagram"] = d["instagram"].replace("Link in bio.", "\u2705 \U0001F4F8 \U0001F504 Link in bio.")
        self.assertIn("instagram has more than 2 emoji", ss.stream_problems(d, "tip", item))


if __name__ == "__main__":
    unittest.main()
