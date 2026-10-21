"""Stage 1: find local businesses with Google Places (New), then crawl each site for an email.

Usage:
    python lead_finder.py --category "HVAC contractor" --city "Gainesville, FL" --max 60
    python lead_finder.py --category "HVAC contractor" --city "Ocala, FL"

Requires GOOGLE_PLACES_API_KEY. Results go to SQLite (data/outreach.db).
"""
import argparse

from common import connect, http_request, require_env
from crawler import find_email

RECHECK_DAYS = 60   # a site with no email is searched again only after this many days
PLACES_URL = "https://places.googleapis.com/v1/places:searchText"
FIELD_MASK = ",".join([
    "places.id", "places.displayName", "places.formattedAddress",
    "places.nationalPhoneNumber", "places.websiteUri", "places.rating",
    "places.userRatingCount", "nextPageToken",
])


def search_places(query, api_key, max_results=60):
    results, token = [], None
    while len(results) < max_results:
        body = {"textQuery": query, "pageSize": 20}
        if token:
            body["pageToken"] = token
        status, _, _, raw = http_request(
            PLACES_URL, method="POST", body=body,
            headers={"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": FIELD_MASK},
        )
        if status != 200:
            raise SystemExit(f"Places API error {status}: {raw[:300].decode('utf-8', 'ignore')}")
        import json
        data = json.loads(raw)
        results.extend(data.get("places", []))
        token = data.get("nextPageToken")
        if not token:
            break
    return results[:max_results]


def parse_place(p, category, city):
    return {
        "place_id": p.get("id"),
        "company": (p.get("displayName") or {}).get("text", "").strip(),
        "category": category,
        "city": city.split(",")[0].strip(),
        "address": p.get("formattedAddress"),
        "phone": p.get("nationalPhoneNumber"),
        "website": p.get("websiteUri"),
        "rating": p.get("rating"),
        "review_count": p.get("userRatingCount"),
    }


def save_lead(conn, lead):
    cur = conn.execute(
        """INSERT OR IGNORE INTO leads
           (place_id, company, category, city, address, phone, website, rating, review_count)
           VALUES (:place_id,:company,:category,:city,:address,:phone,:website,:rating,:review_count)""",
        lead,
    )
    return cur.rowcount == 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", required=True)
    ap.add_argument("--city", required=True)
    ap.add_argument("--max", type=int, default=60)
    ap.add_argument("--skip-emails", action="store_true", help="skip the contact-page crawl")
    args = ap.parse_args()

    api_key = require_env("GOOGLE_PLACES_API_KEY")
    conn = connect()
    places = search_places(f"{args.category} in {args.city}", api_key, args.max)
    new = 0
    for p in places:
        lead = parse_place(p, args.category, args.city)
        if not lead["company"] or not lead["website"]:
            continue  # no website means nothing to audit
        if save_lead(conn, lead):
            new += 1
    conn.commit()
    print(f"Found {len(places)} places, saved {new} new leads with websites.")

    if not args.skip_emails:
        rows = conn.execute(
            "SELECT id, company, website FROM leads WHERE email IS NULL AND website IS NOT NULL "
            "AND (email_checked_at IS NULL OR email_checked_at < datetime('now', ?))", (f"-{RECHECK_DAYS} days",)
        ).fetchall()
        print(f"Looking for an email on {len(rows)} sites (sites checked in the last {RECHECK_DAYS} days are skipped).")
        for r in rows:
            email, source = find_email(r["website"])
            conn.execute("UPDATE leads SET email=?, email_source=?, email_checked_at=CURRENT_TIMESTAMP WHERE id=?",
                         (email, source, r["id"]))
            conn.commit()
            print(f"  {r['company']}: {email or 'no email found'}")


if __name__ == "__main__":
    main()
