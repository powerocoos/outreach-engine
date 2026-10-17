"""Catch addresses Instantly will refuse BEFORE a draft reaches the Review page.

Two layers:
1. Syntax and obvious scraping/typo problems (no network).
2. The domain must be able to receive mail (MX, or an A record as the fallback mail rule),
   looked up over Cloudflare DNS-over-HTTPS. If the lookup itself fails (network trouble) we
   give the address the benefit of the doubt, so a flaky lookup never blocks good leads.
"""
import json
import re
from urllib.parse import quote

from common import http_request

LOCAL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._%+\-]*[a-z0-9])?$")
LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?$")
# Typos / scraping artifacts seen on real sites ("info@acme.con", "name@site.comContact")
BAD_TLDS = {"con", "comm", "cmo", "vom", "ocm", "cim", "coom", "nett", "orgg", "gmal", "png", "jpg", "jpeg",
            "gif", "webp", "svg", "css", "js", "html", "php", "pdf", "local", "invalid", "test", "example"}
# Page text glued to an address ("u003einfo@x.com", "email:info@x.com") is not part of the local part.
ESCAPE_PREFIXES = ("u003e", "u003c", "u0026", "x3e")
_MX_CACHE = {}


def syntax_problem(email):
    """Return a short reason string, or None if the address looks sane."""
    if not email or email.count("@") != 1:
        return "not a single address"
    email = email.strip().lower()
    local, domain = email.split("@")
    if len(email) > 254 or len(local) > 64:
        return "too long"
    if any(local.startswith(p) for p in ESCAPE_PREFIXES):
        return "scraped escape junk in the name"
    if ".." in local or not LOCAL_RE.match(local):
        return "invalid characters in the name"
    labels = domain.split(".")
    if len(labels) < 2 or any(not LABEL_RE.match(l) for l in labels):
        return "invalid domain"
    tld = labels[-1]
    if len(tld) < 2 or not tld.isalpha() or tld in BAD_TLDS:
        return f"suspicious ending .{tld}"
    return None


def _doh(name, rtype):
    """Return answer list, or None when the lookup itself failed."""
    url = f"https://cloudflare-dns.com/dns-query?name={quote(name)}&type={rtype}"
    status, _, _, body = http_request(url, headers={"Accept": "application/dns-json"}, timeout=10, retries=1)
    if status != 200:
        return None
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if data.get("Status") == 3:  # NXDOMAIN
        return []
    if data.get("Status") != 0:
        return None
    return data.get("Answer") or []


def domain_receives_mail(domain):
    """True/False, or None if we could not tell."""
    if domain in _MX_CACHE:
        return _MX_CACHE[domain]
    result = None
    mx = _doh(domain, "MX")
    if mx is None:
        result = None
    else:
        hosts = [a.get("data", "").split()[-1].rstrip(".") for a in mx if a.get("type") == 15]
        if any(h for h in hosts):
            result = True  # at least one real mail host
        elif any(a.get("type") == 15 for a in mx):
            result = False  # null MX ("."): the domain says it takes no mail
        else:
            a = _doh(domain, "A")
            result = None if a is None else any(r.get("type") == 1 for r in a)
    _MX_CACHE[domain] = result
    return result


def check_email(email, lookup=True):
    """Return (ok, reason). reason is None when ok."""
    email = (email or "").strip().lower()
    problem = syntax_problem(email)
    if problem:
        return False, problem
    if lookup and domain_receives_mail(email.split("@")[1]) is False:
        return False, "domain cannot receive email"
    return True, None
