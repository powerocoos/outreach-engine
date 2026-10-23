import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp()
os.environ["OUTREACH_DB"] = os.path.join(_TMP, "e2e.db")  # must be set before importing common

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import audit
import brand
import captions
import capture
import crawler
import lead_finder
import personalize
from common import connect


class CrawlerTests(unittest.TestCase):
    def test_extracts_mailto_and_plain(self):
        html = '<a href="mailto:Owner@CoolAir.com?subject=hi">x</a> call info@coolair.com'
        self.assertEqual(sorted(crawler.extract_emails(html)), ["info@coolair.com", "owner@coolair.com"])

    def test_filters_junk(self):
        html = "logo@2x.png noreply@coolair.com abc@sentry.io me@example.com real@coolair.com"
        self.assertEqual(crawler.extract_emails(html), ["real@coolair.com"])

    def test_prefers_own_domain_and_person(self):
        ranked = crawler.rank_emails(["info@gmail.com", "info@coolair.com", "john.smith@coolair.com"], "coolair.com")
        self.assertEqual(ranked[0], "john.smith@coolair.com")
        self.assertEqual(ranked[-1], "info@gmail.com")


class AuditTests(unittest.TestCase):
    GOOD = '<meta name="viewport" content="width=device-width"><a href="tel:3525550100">Call</a><form></form>'

    def test_good_page_has_no_findings(self):
        facts = audit.analyze_html(self.GOOD, "https://x.com")
        self.assertEqual(audit.build_findings(facts, 90, 2.0), [])

    def test_bad_page_findings(self):
        facts = audit.analyze_html("<html><body>hi</body></html>", "http://x.com")
        f = audit.build_findings(facts, 31, 6.2)
        self.assertEqual(len(f), 5)
        self.assertTrue(any("31/100" in x for x in f))
        self.assertTrue(any("6.2 seconds" in x for x in f))

    def test_missing_pagespeed_is_not_invented(self):
        facts = audit.analyze_html(self.GOOD, "https://x.com")
        self.assertEqual(audit.build_findings(facts, None, None), [])


class LeadFinderTests(unittest.TestCase):
    def test_parse_and_dedupe(self):
        place = {"id": "abc", "displayName": {"text": "Cool Air"}, "websiteUri": "https://coolair.com",
                 "nationalPhoneNumber": "(352) 555-0100", "rating": 4.8, "userRatingCount": 120}
        lead = lead_finder.parse_place(place, "HVAC contractor", "Gainesville, FL")
        self.assertEqual(lead["city"], "Gainesville")
        with tempfile.TemporaryDirectory() as d:
            conn = connect(os.path.join(d, "t.db"))
            self.assertTrue(lead_finder.save_lead(conn, lead))
            self.assertFalse(lead_finder.save_lead(conn, lead))  # duplicate place_id ignored


class PersonalizeTests(unittest.TestCase):
    LEAD = {"company": "Cool Air", "city": "Gainesville"}

    def test_template_passes_validation(self):
        d = personalize.template_draft(self.LEAD, ["The homepage has no tap-to-call phone link for people searching on a phone."])
        self.assertEqual(personalize.validate_draft(d, []), [])

    def test_rejects_long_or_no_cta(self):
        d = {"angle": "a", "subject": "s", "email1": "word " * 130 + "?", "email2": "no question here", "email3": "ok?"}
        problems = personalize.validate_draft(d, [])
        self.assertTrue(any("email1" in p for p in problems))
        self.assertTrue(any("email2 has no question" in p for p in problems))

    def test_rejects_missing_field(self):
        self.assertIn("missing subject", personalize.validate_draft({"angle": "a", "email1": "x?"}, []))


class CaptureTests(unittest.TestCase):
    def test_short_page_single_frame(self):
        self.assertEqual(capture.scroll_plan(600, 844), [0])

    def test_long_page_is_capped_and_ends_at_bottom_of_window(self):
        plan = capture.scroll_plan(20000, 844)
        self.assertEqual(plan[0], 0)
        self.assertLessEqual(len(plan), capture.MAX_SCREENS)
        self.assertEqual(plan, sorted(plan))

    def test_medium_page_reaches_bottom(self):
        plan = capture.scroll_plan(1500, 844)
        self.assertEqual(plan[-1], 1500 - 844)


class CaptionTests(unittest.TestCase):
    def test_captions_come_only_from_findings(self):
        self.assertEqual(captions.captions_for([]), [])

    def test_caption_text_and_priority_cap(self):
        facts = audit.analyze_html("<html></html>", "http://x.com")
        findings = audit.build_findings(facts, 31, 6.2)
        caps = captions.captions_for(findings)
        self.assertEqual(len(caps), captions.MAX_CAPTIONS)
        self.assertEqual(caps[0], "No tap-to-call button on the homepage")
        self.assertIn("31/100", caps[1])
        self.assertIn("6.2s", caps[2])

    def test_each_finding_type_has_a_caption(self):
        facts = audit.analyze_html("<html></html>", "http://x.com")
        findings = audit.build_findings(facts, 31, 6.2)
        for f in findings:
            self.assertTrue(captions.captions_for([f]), f"no caption for: {f}")


