import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

import social

FEED = (ROOT / "tests" / "fixtures" / "blog_feed.xml").read_text(encoding="utf-8")
NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)

GOOD = {
    "facebook": ("A small business can spend $15 a day on Google Ads and get a steady flow of calls, or almost nothing. "
                 "The difference is rarely the budget. Our new guide covers choosing the right searches, using negative "
                 "keywords to stop wasted clicks, and tracking conversions so you know what is working. Read the full post."),
    "instagram": ("Same $15 a day, very different results.\n\nThe difference is rarely the budget. It is targeting, messaging, "
                  "and tracking. Our new guide shows local business owners how to stop wasted clicks and measure what "
                  "actually produces leads.\n\nLink in bio.\n\n#GoogleAds #OcalaFlorida #NorthCentralFlorida #SmallBusiness #WebDesign"),
}


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.posts = social.parse_feed(FEED)
        self.ads = self.posts[0]

    def test_parses_posts(self):
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(self.ads["title"], "Google Ads for Local Businesses: Get Leads Without Waste")
        self.assertEqual(self.ads["categories"], ["Google Ads", "Digital Marketing"])
        self.assertEqual(self.ads["pub_date"], datetime(2026, 10, 12, 13, 35, 56, tzinfo=timezone.utc))
        self.assertIn("Use Negative Keywords to Stop Wasted Clicks", self.ads["headings"])
        self.assertTrue(self.ads["image"].endswith(".jpg?format=1500w"))
        self.assertNotIn("<", self.ads["text"])
        self.assertNotIn("<", self.ads["summary"])
        self.assertIsNone(self.posts[1]["image"])

    def test_utm_link(self):
        link = social.tag_link("https://www.ocooswebconsulting.com/updates/x?a=1")
        self.assertIn("a=1", link)
        self.assertIn("utm_source=facebook", link)
        self.assertIn("utm_medium=social", link)

    def test_only_fresh_unknown_posts(self):
        self.assertEqual([p["title"][:6] for p in social.fresh(self.posts, set(), now=NOW)], ["Google"])
        self.assertEqual(social.fresh(self.posts, {self.ads["link"]}, now=NOW), [])
        self.assertEqual(len(social.fresh(self.posts, set(), now=NOW, max_age_days=5000)), 2)


class ValidateTests(unittest.TestCase):
    def setUp(self):
        self.post = social.parse_feed(FEED)[0]

    def test_good_draft_passes(self):
        self.assertEqual(social.validate(GOOD, self.post), [])

    def test_catches_problems(self):
        def check(**change):
            return social.validate({**GOOD, **change}, self.post)
        self.assertTrue(any("URL" in p for p in check(facebook=GOOD["facebook"] + " https://x.com")))
        self.assertTrue(any("hashtags" in p for p in check(facebook=GOOD["facebook"] + " #ads")))
        self.assertTrue(any("not in the blog post" in p for p in check(facebook=GOOD["facebook"] + " Clients save 40% on average.")))
        self.assertTrue(any("Link in bio" in p for p in check(instagram=GOOD["instagram"].replace("Link in bio.", ""))))
        self.assertTrue(any("phone" in p for p in check(facebook=GOOD["facebook"] + " Call (352) 555-1234.")))
        self.assertTrue(any("words" in p for p in check(facebook="Too short.")))
        self.assertTrue(any("hashtags" in p for p in check(instagram=GOOD["instagram"].split("#")[0] + "#one")))
        self.assertEqual(social.validate({"facebook": "", "instagram": ""}, self.post), ["missing facebook or instagram text"])


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.post = social.parse_feed(FEED)[0]

    def test_template_is_valid_and_honest(self):
        d = social.template_draft(self.post)
        self.assertEqual(social.validate(d, self.post), [])
        self.assertIn(self.post["title"], d["facebook"])

    def test_uses_claude_when_valid(self):
        d, how = social.make_draft(self.post, "key", drafter=lambda p, k: GOOD)
        self.assertEqual((d, how), (GOOD, "claude"))

    def test_retries_then_falls_back(self):
        calls = []
        def bad(p, k):
            calls.append(1)
            return {**GOOD, "facebook": GOOD["facebook"] + " Save 99% now."}
        d, how = social.make_draft(self.post, "key", drafter=bad)
        self.assertEqual((how, len(calls)), ("template", 2))
        def boom(p, k):
            raise RuntimeError("api down")
        self.assertEqual(social.make_draft(self.post, "key", drafter=boom)[1], "template")
        self.assertEqual(social.make_draft(self.post, None)[1], "template")

    def test_payload(self):
        d = social.to_payload(self.post, GOOD)
        self.assertEqual(d["post_url"], self.post["link"])
        self.assertIn("utm_campaign=blog-share", d["link"])
        self.assertEqual(d["categories"], ["Google Ads", "Digital Marketing"])
        json.dumps(d)  # must be JSON serialisable (pub_date is a string)


