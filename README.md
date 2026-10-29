# Ocoos Web Consulting outreach engine

For maintainers and AI assistants: start with `docs/PLAYBOOK.md`.

Lead finder -> website audit -> Claude-written sequence (verified findings only) -> human review -> Instantly -> webhook -> dashboard + SMS alert.

## How a run works

```
find leads (Google Places) -> audit sites (PageSpeed + HTML) -> Claude drafts 3 emails -> dashboard /review
-> you approve or edit -> "Download Instantly CSV" -> import into the Instantly campaign
```

### Automatic (GitHub Actions)

`.github/workflows/outreach.yml` runs on GitHub's servers every weekday morning, or on demand from the repo's
**Actions** tab (Run workflow; you can type a different business type and city for that run). Edit
`config/targets.json` to change the default businesses and cities.

Add these under the repo's Settings > Secrets and variables > Actions > New repository secret:
`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `DASHBOARD_URL`, `API_TOKEN`.

The run keeps its database in the dashboard's storage (`/api/state`), so nothing lives on a laptop.

### By hand (from `pipeline/`, with a `.env`)

```
python run_all.py                        # the same full run the Action does
python lead_finder.py --category "HVAC contractor" --city "Gainesville, FL"   # or one step at a time
python audit.py --limit 50
python personalize.py                    # or --template for no API call
python push_to_dashboard.py              # sends drafts to <dashboard>/review
python brand.py                          # prints the signature and CAN-SPAM footer
```

### Review and send

Open `<dashboard>/review`. Each draft shows the verified findings next to the emails. Edit any text, then Approve or
Reject. **Download Instantly CSV** exports the approved ones (with your edits) and marks them exported so they are
never imported twice. Import the CSV on the campaign's Leads tab and map `subject`, `email1`, `email2`, `email3` as
custom variables. Approving a draft also creates the lead on the dashboard so replies and bookings are tracked.

The older command-line approval still works (`python personalize.py --approve "1,3"` then `--export-instantly`).

## Deploy the dashboard (from `dashboard/`)

```
# (already done for this account: D1 database "outreach" created and schema loaded; database_id is set in wrangler.toml)
# (schema already loaded)
# (R2 bucket "outreach-media" already created)
npx wrangler secret put DASHBOARD_PASSWORD
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put API_TOKEN   # also used by the pipeline and the GitHub Action
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