class VideoDraftTests(unittest.TestCase):
    LEAD = {"company": "Cool Air", "city": "Gainesville"}
    FINDING = ["The homepage has no tap-to-call phone link for people searching on a phone."]
    URL = "https://dash.example/v/" + "a" * 32

    def test_template_includes_link_only_when_video_exists(self):
        with_v = personalize.template_draft(self.LEAD, self.FINDING, self.URL)
        without = personalize.template_draft(self.LEAD, self.FINDING)
        self.assertIn(self.URL, with_v["email1"])
        self.assertEqual(personalize.validate_draft(with_v, [], self.URL), [])
        self.assertNotIn("recorded", without["email1"])
        self.assertEqual(personalize.validate_draft(without, [], None), [])

    def test_rejects_missing_link_when_video_exists(self):
        d = personalize.template_draft(self.LEAD, self.FINDING)
        self.assertIn("email1 is missing the video link", personalize.validate_draft(d, [], self.URL))

    def test_rejects_video_claim_when_no_video(self):
        d = personalize.template_draft(self.LEAD, self.FINDING)
        d["email1"] += " I recorded a quick video for you?"
        self.assertTrue(any("mentions a video" in p for p in personalize.validate_draft(d, [], None)))


class EndToEndTests(unittest.TestCase):
    def test_audited_lead_with_clip_gets_linked_draft(self):
        conn = connect()
        conn.execute("INSERT INTO leads (place_id, company, city, email, website, status) VALUES ('p1','Cool Air','Gainesville','a@coolair.com','https://coolair.com','audited')")
        conn.execute("INSERT INTO audits (lead_id, reachable, findings_json) VALUES (1, 1, ?)", (json.dumps(["The homepage has no tap-to-call phone link for people searching on a phone."]),))
        conn.execute("INSERT INTO captures (lead_id, video_path, token, video_url) VALUES (1, 'x.mp4', ?, 'https://dash.example/v/abc')", ("a" * 32,))
        conn.execute("INSERT INTO leads (place_id, company, city, email, website, status) VALUES ('p2','No Issues Inc','Ocala','b@x.com','https://x.com','audited')")
        conn.execute("INSERT INTO audits (lead_id, reachable, findings_json) VALUES (2, 1, '[]')")
        conn.commit()
        conn.close()
        personalize.run(use_template=True)
        conn = connect()
        d = conn.execute("SELECT * FROM drafts").fetchall()
        self.assertEqual(len(d), 1)                      # lead with no findings is skipped
        self.assertIn("https://dash.example/v/abc", d[0]["email1"])
        self.assertEqual(conn.execute("SELECT status FROM leads WHERE id=1").fetchone()[0], "drafted")
        self.assertEqual(conn.execute("SELECT status FROM leads WHERE id=2").fetchone()[0], "audited")

    def test_branding_and_instantly_export(self):
        import csv
        d = personalize.template_draft(self.LEAD if hasattr(self, "LEAD") else {"company": "Cool Air", "city": "Gainesville"},
                                       ["No tap-to-call."])
        self.assertIn("Ocoos Web Consulting", d["email1"])
        self.assertIn(brand.OFFER, d["email3"])
        self.assertIn("Ocoos Web Consulting", personalize.SYSTEM_PROMPT)
        self.assertNotIn("Red Panda", personalize.SYSTEM_PROMPT)
        conn = connect()
        conn.execute("UPDATE drafts SET approved=1")
        conn.commit()
        conn.close()
        out = os.path.join(_TMP, "instantly.csv")
        personalize.export_instantly(out)
        rows = list(csv.DictReader(open(out)))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["brand_name"], "Ocoos Web Consulting")
        self.assertEqual(rows[0]["company_name"], "Cool Air")
        self.assertTrue(rows[0]["email1"].strip())
        self.assertEqual(list(rows[0].keys()), personalize.INSTANTLY_COLUMNS)




class WritingRuleTests(unittest.TestCase):
    def _draft(self, **kw):
        d = {"angle": "a", "subject": "Google's mobile test on Acme", "email1": "Hi. In Google's test it took 10.4 seconds. Worth a look?",
             "email2": "Next. Want it?", "email3": "Last. Okay?"}
        d.update(kw)
        return d

    def test_clean_draft_passes(self):
        self.assertEqual(personalize.validate_draft(self._draft(), ["f"]), [])

    def test_timing_in_subject_rejected(self):
        p = personalize.validate_draft(self._draft(subject="Your site takes 10 seconds"), ["f"])
        self.assertTrue(any("subject" in x for x in p))

    def test_unattributed_timing_rejected(self):
        p = personalize.validate_draft(self._draft(email2="It takes 12 seconds to load. Want help?"), ["f"])
        self.assertTrue(any("email2" in x for x in p))

    def test_audit_targets_homepage(self):
        self.assertIn("Google's mobile speed test", audit.build_findings(
            {"https": True, "has_viewport": True, "has_tap_to_call": True}, None, 6.2)[0])


