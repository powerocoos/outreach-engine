import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("OUTREACH_DB", os.path.join(tempfile.mkdtemp(), "t.db"))  # never touch the real data dir
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

import emailcheck


class SyntaxTests(unittest.TestCase):
    def test_good_addresses_pass(self):
        for e in ("info@coolair.com", "john.smith@acme-air.co", "a+b@x.io", "owner@sub.example.org"):
            self.assertIsNone(emailcheck.syntax_problem(e), e)

    def test_bad_addresses_fail(self):
        for e in ("", "info@", "@x.com", "a@@x.com", "a..b@x.com", ".a@x.com", "a.@x.com", "info@x", "info@x.con",
                  "info@-x.com", "info@x_y.com", "u003einfo@x.com", "info@x.png", "info@x.c0m", "a b@x.com"):
            self.assertIsNotNone(emailcheck.syntax_problem(e), e)


def fake_doh(table):
    def doh(name, rtype):
        return table.get((name, rtype), [])
    return doh


class DomainTests(unittest.TestCase):
    def setUp(self):
        emailcheck._MX_CACHE.clear()

    def test_mx_present(self):
        mx = [{"type": 15, "data": "10 mail.coolair.com."}]
        with mock.patch.object(emailcheck, "_doh", fake_doh({("coolair.com", "MX"): mx})):
            self.assertEqual(emailcheck.check_email("info@coolair.com"), (True, None))

    def test_no_mx_falls_back_to_a_record(self):
        a = [{"type": 1, "data": "1.2.3.4"}]
        with mock.patch.object(emailcheck, "_doh", fake_doh({("old.com", "A"): a})):
            self.assertTrue(emailcheck.check_email("info@old.com")[0])

    def test_domain_that_cannot_receive_mail_is_rejected(self):
        with mock.patch.object(emailcheck, "_doh", fake_doh({})):
            ok, why = emailcheck.check_email("info@nowhere.com")
        self.assertFalse(ok)
        self.assertIn("cannot receive", why)

    def test_null_mx_is_rejected(self):
        with mock.patch.object(emailcheck, "_doh", fake_doh({("nomail.com", "MX"): [{"type": 15, "data": "0 ."}]})):
            self.assertFalse(emailcheck.check_email("info@nomail.com")[0])

    def test_lookup_failure_gives_benefit_of_the_doubt(self):
        with mock.patch.object(emailcheck, "_doh", lambda n, t: None):
            self.assertTrue(emailcheck.check_email("info@flaky.com")[0])

    def test_syntax_failure_skips_the_lookup(self):
        with mock.patch.object(emailcheck, "_doh", side_effect=AssertionError("no lookup expected")):
            self.assertFalse(emailcheck.check_email("info@x.con")[0])


if __name__ == "__main__":
    unittest.main()
