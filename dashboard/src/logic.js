// Pure helpers (no Cloudflare APIs) so they can be unit-tested under plain Node.

// Map Instantly-style event names to our internal event vocabulary.
// NOTE: confirm exact event names against your Instantly webhook settings.
const EVENT_MAP = {
  email_sent: "sent",
  email_opened: "opened",
  link_clicked: "clicked",
  reply_received: "replied",
  lead_interested: "replied",
  email_bounced: "bounced",
  lead_unsubscribed: "unsubscribed",
  meeting_booked: "booked",
};

// Public video tokens are 32 hex chars (uuid4 without dashes).
export const TOKEN_RE = /^[0-9a-f]{32}$/;
export const isValidToken = (t) => TOKEN_RE.test(String(t || ""));

export function normalizeEvent(payload) {
  const raw = String(payload.event_type || payload.event || "").toLowerCase();
  const event = EVENT_MAP[raw] || null;
  const email = String(payload.lead_email || payload.email || "").trim().toLowerCase() || null;
  return {
    event,
    email,
    step: Number.isInteger(payload.step) ? payload.step : null,
    campaign: payload.campaign_name || payload.campaign || null,
  };
}

// Events that should ping your phone immediately.
export function shouldAlert(event) {
  return event === "replied" || event === "booked";
}

export function alertText(event, lead, email) {
  const who = lead?.company || email || "unknown lead";
  const verb = event === "booked" ? "BOOKED a call" : "REPLIED";
  const bits = [`${who} ${verb}.`];
  if (lead?.phone) bits.push(`Phone: ${lead.phone}`);
  if (email) bits.push(`Email: ${email}`);
  if (lead?.hook_angle) bits.push(`Hook: ${lead.hook_angle}`);
  return bits.join(" ");
}

export function rate(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

// Constant-time string comparison for secrets.
// An empty or missing value never matches, so an unset secret cannot be "guessed" with an empty string.
export function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Draft review -----------------------------------------------------------
export const CSV_COLUMNS = ["email", "first_name", "company_name", "website", "city", "category",
  "angle", "video_url", "subject", "email1", "email2", "email3"];

export function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export const wordCount = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;

// Problems that block approving a draft (edits included). Empty list = OK.
export function draftProblems(d) {
  const p = [];
  if (!String(d.subject || "").trim()) p.push("subject is empty");
  else if (String(d.subject).length > 120) p.push("subject is over 120 characters");
  for (const k of ["email1", "email2", "email3"]) {
    const t = String(d[k] || "").trim();
    if (!t) p.push(`${k} is empty`);
    else if (wordCount(t) > 150) p.push(`${k} is over 150 words`);
  }
  return p;
}

export const REVIEW_STATUSES = ["pending", "approved", "rejected", "exported"];
export const REVIEW_ACTIONS = ["approve", "reject", "save", "reset"];

// Derive our event vocabulary from an Instantly lead record (used by the polling sync).
export function eventsFromLead(lead) {
  const ev = [];
  if (lead.timestamp_last_contact) ev.push("sent");
  const interest = Number(lead.lt_interest_status);
  if (Number(lead.email_reply_count) > 0 || interest === 1 || interest === 2) ev.push("replied");
  if (interest === 2) ev.push("booked");
  if (lead.status === -1) ev.push("bounced");
  if (lead.status === -2) ev.push("unsubscribed");
  return ev;
}
