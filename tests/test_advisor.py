import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ["OUTREACH_DB"] = os.path.join(tempfile.mkdtemp(), "advisor.db")  # before importing common

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import compare_advisor
import personalize
from common import connect

LEAD = {"company": "Cool Air", "category": "HVAC contractor", "city": "Gainesville",
        "rating": 4.8, "review_count": 120}
FINDINGS = ["The homepage has no tap-to-call phone link for people searching on a phone."]
GOOD = {"angle": "no tap-to-call", "subject": "A quick note on Cool Air's site",
        "email1": "Hi there, I'm Xavier with Ocoos Web Consulting. Worth a quick look?",
        "email2": "One fix is a tap-to-call button. Want the steps?",
        "email3": "I'll stop here. Should I close the file?"}


def api_response(blocks, status=200):
    return (status, "https://api.anthropic.com/v1/messages", {}, json.dumps({"content": blocks}).encode())


def text(s):
    return {"type": "text", "text": s}


ADVISOR_CALL = {"type": "server_tool_use", "id": "srvtoolu_1", "name": "advisor", "input": {}}
ADVISOR_RESULT = {"type": "advisor_tool_result", "tool_use_id": "srvtoolu_1", "content": {"type": "advisor_result", "text": "Lead with tap-to-call."}}


class RequestShapeTests(unittest.TestCase):
    def call(self, advisor=None, on=False):
        with mock.patch.object(personalize, "ADVISOR_ON", on), \
             mock.patch.object(personalize, "http_request", return_value=api_response([text(json.dumps(GOOD))])) as m:
            personalize.claude_draft(LEAD, FINDINGS, "key", advisor=advisor)
        return m.call_args

    def test_off_by_default_request_is_unchanged(self):
        args = self.call()
        body, kw = args.kwargs["body"], args.kwargs
        self.assertNotIn("tools", body)
        self.assertNotIn("anthropic-beta", kw["headers"])
        self.assertEqual(body["system"], personalize.SYSTEM_PROMPT)
        self.assertEqual(body["max_tokens"], 4000)
        self.assertEqual(kw["timeout"], 60)

    def test_env_flag_turns_it_on(self):
        args = self.call(on=True)
        self.assertEqual(args.kwargs["headers"]["anthropic-beta"], personalize.ADVISOR_BETA)
        tool = args.kwargs["body"]["tools"][0]
        self.assertEqual(tool, {"type": "advisor_20260301", "name": "advisor", "model": personalize.ADVISOR_MODEL})

    def test_explicit_argument_overrides_env_flag(self):
        self.assertIn("tools", self.call(advisor=True, on=False).kwargs["body"])
        self.assertNotIn("tools", self.call(advisor=False, on=True).kwargs["body"])

    def test_advisor_prompt_keeps_every_hard_rule(self):
        body = self.call(advisor=True).kwargs["body"]
        self.assertTrue(body["system"].startswith(personalize.SYSTEM_PROMPT))
        self.assertIn("advisor", body["system"][len(personalize.SYSTEM_PROMPT):])


class ParsingTests(unittest.TestCase):
    def test_plain_text_is_unchanged(self):
        self.assertEqual(personalize.final_text([text("a"), text("b")]), "ab")

    def test_text_before_advisor_is_ignored(self):
        blocks = [text("Let me check {something} first."), ADVISOR_CALL, ADVISOR_RESULT, text(json.dumps(GOOD))]
        self.assertEqual(json.loads(personalize.final_text(blocks)), GOOD)

    def test_falls_back_when_nothing_follows_the_advisor(self):
        blocks = [text(json.dumps(GOOD)), ADVISOR_CALL, ADVISOR_RESULT]
        self.assertEqual(json.loads(personalize.final_text(blocks)), GOOD)

    def test_draft_and_consults_are_counted(self):
        blocks = [text("checking"), ADVISOR_CALL, ADVISOR_RESULT, text(json.dumps(GOOD))]
        before = dict(personalize.ADVISOR_STATS)
        with mock.patch.object(personalize, "http_request", return_value=api_response(blocks)):
            d = personalize.claude_draft(LEAD, FINDINGS, "key", advisor=True)
        self.assertEqual(d, GOOD)
        self.assertEqual(personalize.ADVISOR_STATS["consults"], before["consults"] + 1)
        self.assertEqual(personalize.ADVISOR_STATS["drafts"], before["drafts"] + 1)

    def test_baseline_is_never_counted(self):
        before = dict(personalize.ADVISOR_STATS)
        with mock.patch.object(personalize, "http_request", return_value=api_response([text(json.dumps(GOOD))])):
            personalize.claude_draft(LEAD, FINDINGS, "key", advisor=False)
        self.assertEqual(personalize.ADVISOR_STATS, before)

    def test_api_error_still_raises(self):
        with mock.patch.object(personalize, "http_request", return_value=api_response([], status=400)):
            with self.assertRaises(RuntimeError):
                personalize.claude_draft(LEAD, FINDINGS, "key", advisor=True)


class CompareTests(unittest.TestCase):
    ITEM = {"lead": LEAD, "findings": FINDINGS, "video_url": None, "page_url": None}

    def test_draft_both_validates_each_side_and_survives_errors(self):
        def fake(lead, findings, key, video_url, page_url, problems, advisor):
            if advisor:
                raise RuntimeError("Anthropic API 500")
            return GOOD
        r = compare_advisor.draft_both(self.ITEM, "key", draft_fn=fake)
        self.assertEqual(r["baseline"]["problems"], [])
        self.assertIsNone(r["baseline"]["error"])
        self.assertEqual(r["advisor"]["error"], "Anthropic API 500")

    def test_failing_draft_is_reported_not_hidden(self):
        bad = dict(GOOD, email2="No question here.")
        r = compare_advisor.draft_both(self.ITEM, "key", draft_fn=lambda *a, **k: bad)
        self.assertTrue(any("no question CTA" in p for p in r["baseline"]["problems"]))

    def test_report_has_both_sides(self):
        r = compare_advisor.draft_both(self.ITEM, "key", draft_fn=lambda *a, **k: GOOD)
        md = compare_advisor.render([(self.ITEM, r)], ("exec-model", "advisor-model"))
        for s in ("# Advisor comparison", "Cool Air", "### Baseline", "### With advisor", "1/1", "exec-model"):
            self.assertIn(s, md)

    def test_load_leads_is_read_only_and_skips_leads_without_findings(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.db")
            conn = connect(path)
            for i, f in ((1, FINDINGS), (2, [])):
                conn.execute("INSERT INTO leads (place_id, company, city, email, website, status) "
                             "VALUES (?,?,?,?,?, 'audited')", (f"p{i}", f"Co {i}", "Ocala", f"a{i}@x.com", "https://x.com"))
                conn.execute("INSERT INTO audits (lead_id, reachable, findings_json) VALUES (?,1,?)", (i, json.dumps(f)))
            conn.commit()
            conn.close()
            before = Path(path).read_bytes()
            items = compare_advisor.load_leads(path, limit=5)
            self.assertEqual([i["lead"]["company"] for i in items], ["Co 1"])
            self.assertEqual(Path(path).read_bytes(), before)  # nothing written


def tearDownModule():
    personalize.ADVISOR_STATS.update(drafts=0, consults=0)  # keep these counts out of other tests' output


if __name__ == "__main__":
    unittest.main()
