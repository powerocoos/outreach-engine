# Chat leads (website chatbot)

The website chatbot is a separate Worker (`website-chatbot`, served at chat.ocooswebconsulting.com, kit in the `ocoos-chatbot` folder). When a visitor gives a name plus an email or phone number, the bot saves a lead in its own D1 database (`website-chatbot`, id in `dashboard/wrangler.toml`).

This dashboard reads that database through the `CHAT_DB` binding:

- **Chat leads** page (`/chat-leads`): tabs To follow up / Contacted, email and phone links, the bot's one-line summary, and the full conversation. Mark contacted / Reopen.
- Menu badge and the home page card "Chat leads to follow up" count leads still marked `new` (`GET /api/summary` -> `chatLeads`).
- API: `GET /api/chat-leads?status=new|done`, `POST /api/chat-leads/:id` with `{action: "done" | "reopen"}` (same `x-requested-with: review` header as the other pages). Visitor session ids are never returned.
- The page only shows `client = 'ocoos'` rows. Other clients of the chatbot kit keep their leads out of this dashboard.

Schema: the chatbot's `leads` table gets `status` (default `new`) and `handled_at`. `chatleads.js` adds them on first use (`ALTER TABLE`, errors ignored when they exist), and the chatbot's own `schema.sql` includes them for fresh installs. If `CHAT_DB` is not bound, the page says so and counts show zero; nothing else breaks.

Nothing is sent from the dashboard. Lead emails to support@ocooswebconsulting.com come from the chatbot Worker (needs Cloudflare Email Service set up for the domain).
