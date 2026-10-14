# Red Panda Digital outreach engine

Lead finder -> website audit -> Claude-written sequence (verified findings only) -> human review -> Instantly -> webhook -> dashboard + SMS alert.

## Run the pipeline (from `pipeline/`)

```
export $(grep -v '^#' ../.env | xargs)
python lead_finder.py --category "HVAC contractor" --city "Gainesville, FL"
python lead_finder.py --category "HVAC contractor" --city "Ocala, FL"
python audit.py --limit 50
python capture.py --limit 20            # phone-sized screen recording per lead (needs playwright + chromium; ffmpeg optional)
python upload_media.py                  # hosts each clip on the dashboard, saves its private link
python personalize.py --template        # or without --template to use Claude; Email 1 links the clip only if one exists
python personalize.py --export review.csv
```

Review `review.csv`. Approve by setting `approved=1` in `data/outreach.db` (`UPDATE drafts SET approved=1 WHERE lead_id IN (...)`), then:

```
python push_to_dashboard.py
```

Load the approved leads and their email1/2/3 into an Instantly campaign (3 steps, days 1/4/8, stop on reply).

## Deploy the dashboard (from `dashboard/`)

```
# (already done for this account: D1 database "outreach" created and schema loaded; database_id is set in wrangler.toml)
# (schema already loaded)
# (R2 bucket "outreach-media" already created)
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put API_TOKEN
npx wrangler secret put TWILIO_SID   # plus TWILIO_TOKEN, TWILIO_FROM, ALERT_PHONE
npx wrangler deploy
```

In Instantly, add a webhook to `https://<worker>/webhook/instantly` with header `x-webhook-secret: <WEBHOOK_SECRET>` for sent, opened, reply, bounce, unsubscribe and meeting-booked events. Confirm the exact event names in Instantly and adjust `EVENT_MAP` in `src/logic.js` if they differ.

## Tests

```
python3 -I -m unittest discover -s tests
cd dashboard && node --no-warnings --test test/logic.test.js test/worker.test.js
```

## Screen recordings

`capture.py` records the site in a 390x844 mobile viewport: the first screen, then a slow scroll of up to five screens (about 12 seconds). Each screen gets a banner caption taken from the verified findings (for example "No tap-to-call button on the homepage" or "Google mobile speed score: 31/100"), at most three per clip, so the video cannot show a claim the audit did not verify. `upload_media.py` stores it in R2 and the Worker serves it at `/v/<32-hex-token>` (unguessable, noindex) and logs a `video_viewed` event, shown as "Video views" on the dashboard. Treat early views with suspicion: some email security scanners open links automatically.

## Guardrails

- Email 1 only mentions a video when a hosted clip exists; the validator rejects drafts that claim one otherwise.

- A lead with no verified finding gets no email.
- Send from separate lookalike domains, cap daily volume per inbox, and read the first 50 messages by hand.
- Every email needs a physical address and a working opt-out (added in Instantly, not in the drafts).
- SMS is only the alert to your own phone, never outbound prospecting.
- The crawler honors robots.txt and only reads a few pages per site.
