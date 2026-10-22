# Screenshots and visual findings

Step `pipeline/visual.py` runs after the speed audit for every lead that has an email.

- Loads the homepage on a phone and a desktop (headless Chromium) and saves a first-screen screenshot of each.
- **Page findings** are measured, not guessed: phone number or call button visible on the first phone screen,
  page wider than the screen, city named in title/heading, local-business structured data, footer year,
  reviews mentioned, social links.
- **Vision findings**: Claude looks at the two screenshots and may add up to two observations in fixed categories
  (clarity, dated design, readability, trust, layout). Anything with numbers, links, wrong category or too long is dropped.
- Every finding carries a service (website, design, seo, social). The email writer builds Emails 1 and 2 around the
  single best finding and its service; Email 3 adds one soft line offering up to two other services.
- Screenshots and findings are uploaded to the dashboard. `GET /a/<token>` shows a private, noindex page with both
  screenshots, the findings and an "Other ways I can help" list. Email 1 links it. Opening it logs an `audit_viewed` touch.
  Security scanners sometimes prefetch links, so treat very early views with suspicion.
- Review page: the findings list shows the new findings and a "Private page" link so you can see what the lead will see.

Try it on any sites without touching leads: GitHub -> Actions -> **Visual preview** -> Run workflow, enter site URLs.
It prints the findings and publishes test pages (links in the log).

Cost: about 2-3 cents of Claude per lead (two images plus a short answer), no extra services.

## Email checks

`pipeline/emailcheck.py` runs before a draft is written: it rejects malformed or typo addresses (for example `.con`, scraped `u003e` junk) and domains with no MX/A record (Cloudflare DNS-over-HTTPS). A failed lookup lets the address through. The crawler skips bad candidates and takes the next one; a lead whose stored address fails has it cleared so the next lead-finder run searches again.

## Keeping the weekday run on time

GitHub's schedule is best-effort (often hours late, sometimes skipped). Two safeguards:
- The workflow cron is `17 9 * * 1-5` (off-peak minute) and a scheduled run exits early if another run already started today.
- The dashboard Worker checks every 30 minutes and, on weekdays between 5:20 and 2:00 PM Eastern, starts the workflow itself if none has started today. Needs the Worker secret `GITHUB_DISPATCH_TOKEN` (fine-grained GitHub token for this repo, permission Actions: read and write). Without it this is simply off.

## Finding enough leads

- `config/targets.json` lists 7 trades x 13 towns (HVAC, plumber, electrician, roofing, pest control, landscaping, pressure
  washing). Each weekday run works through a rotating slice of 5 targets (`TARGETS_PER_RUN`), up to 20 results each, so the whole
  list is covered in a few weeks and a run stays well under the 45-minute limit. A manual run with a category and city ignores the rotation.
- A site where no email was found is not crawled again for 60 days (`email_checked_at`, `RECHECK_DAYS` in `lead_finder.py`).
- Audits and screenshots are only done for leads that have an email address.

## Hot leads (`/hot`)

Shows prospects who opened their private screenshot page, hottest first. Two or more views, or views on different days, = Hot; one view = Warm. A "New" badge marks activity since you last opened the page (kept in the browser).

- Link scanners (security tools, previews, empty user agents) are ignored; they are still logged as `audit_viewed` touches.
- Your own views are not logged: opening the dashboard sets a one-year `ocoos_owner` cookie that applies to `/a/` pages in that browser.
- Optional text alert via the Twilio secrets (`TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`, `ALERT_PHONE`): sent on the first real view and the third. Without those secrets nothing is sent and the page is the only signal.

## Skipped leads and reject reasons (`/skipped`)

- Sites skipped by the polish rule are sent to the dashboard (`push_to_dashboard.py`, table `skipped_leads`) with their polish rating and measured findings. Sites skipped before this feature existed are sent on the next run.
- **Send anyway** marks a site; at the start of the next run `overrides.py` resets that lead (`status='audited'`, `force_send=1`), so the visual step builds its private page without the polish skip and drafting and Review follow as usual. **Dismiss** hides it; **Undo** reverses either.
- When you reject a draft on the Review page you can pick a reason (site already looks good, not a good fit, wrong contact, duplicate, other). The counts show at the top of the Skipped page. If many rejections say "site already looks good", lower `POLISH_SKIP_AT`; if you keep choosing Send anyway on skipped sites, raise it.
