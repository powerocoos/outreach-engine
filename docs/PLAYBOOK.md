# Ocoos systems playbook

Written so that any AI assistant (Claude, DeepSeek, or another) or a human developer can keep these systems running from this file alone. Read sections 1 to 4 before touching anything. Everything else is look-up material.

This repo is public. Never commit secrets, API keys, passwords, tokens, or customer contact details.

## 1. What exists

| Part | What it does | Where it runs | Source |
|---|---|---|---|
| Outreach pipeline | Finds local businesses, audits their sites, drafts a 3-email sequence from verified findings only | GitHub Actions (`.github/workflows/outreach.yml`) | `pipeline/`, `config/targets.json` |
| Dashboard | Review and approve drafts, replies, hot leads, funnel, social posts, health, chat leads | Cloudflare Worker `outreach-dashboard`, custom domain `dashboard.ocooswebconsulting.com`, D1 database `outreach`, R2 bucket `outreach-media` | `dashboard/` |
| Social autopost | Turns blog posts into Facebook and Instagram drafts, publishes approved ones | GitHub Action `social.yml` plus the Worker | `pipeline/social*.py`, `dashboard/src/social.js`, `docs/social-posts.md` |
| Website chatbot | AI chat bubble for sales questions on a website; saves leads | Cloudflare Worker `website-chatbot`, custom domain `chat.ocooswebconsulting.com`, D1 database `website-chatbot` | a separate folder, not in this repo (see section 9) |

How they connect:

```
GitHub Action run_all.py -> POST /api/drafts etc. -> dashboard (D1) -> human reviews at /review
   -> "Send to Instantly" (API) -> Instantly sends emails -> Worker cron (every 30 min) syncs replies and stats back
Chatbot Worker -> saves leads in its own D1 -> dashboard reads that D1 through the CHAT_DB binding (Chat leads page)
```

## 2. Golden rules (never break these)

1. **Never launch or resume the Instantly campaign, and never send email, unless the human says so in chat.** The Launch button needs the human to type LAUNCH. The campaign stays Draft until they launch it.
2. **Never print, paste, log or commit a secret.** The human enters secret values themselves (`wrangler secret put`, GitHub repo secrets). If you need one, ask the human to set it and tell you the NAME only.
3. **Never push to `main`.** Main auto-deploys the production dashboard. Work on a branch, open a pull request, run the tests, and let the human merge (or tell you to merge).
4. **Never select contact emails** when querying production data for diagnosis. Use counts and ids.
5. **Do not invent facts in drafts, bot answers or website copy.** Outreach emails use verified findings only. The chatbot answers only from its brief.
6. **Confirm before anything irreversible or public:** deleting data, publishing posts, sending messages, changing DNS, changing prices on the site.
7. If something is blocked by your environment (for example no network access to Cloudflare), say so plainly and give the human the exact command to run. Do not try workarounds that bypass the block.

## 3. How to make a change safely

1. `git checkout -b <short-name>` from an up-to-date `main`.
2. Make the change. Keep it small. Add or update a test.
3. Run the tests (section 4). All must pass.
4. Commit, push the branch, open a pull request that says what changed and how it was tested.
5. Wait for the human to say "merge". Merging to `main` deploys the dashboard automatically (Cloudflare Workers Builds). Check the build result on the merge commit afterward.
6. The Worker adds its own database columns on first use (`ensureSchema` and per-module migrations). Never write a destructive migration.

If your tooling cannot use the GitHub GraphQL API, use the REST API instead: `gh api -X PUT repos/powerocoos/outreach-engine/pulls/<n>/merge -f merge_method=squash`.

## 4. Running the tests

```
cd dashboard && npm install && npm test        # 75 tests (node:test, D1 shim, mocked fetch)
python3 -I -m unittest discover -s tests       # 89 tests
```

- No test needs a real API key or network access.
- Python test modules must set `OUTREACH_DB` to a temp path before importing pipeline modules, or they write into `data/outreach.db`.
- Chatbot kit: `npm test` in its folder (14 tests).

## 5. The dashboard (Cloudflare Worker)

Entry point `dashboard/src/index.js` routes every request. Each feature is its own module.

| Page | Module | API |
|---|---|---|
| `/` or `/dashboard` home | `index.js` | `GET /api/summary` (drives menu badges and the "Today" cards) |
| `/review` | `review_page.js`, `index.js` | `GET /api/review`, `POST /api/review/bulk`, `POST /api/send/instantly` |
| `/replies` | `replies.js` | `GET /api/replies`, `POST /api/replies/sync` |
| `/hot` | `hot.js` | `GET /api/hot` |
| `/funnel` | `funnel.js` | `GET /api/funnel` |
| `/skipped` | `skipped.js` | `GET /api/skipped` |
| `/social` | `social.js` | `GET /api/social` |
| `/health` | `health.js` | `GET /api/health` |
| `/chat-leads` | `chatleads.js` | `GET /api/chat-leads?status=new\|done`, `POST /api/chat-leads/:id` |
| `/a/<token>` (private audit pages) | `audit_page.js` | public, unguessable token |