class DryRunTests(unittest.TestCase):
    def test_dry_run_from_saved_feed(self):
        buf = io.StringIO()
        old = social.MAX_AGE_DAYS
        social.MAX_AGE_DAYS = 100000  # fixture dates are in the past relative to today
        try:
            import os
            os.environ.pop("ANTHROPIC_API_KEY", None)
            with redirect_stdout(buf):
                social.main(["--dry-run", "--feed-file", str(ROOT / "tests" / "fixtures" / "blog_feed.xml")])
        finally:
            social.MAX_AGE_DAYS = old
        self.assertIn("Drafted", buf.getvalue())



class ImageTests(unittest.TestCase):
    def test_ig_image_ok(self):
        self.assertTrue(social.ig_image_ok("https://x.com/a.jpg?format=1500w"))
        self.assertTrue(social.ig_image_ok("https://x.com/a.JPEG"))
        self.assertFalse(social.ig_image_ok("https://x.com/a.png"))
        self.assertFalse(social.ig_image_ok("http://x.com/a.jpg"))
        self.assertFalse(social.ig_image_ok(None))

    def test_keeps_usable_jpeg_without_upload(self):
        calls = []
        post = {"title": "T", "link": "https://s/p", "image": "https://x.com/a.jpg"}
        out = social.ensure_image(post, "https://d", "tok", uploader=lambda *a, **k: calls.append(a))
        self.assertEqual(out, "https://x.com/a.jpg")
        self.assertEqual(calls, [])

    def test_png_gets_branded_card(self):
        sent = {}
        def up(url, **kw):
            sent.update(url=url, **kw)
            return 200, {}, {}, b"{}"
        social.fetch_logo = lambda: None
        post = {"title": "Google Ads for Local Businesses: Get Leads Without Waste", "link": "https://s/p", "image": "https://x.com/a.png"}
        out = social.ensure_image(post, "https://d", "tok", uploader=up)
        self.assertRegex(out, r"^https://d/img/social/[0-9a-f]{32}\.jpg$")
        self.assertTrue(sent["body"].startswith(b"\xff\xd8\xff"))
        self.assertEqual(sent["headers"]["Content-Type"], "image/jpeg")
        self.assertTrue(sent["url"].startswith("https://d/api/social-image/"))

    def test_upload_failure_keeps_original(self):
        social.fetch_logo = lambda: None
        post = {"title": "T", "link": "https://s/p", "image": "https://x.com/a.png"}
        out = social.ensure_image(post, "https://d", "tok", uploader=lambda *a, **k: (500, {}, {}, b""))
        self.assertEqual(out, "https://x.com/a.png")

    def test_card_token_stable(self):
        import social_image
        self.assertEqual(social_image.card_token("u"), social_image.card_token("u"))
        self.assertNotEqual(social_image.card_token("u"), social_image.card_token("v"))



class CardVariantTests(unittest.TestCase):
    def test_variant_is_stable_and_in_range(self):
        import social_image
        v = social_image.variant_for("Website Tip: Add a call button")
        self.assertEqual(v, social_image.variant_for("Website Tip: Add a call button"))
        self.assertIn(v, range(len(social_image.PALETTES)))

    def test_every_variant_renders_a_jpeg(self):
        import social_image
        for i in range(len(social_image.PALETTES)):
            data = social_image.render_card("Why speed matters", None, "WEBSITE TIP", variant=i)
            self.assertEqual(data[:2], b"\xff\xd8")


if __name__ == "__main__":
    unittest.main()