if __name__ == "__main__":
    unittest.main()


class PushTests(unittest.TestCase):
    def test_collect_builds_review_payload(self):
        import push_to_dashboard
        from common import connect
        with tempfile.TemporaryDirectory() as d:
            conn = connect(os.path.join(d, "t.db"))
            conn.execute("INSERT INTO leads (id, company, email, website, city, category, rating, review_count, status)"
                         " VALUES (1,'Cool Air','a@b.com','http://x','Gainesville','HVAC',4.9,12,'drafted')")
            conn.execute("INSERT INTO audits (lead_id, mobile_score, findings_json) VALUES (1, 31, '[\"f1\"]')")
            conn.execute("INSERT INTO drafts (lead_id, angle, subject, email1, email2, email3) VALUES (1,'a','s','e1','e2','e3')")
            conn.execute("INSERT INTO leads (id, company, email, status) VALUES (2,'Done','c@d.com','queued')")
            conn.commit()
            out = push_to_dashboard.collect(conn)
            self.assertEqual(len(out), 1)
            self.assertEqual(out[0]["findings"], ["f1"])
            self.assertEqual(out[0]["contact_email"], "a@b.com")
            self.assertEqual(out[0]["review_count"], 12)

    def test_bot_user_agent_is_ocoos(self):
        import common
        self.assertIn("Ocoos", common.USER_AGENT)
        self.assertNotIn("redpanda", common.USER_AGENT.lower())


class RunAllTests(unittest.TestCase):
    def test_targets_rotate_and_cover_everything(self):
        import datetime
        import run_all
        targets = [{"category": "c", "city": str(i), "max": 20} for i in range(13)]
        day = datetime.date(2026, 10, 21)
        got = run_all.todays_targets(targets, day, 5)
        self.assertEqual(len(got), 5)
        self.assertEqual(run_all.todays_targets(targets[:4], day, 5), targets[:4])  # short list: all of it
        seen = set()
        for n in range(26):  # every target comes up within a couple of cycles
            seen |= {t["city"] for t in run_all.todays_targets(targets, day + datetime.timedelta(days=n), 5)}
        self.assertEqual(len(seen), 13)

    def test_weekday_runs_cover_the_real_target_list_and_mix_trades(self):
        import datetime
        import json
        import run_all
        targets = json.loads(run_all.TARGETS.read_text())
        day, seen, runs = datetime.date(2026, 10, 26), set(), 0
        while runs < len(targets) // 2 + 1:
            if day.weekday() < 5:
                got = run_all.todays_targets(targets, day, 2)
                self.assertEqual(len({t["category"] for t in got}), 2)  # two different trades per run
                seen |= {(t["category"], t["city"]) for t in got}
                runs += 1
            day += datetime.timedelta(days=1)
        self.assertEqual(len(seen), len(targets))  # every target within one pass of weekdays, no repeats
        idx = [run_all.weekday_index(datetime.date(2026, 10, d)) for d in (23, 26, 27)]  # Fri, Mon, Tue
        self.assertEqual((idx[1] - idx[0], idx[2] - idx[1]), (1, 1))

    def test_sites_without_email_are_not_recrawled_every_run(self):
        import lead_finder
        conn = connect()
        conn.execute("INSERT INTO leads (place_id, company, website) VALUES ('p-old','Old Co','https://old.example')")
        conn.execute("INSERT INTO leads (place_id, company, website, email_checked_at) "
                     "VALUES ('p-new','Fresh Co','https://fresh.example', CURRENT_TIMESTAMP)")
        conn.commit()
        rows = conn.execute(
            "SELECT company FROM leads WHERE email IS NULL AND website IS NOT NULL "
            "AND (email_checked_at IS NULL OR email_checked_at < datetime('now', ?))", (f"-{lead_finder.RECHECK_DAYS} days",)
        ).fetchall()
        names = {r["company"] for r in rows}
        self.assertIn("Old Co", names)
        self.assertNotIn("Fresh Co", names)

    def test_targets_override_and_default(self):
        import run_all
        self.assertEqual(run_all.load_targets({"TARGET_CATEGORY": "Plumber", "TARGET_CITY": "Ocala, FL", "TARGET_MAX": "5"}),
                         [{"category": "Plumber", "city": "Ocala, FL", "max": 5}])
        t = run_all.load_targets({})
        self.assertTrue(all("category" in x and "city" in x for x in t))
