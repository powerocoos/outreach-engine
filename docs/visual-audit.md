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
  washing). Each weekday run works through a rotating slice of 2 targets (`TARGETS_PER_RUN`, lowered from 5 on 2026-10-23 so drafting does not outrun Instantly's daily send limit; raise it once the limit goes up). Trades are interleaved so each run covers two different trades, and the slice advances by one each weekday, so a full pass takes 46 weekdays with no repeats, up to 20 results each, so the whole
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

## Funnel by trade and town (`/funnel`)

Per trade or per town: drafted, approved, rejected %, sent, viewed page, replied, booked, bounced. Groups come from each draft's category and city; sent, replies and bounces come from the Instantly sync, page views from `audit_viewed` touches (scanners ignored). Counts are per business. Groups with fewer than 20 sent are marked "early" because their rates are noise. Drafted/approved/rejected fill in before sending starts; the rest fills in once the campaign is launched and the 30-minute sync runs.

## Run health (`/health`)

Each run reports its outcome to `POST /api/runs` (table `run_log`), best effort. The Health page also checks live: the latest GitHub "Outreach run" and "Social drafts" results, GitHub token expiry (warns at 14 days, red at 3), Instantly key, Facebook/Instagram token, and approved social posts that failed 3 times. A red or amber bar appears at the top of every dashboard page when anything is wrong (checked at most every 10 minutes). The 30-minute Worker cron also texts once per new problem if the Twilio secrets are set. A weekday with no run after 2 PM Eastern is flagged red; before then it is amber because the catch-up trigger should still start it. Runs that crash before reporting are caught by the GitHub run check and the "no run today" rule.

## Reply inbox (`/replies`)

The Worker cron (every 30 minutes) and the "Check for replies" button pull received emails for the campaign from Instantly (`GET /emails?email_type=received&campaign_id=...`). Each new reply is stored once (quoted history stripped; out-of-office and bounce notices are filed as done) and Claude drafts a suggested answer from the reply, the email we sent and the verified findings. Nothing is sent from the dashboard: copy the answer into Instantly's inbox or your mail app, then Mark done.

Needs: the Instantly API key to include the `emails:read` scope (the page and Health show a clear message if not), and the Worker secret `ANTHROPIC_API_KEY` (without it replies are listed but no suggestions are drafted). Optional Worker variable `BOOKING_LINK` is included in "interested" answers; otherwise the answer asks for a day and time. Suggested answers are short, never promise results, and use only facts from the original email and findings.

## Faster review (`/review`)

- Each draft shows a thumbnail of the phone screenshot (from its private page; click to open the page) and starts collapsed: first two findings and the subject. "Read and edit the emails" opens the full text; "Show full emails" in the toolbar opens every card.
- Sort (oldest, newest, slowest mobile score, best reviews, company, trade, town), filter by trade or town, and search by company or email. Filtering and sorting happen in the browser over the loaded list (up to 300 drafts per tab).
- Tick drafts (or "Select all shown") and use the bar at the bottom: Approve selected, Reject selected (optional reason), or Move back to pending on other tabs. `POST /api/review/bulk` applies the same checks as single approvals; any draft that fails (word limits, bounced contact) is listed and left unchanged while the rest go through. At most 100 per call.

## Dashboard layout (2026-10-23)

- Menu: Dashboard, Review, Replies, Hot leads, Funnel, Social. Red count badges on Review (drafts to review), Replies (to answer) and Hot leads (hot, not yet replied); on phones a red dot on the menu button. Skipped sites is a tab on Review (`/skipped`), Health is linked from the home page (`/health`). Below 860px the menu folds into the menu button.
- Home page ("Today"): cards for what needs you (`GET /api/summary`), a Status panel (daily run, Instantly campaign, next social post, any failing check) and the results tiles once sending starts.
- Review: tabs To review / Approved / Rejected / Sent to Instantly; each card shows trade, town and the 1-5 polish rating; Save edits appears only with the emails open; on phones sort and filter sit behind one button.
- Funnel: Rejected % is the share of reviewed drafts you rejected (drafts still waiting are not counted).


## Auto-replies are not counted as replies (2026-10-29)
Instantly marks any incoming email as a reply, so out-of-office and bounce notices inflated the reply counts. The Replies page already files them as `auto_reply`. The Today tiles, Funnel, hook table, recent activity, city table and Hot leads now skip a lead's "replied" touch when every reply on file for that lead is an auto-reply (`realReply()` in `logic.js`). A lead with no reply text on file yet still counts, so nothing real is hidden while the reply sync is catching up.
