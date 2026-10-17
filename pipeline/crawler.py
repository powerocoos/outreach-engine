"""Find a contact email on a business website (homepage + common contact pages).

Polite by design: honors robots.txt, fetches at most a handful of pages per site.
"""
import re
import urllib.robotparser
from urllib.parse import urljoin, urlparse

from common import USER_AGENT, http_request
from emailcheck import check_email

CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
MAILTO_RE = re.compile(r'mailto:([^"\'?>\s]+)', re.I)
JUNK_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js")
JUNK_DOMAINS = ("sentry.io", "wixpress.com", "example.com", "domain.com", "godaddy.com")
GENERIC_LOCALS = ("noreply", "no-reply", "donotreply", "privacy", "abuse", "webmaster")
PREFERRED_LOCALS = ("owner", "info", "contact", "office", "service", "hello", "sales")


def extract_emails(html):
    found = set()
    for m in MAILTO_RE.findall(html):
        found.add(m.strip().lower())
    for m in EMAIL_RE.findall(html):
        found.add(m.strip().lower())
    clean = []
    for e in found:
        local, _, domain = e.partition("@")
        if e.endswith(JUNK_SUFFIXES) or any(domain.endswith(d) for d in JUNK_DOMAINS):
            continue
        if any(local.startswith(g) for g in GENERIC_LOCALS):
            continue
        clean.append(e)
    return clean


def rank_emails(emails, site_domain):
    """Prefer an address on the company's own domain; then personal-looking over generic."""
    def score(e):
        local, _, domain = e.partition("@")
        s = 0
        if site_domain and domain.endswith(site_domain):
            s += 10
        if local in PREFERRED_LOCALS:
            s += 2
        elif "." in local or len(local) > 3:
            s += 3  # looks like a person (e.g. john.smith, jsmith)
        return -s
    return sorted(emails, key=score)


def allowed_by_robots(base):
    rp = urllib.robotparser.RobotFileParser()
    status, _, _, body = http_request(urljoin(base, "/robots.txt"), timeout=10, retries=0)
    if status != 200:
        return True
    rp.parse(body.decode("utf-8", "ignore").splitlines())
    return rp.can_fetch(USER_AGENT, base)


def find_email(website):
    """Return (email, source_url) or (None, None)."""
    if not website:
        return None, None
    if not website.startswith("http"):
        website = "https://" + website
    parsed = urlparse(website)
    base = f"{parsed.scheme}://{parsed.netloc}"
    domain = parsed.netloc.lower().removeprefix("www.")
    if not allowed_by_robots(base):
        return None, None
    for path in CONTACT_PATHS:
        url = urljoin(base, path) if path else website
        status, _, _, body = http_request(url, timeout=15, retries=1)
        if status != 200:
            continue
        ranked = rank_emails(extract_emails(body.decode("utf-8", "ignore")), domain)
        for candidate in ranked:  # first address Instantly would accept
            ok, why = check_email(candidate)
            if ok:
                return candidate, url
            print(f"    skip {candidate}: {why}")
    return None, None
