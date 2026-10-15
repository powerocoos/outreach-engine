"""Business identity and outreach variables, all overridable from .env.

Everything the emails and exports say about *us* lives here, so nothing is hard-coded elsewhere.
"""
import os

import envload  # noqa: F401  (loads .env)


def _env(name, default=""):
    return (os.environ.get(name) or default).strip()


BRAND_NAME = _env("BRAND_NAME", "Ocoos Web Consulting")
SENDER_NAME = _env("SENDER_NAME", "Xavier")
SENDER_TITLE = _env("SENDER_TITLE", "Founder")
BRAND_WEBSITE = _env("BRAND_WEBSITE", "https://ocooswebconsulting.com")
BRAND_PHONE = _env("BRAND_PHONE")           # business callback number (e.g. your Google Voice number)
BRAND_EMAIL = _env("BRAND_EMAIL", "support@ocooswebconsulting.com")
BRAND_ADDRESS = _env("BRAND_ADDRESS")       # physical mailing address, required by CAN-SPAM
BOOKING_LINK = _env("BOOKING_LINK")         # optional calendar link, used only in the signature
OFFER = _env("OFFER", "free 15-minute website audit")
SERVICES = _env(
    "SERVICES",
    "website design, website assistance, SEO content writing, digital ad assistance, "
    "graphic design and social media assistance",
)
SERVICE_AREA = _env("SERVICE_AREA", "North Central Florida")


def signature():
    """Plain-text signature block to paste into the Instantly sequence/account signature."""
    lines = [SENDER_NAME, f"{SENDER_TITLE}, {BRAND_NAME}"]
    for v in (BRAND_PHONE, BRAND_WEBSITE, BOOKING_LINK):
        if v:
            lines.append(v)
    return "\n".join(lines)


def footer():
    """CAN-SPAM footer: physical address and opt-out line (add in Instantly)."""
    lines = [BRAND_NAME]
    if BRAND_ADDRESS:
        lines.append(BRAND_ADDRESS)
    lines.append("Not interested? Reply \"stop\" and I won't email you again.")
    return "\n".join(lines)


def missing_for_sending():
    """Variables that must be set before real emails go out."""
    need = {"BRAND_ADDRESS": BRAND_ADDRESS, "BRAND_PHONE": BRAND_PHONE}
    return [k for k, v in need.items() if not v]


if __name__ == "__main__":
    print(signature())
    print()
    print(footer())
    gaps = missing_for_sending()
    if gaps:
        print("\nSet before sending:", ", ".join(gaps))
