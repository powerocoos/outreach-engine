import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import personalize
import visual

GOOD = {"tel_count": 1, "tel_in_view": True, "phone_text_in_view": True, "cta_in_view": True, "overflow_x": False,
        "title": "Ocala AC repair | Acme", "h1": "Cooling Ocala", "copyright_year": 2026, "has_local_schema": True,
        "has_social_links": True, "mentions_reviews": True}


class DomFindingTests(unittest.TestCase):
    def test_healthy_page_has_no_findings(self):
        self.assertEqual(visual.dom_findings(GOOD, "Ocala, FL", 2026), [])

    def test_each_problem_is_reported_with_a_service(self):
        bad = dict(GOOD, overflow_x=True, tel_in_view=False, cta_in_view=False, title="Home", h1="Welcome",
                   copyright_year=2019, has_local_schema=False, mentions_reviews=False, has_social_links=False)
        f = visual.dom_findings(bad, "Ocala, FL", 2026)
        text = " | ".join(x["text"] for x in f)
        for needle in ("wider than the screen", "tap-to-call link is not visible", "Ocala", "structured data",
                       "2019", "reviews", "social media"):
            self.assertIn(needle, text)
        self.assertTrue(all(x["source"] == "page" and x["service"] in visual.SERVICES for x in f))

    def test_no_phone_anywhere_vs_cta_missing(self):
        none = dict(GOOD, tel_count=0, phone_text_in_view=False, cta_in_view=False, tel_in_view=False)
        self.assertIn("no phone number", visual.dom_findings(none, "Ocala, FL", 2026)[0]["text"])
        only_cta = dict(GOOD, cta_in_view=False)
        self.assertIn("call-to-action", visual.dom_findings(only_cta, "Ocala, FL", 2026)[0]["text"])

    def test_city_named_in_heading_is_enough(self):
        f = visual.dom_findings(dict(GOOD, title="Home", h1="Ocala's AC experts"), "Ocala, FL", 2026)
        self.assertEqual(f, [])

    def test_recent_copyright_not_flagged(self):
        self.assertEqual(visual.dom_findings(dict(GOOD, copyright_year=2024), "Ocala, FL", 2026), [])


class VisionValidationTests(unittest.TestCase):
    def test_keeps_valid_and_maps_service(self):
        out = visual.validate_vision([{"category": "outdated_design", "text": "The layout looks dated, with small crowded text."}])
        self.assertEqual(out, [{"text": "The layout looks dated, with small crowded text.", "service": "design", "source": "vision"}])

    def test_drops_bad_category_numbers_links_and_long_text(self):
        bad = [{"category": "other", "text": "looks bad"},
               {"category": "trust", "text": "Only 3 reviews appear."},
               {"category": "trust", "text": "See http://x.com"},
               {"category": "readability", "text": "word " * 40},
               {"category": "trust", "text": "The photo looks like a stock image."},
               {"category": "trust", "text": ""}, "junk"]
        self.assertEqual(visual.validate_vision(bad), [])

    def test_caps_at_two(self):
        o = [{"category": "trust", "text": "No trust signals appear."}] * 5
        self.assertEqual(len(visual.validate_vision(o)), 2)


class DraftWithPageTests(unittest.TestCase):
    LEAD = {"company": "Acme AC", "city": "Ocala, FL"}
    FINDINGS = [{"text": "On a phone, no phone number or call/quote button is visible on the first screen.",
                 "service": "design", "source": "page"}]
    URL = "https://dashboard.example.com/a/" + "a" * 32

    def test_template_links_page_and_passes(self):
        d = personalize.template_draft(self.LEAD, self.FINDINGS, None, self.URL)
        self.assertIn(self.URL, d["email1"])
        self.assertEqual(personalize.validate_draft(d, self.FINDINGS, None, self.URL), [])

    def test_missing_page_link_or_stray_link_rejected(self):
        d = personalize.template_draft(self.LEAD, self.FINDINGS, None, None)
        self.assertIn("email1 is missing the page link", personalize.validate_draft(d, self.FINDINGS, None, self.URL))
        d["email3"] += " See https://elsewhere.com now?"
        self.assertTrue(any("link that was not provided" in p for p in personalize.validate_draft(d, self.FINDINGS)))

    def test_screenshot_mention_without_page_rejected(self):
        d = personalize.template_draft(self.LEAD, self.FINDINGS)
        d["email2"] += " I took a screenshot?"
        self.assertTrue(any("screenshot" in p for p in personalize.validate_draft(d, self.FINDINGS)))

    def test_payload_shape_for_strings_and_dicts(self):
        p = personalize.as_payload(["Site not secure", self.FINDINGS[0]])
        self.assertEqual(p[0], {"finding": "Site not secure", "fits": "website", "source": "page"})
        self.assertEqual(p[1]["fits"], "design")


class ProbeTests(unittest.TestCase):
    def test_probe_script_runs_in_a_real_browser(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.skipTest("playwright not installed")
        html = ("<html><head><title>Acme</title></head><body><h1>Cooling</h1>"
                "<a href='tel:3525550101'>Call (352) 555-0101</a><footer>© 2018 Acme</footer></body></html>")
        with sync_playwright() as p:
            try:
                b = p.chromium.launch()
            except Exception:
                self.skipTest("chromium not available")
            page = b.new_page(viewport=visual.MOBILE)
            page.set_content(html)
            facts = page.evaluate(visual.PROBE_JS)
            b.close()
        self.assertTrue(facts["tel_in_view"])
        self.assertTrue(facts["phone_text_in_view"])
        self.assertTrue(facts["cta_in_view"])
        self.assertEqual(facts["copyright_year"], 2018)
        self.assertFalse(facts["has_local_schema"])
        self.assertFalse(facts["overflow_x"])


class RetryTests(unittest.TestCase):
    def test_failed_draft_is_retried_once_with_the_problems(self):
        import os
        import tempfile
        import common
        d = tempfile.mkdtemp()
        old_db, old_key = common.DB_PATH, os.environ.get("ANTHROPIC_API_KEY")
        common.DB_PATH = Path(d) / "t.db"
        os.environ["ANTHROPIC_API_KEY"] = "x"
        try:
            conn = common.connect()
            conn.execute("INSERT INTO leads (place_id, company, city, website, email, status) VALUES ('p','Acme','Ocala, FL','a.com','o@a.com','audited')")
            conn.execute("INSERT INTO audits (lead_id, findings_json) VALUES (1, ?)", (json.dumps(["Site is not secure."]),))
            conn.commit()
            conn.close()
            seen = []
            good = {"angle": "a", "subject": "s", "email1": "Hi?", "email2": "Hi?", "email3": "Bye. Close the file?"}

            def fake(lead, findings, api_key, video_url=None, page_url=None, problems=None):
                seen.append(problems)
                return dict(good, email3="Bye.") if problems is None else good

            orig, personalize.claude_draft = personalize.claude_draft, fake
            try:
                personalize.run(False)
            finally:
                personalize.claude_draft = orig
            self.assertIsNone(seen[0])
            self.assertTrue(seen[1] and "email3 has no question CTA" in seen[1])
            self.assertEqual(common.connect().execute("SELECT COUNT(*) FROM drafts").fetchone()[0], 1)
        finally:
            common.DB_PATH = old_db
            if old_key is None:
                os.environ.pop("ANTHROPIC_API_KEY", None)
            else:
                os.environ["ANTHROPIC_API_KEY"] = old_key


if __name__ == "__main__":
    unittest.main()