Conventions to follow:

- **Auth:** every page and API requires HTTP Basic auth (password in secret `DASHBOARD_PASSWORD`). Machine endpoints (`/api/drafts`, `/api/state`, `/api/runs`, ...) use a bearer token (`API_TOKEN`).
- **State-changing browser calls** send the header `x-requested-with: review` (CSRF guard). New POST handlers must check it.
- **Pages are JavaScript template literals.** Do not use backticks or `${` inside the client-side script. Write `\\n` and `\\u00b7` in the source so the browser receives an escape, not a raw newline (a raw newline inside a JS string breaks the whole script).
- **Schema:** `dashboard/schema.sql` for fresh installs, plus `ensureSchema` and each module's `*_MIGRATIONS` (an `ALTER TABLE` wrapped in try/catch) for existing databases.
- **Menu badge:** add a count to `summary()` in `index.js`, then to the badge list in `review_page.js`.
- **Styling:** Poppins, navy `#155387`, CTA blue `#0066cc`, dark mode supported, no horizontal scroll down to 390 px wide.

Recipe: add a new page.
1. New module `dashboard/src/<name>.js` exporting the page HTML string and handlers.
2. Import it in `index.js`, add the routes after the Basic-auth check, add the home card and nav link.
3. Add `dashboard/test/<name>.test.js` and list it in `dashboard/package.json` (the test script names files explicitly).
4. Syntax-check the page script: extract each `<script>` body and run `new Function(body)` in a test (see `chatleads.test.js`).
5. Branch, PR, human merges.

Cloudflare bindings (`dashboard/wrangler.toml`): D1 `DB` (outreach), D1 `CHAT_DB` (the chatbot's database), R2 `MEDIA`, cron every 30 minutes (Instantly sync, social publishing, GitHub catch-up trigger, health alerts, reply sync).

## 6. The outreach pipeline

`pipeline/run_all.py` runs, in order: pull state from the Worker, `lead_finder.py` (Google Places plus a contact-page email crawl), `overrides.py`, `audit.py` (PageSpeed), `visual.py` (screenshots, measured findings, AI vision, polish rating 1 to 5, private page), `personalize.py` (3-email drafts), `push_to_dashboard.py`, then push state back and report the run to `POST /api/runs`.

- Targets: `config/targets.json` (7 trades by 13 towns). `TARGETS_PER_RUN` targets per weekday (default 2). Keep volume under the sending limit of the Instantly account (about 3 sends per lead).
- Polish rule: sites rated `POLISH_SKIP_AT` (default 4) or higher are not emailed unless a hard defect is measured. They appear on `/skipped`.
- Draft rules are in `pipeline/personalize.py` (`SYSTEM_PROMPT` and `validate_draft`): under 125 words, ends with a question, verified findings only, one service pitched per email.
- Scheduling: GitHub's scheduled runs arrive hours late. The Worker catch-up (`dashboard/src/kick.js`) starts the run around 09:30 UTC on weekdays using the secret `GITHUB_DISPATCH_TOKEN` (expires; the Health page warns 14 days ahead).
- Detailed notes per feature: `docs/visual-audit.md`, `docs/social-posts.md`, `docs/chat-leads.md`.

## 7. Secrets and who sets them

Names only. The human sets values.

| Where | Names |
|---|---|
| Dashboard Worker secrets | `DASHBOARD_PASSWORD`, `API_TOKEN`, `INSTANTLY_API_KEY`, `ANTHROPIC_API_KEY`, `GA_SERVICE_ACCOUNT_JSON`, `META_*`, `GITHUB_DISPATCH_TOKEN`; optional Twilio (`TWILIO_*`, `ALERT_PHONE`; currently unset, so SMS does nothing) |
| Dashboard Worker vars | `INSTANTLY_CAMPAIGN_ID`, `GA_PROPERTY_ID`, optional `BOOKING_LINK` |
| GitHub Actions repo secrets | `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `API_TOKEN`, `DASHBOARD_URL` (no trailing slash) |
| Chatbot Worker secrets | `ANTHROPIC_API_KEY`, `ADMIN_TOKEN` |

Set a Worker secret: `npx wrangler secret put NAME` (prompts for the value). Cloudflare deploys and secret changes must be run from a computer that can reach `api.cloudflare.com` and is logged in with `npx wrangler login`.

## 8. Diagnosing problems

1. Open `/health` on the dashboard. A red or amber bar on every page means a check is failing.
2. "No drafts today": read the latest `run_log` rows (read-only SQL): `SELECT ok, summary, created_at FROM run_log WHERE kind='outreach' ORDER BY id DESC LIMIT 5`. `summary` lists failed steps and counts of new leads and drafts. Then open the GitHub Actions run logs.
3. Cloudflare D1 rejects compound queries with many `UNION` terms. Keep each query to about 3 `SELECT`s.
4. Fewer drafts than expected is usually normal: sites with no public email are skipped, polished sites are skipped, and bad or typo emails are rejected.
5. Replies not appearing: check the `replies_sync` row in `run_log` and the Instantly key status on `/health`.
6. A build failed after a merge: check the Workers Builds status on the merge commit, fix on a new branch, do not force-push to `main`.

## 9. The website chatbot

A small AI chat bubble for any website. One Worker serves every client; each client is one config file. It uses the Claude API (`claude-haiku-5-5` by default, about a third of a cent per conversation).

**Source location:** the kit is a standalone folder (not in this repo): `package.json`, `wrangler.toml`, `schema.sql`, `src/index.js`, `src/prompt.js`, `src/clients/*.js`, `public/widget.js`, `public/demo.html`, `test/`. Ask the human where the current copy is. It should live in its own git repository so it can be backed up and reviewed like this one.

Key behaviours:
- Routes: `GET /api/config?client=ID` (public display settings), `POST /api/chat?client=ID`, `GET /api/leads` (bearer `ADMIN_TOKEN`, JSON or `format=csv`), `GET /health`.
- Only the origins in a client's `allowedOrigins` (plus `DEV_ORIGINS`) can use that client's bot.
- Limits: 8 messages per minute per visitor (`CHAT_LIMITER`), a per-client `dailyMessageCap` (300 for Ocoos), messages capped at 1,000 characters, the last 20 turns sent.
- The model gets a `save_lead` tool. A lead needs a name plus an email or phone. It is stored in D1 `leads` and emailed to the client's `notifyEmail` (reply-to is the visitor).
- The brief and notify email are never sent to the browser.
- Ocoos leads also appear on the dashboard Chat leads page through the `CHAT_DB` binding. The dashboard adds `status` and `handled_at` columns to the chatbot's `leads` table.

Change what the bot says: edit `brief` in `src/clients/<id>.js` (short, factual, only what the client confirmed), run `npm test`, then deploy. The brief is the only place the bot's knowledge lives. Rules that every bot follows are in `src/prompt.js`.

Deploy (from the kit folder, on a computer logged in to Cloudflare): `npm install`, `npx wrangler login`, `npm run deploy`. First-time setup also needs `npx wrangler secret put ANTHROPIC_API_KEY` and `ADMIN_TOKEN`.

Add a client:
1. Copy `src/clients/_template.js` to `src/clients/<id>.js` and fill it in.
2. Register it in `src/clients/index.js`.
3. Add the client's notification address as a verified destination in Cloudflare Email Routing (they get a verification email).
4. `npm test`, then `npm run deploy`.
5. Give the client the script tag: `<script src="https://chat.ocooswebconsulting.com/widget.js" data-client="<id>" defer></script>` (Squarespace: Settings, Developer tools, Code injection, Footer).

Lead emails need Cloudflare Email Service set up for the sending domain. Without it, leads are still saved but no email arrives.

**Changing the AI provider.** The model call is one function (`callClaude` in `src/index.js`) using the Anthropic Messages format with tool use and prompt caching. Switching to another provider, for example DeepSeek's OpenAI-compatible API, means rewriting that function (request shape, tool-call format, response parsing) and the matching test helpers. It is not a configuration change and has not been built or tested.

## 10. Known gotchas

- A lead skipped by Instantly as a duplicate keeps its old text; edits on the Review page do not overwrite it.
- Playwright mobile emulation widens the layout viewport for wide pages: measure overflow against `screen.width`.
- Cloudflare bindings in `wrangler.toml` must match real resource ids. Do not rename a database or bucket.
- Squarespace preview domains (`*.squarespace.com`) are not in any chatbot client's `allowedOrigins`; test on the live domain or `/demo.html`.
- Scanner bots open email links: early "page views" can be security scanners. The dashboard filters known scanner user agents.

## 11. Starter prompt for another AI assistant

> You are maintaining the Ocoos Web Consulting systems. Read `docs/PLAYBOOK.md` in the `powerocoos/outreach-engine` repository fully before acting, then follow its golden rules. Work on a branch and open a pull request; never push to `main`, never print secrets, and never launch the email campaign. Run the tests before every pull request. If your environment cannot do something (for example reach Cloudflare), tell me the exact command to run instead.
