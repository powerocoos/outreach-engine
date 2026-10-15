import { normalizeEvent, eventsFromLead, shouldAlert, alertText, rate, safeEqual, isValidToken, toCsv, draftProblems, REVIEW_STATUSES, REVIEW_ACTIONS } from "./logic.js";
import { REVIEW_PAGE } from "./review_page.js";
import { analyticsReport } from "./analytics.js";
import { SOCIAL_DDL, SOCIAL_PAGE, handleSocialIngest, handleSocialKnown, handleSocialList, handleSocialAction, handleSocialImagePut, handleSocialImageGet, publishDue, SOCIAL_MIGRATIONS } from "./social.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function basicAuthOk(request, env) {
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [, pass = ""] = atob(h.slice(6)).split(/:(.*)/s);
  return safeEqual(pass, env.DASHBOARD_PASSWORD);
}

const challenge = () =>
  new Response("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Ocoos outreach"' },
  });

async function sendSms(env, body) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM || !env.ALERT_PHONE) return false;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: env.TWILIO_FROM, To: env.ALERT_PHONE, Body: body.slice(0, 300) }),
  });
  return res.ok;
}

async function handleWebhook(request, env, ctx) {
  const secret = request.headers.get("x-webhook-secret") || new URL(request.url).searchParams.get("secret");
  if (!safeEqual(secret, env.WEBHOOK_SECRET)) return json({ error: "unauthorized" }, 401);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad json" }, 400); }

  const { event, email, step, campaign } = normalizeEvent(payload);
  if (!event || !email) return json({ ok: true, ignored: true });

  const lead = await env.DB.prepare("SELECT * FROM leads WHERE contact_email = ?").bind(email).first();

  await env.DB.prepare(
    "INSERT INTO touches (lead_id, contact_email, event, step, campaign, raw) VALUES (?,?,?,?,?,?)"
  ).bind(lead?.id ?? null, email, event, step, campaign, JSON.stringify(payload).slice(0, 4000)).run();

  if (lead) {
    const next = { replied: "replied", booked: "booked", bounced: "dead", unsubscribed: "dead" }[event];
    if (next) await env.DB.prepare("UPDATE leads SET status=? WHERE id=?").bind(next, lead.id).run();
  }
  if (event === "booked") {
    await env.DB.prepare("INSERT INTO bookings (lead_id, contact_email) VALUES (?,?)").bind(lead?.id ?? null, email).run();
  }
  if (shouldAlert(event)) ctx.waitUntil(sendSms(env, alertText(event, lead, email)));
  return json({ ok: true });
}

async function handleImport(request, env) {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!safeEqual(auth, env.API_TOKEN)) return json({ error: "unauthorized" }, 401);
  const { leads = [] } = await request.json();
  let n = 0;
  for (const l of leads.slice(0, 500)) {
    if (!l.company || !l.contact_email) continue;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO leads (company, contact_email, phone, website, city, category, hook_angle, mobile_score)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(l.company, l.contact_email.toLowerCase(), l.phone ?? null, l.website ?? null, l.city ?? null,
           l.category ?? null, l.hook_angle ?? null, l.mobile_score ?? null).run();
    n += r.meta.changes;
  }
  return json({ ok: true, imported: n });
}


// --- Hosted screen recordings -------------------------------------------------
// Upload (pipeline, bearer token): PUT /api/media/<token>?email=<contact_email>
// Public view page:                GET /v/<token>      (logs a video_viewed touch)
// Public video bytes:              GET /v/<token>.mp4  (supports Range for mobile players)
async function handleMediaUpload(request, env, token) {
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!safeEqual(auth, env.API_TOKEN)) return json({ error: "unauthorized" }, 401);
  if (!isValidToken(token)) return json({ error: "bad token" }, 400);
  const type = request.headers.get("content-type") || "video/mp4";
  if (!/^video\/(mp4|webm)$/.test(type)) return json({ error: "video/mp4 or video/webm only" }, 415);
  const email = (new URL(request.url).searchParams.get("email") || "").toLowerCase() || null;
  const key = `v/${token}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare(
    "INSERT OR REPLACE INTO media (token, contact_email, r2_key, content_type) VALUES (?,?,?,?)"
  ).bind(token, email, key, type).run();
  return json({ ok: true, path: `/v/${token}` });
}

async function handleMediaView(request, env, ctx, token) {
  const row = await env.DB.prepare("SELECT * FROM media WHERE token=?").bind(token).first();
  if (!row) return new Response("Not found", { status: 404 });
  const lead = row.contact_email
    ? await env.DB.prepare("SELECT id FROM leads WHERE contact_email=?").bind(row.contact_email).first()
    : null;
  // Note: email security scanners sometimes prefetch links, so treat early views with suspicion.
  await env.DB.prepare(
    "INSERT INTO touches (lead_id, contact_email, event, raw) VALUES (?,?,?,?)"
  ).bind(lead?.id ?? null, row.contact_email, "video_viewed",
         (request.headers.get("user-agent") || "").slice(0, 200)).run();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Your website on a phone</title>
<style>body{margin:0;background:#111;color:#eee;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:420px;width:100%;text-align:center}video{width:100%;border-radius:12px;background:#000}p{color:#bbb}</style></head>
<body><main><video controls playsinline autoplay muted loop src="/v/${token}.mp4"></video>
<p>A short recording of how your site loads and scrolls on a phone.</p></main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
}

async function handleMediaFile(request, env, token) {
  const row = await env.DB.prepare("SELECT * FROM media WHERE token=?").bind(token).first();
  if (!row) return new Response("Not found", { status: 404 });
  const obj = await env.MEDIA.get(row.r2_key, { range: request.headers });
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": row.content_type, "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600", "x-robots-tag": "noindex",
  });
  if (obj.range && obj.size != null) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}


// --- Draft review ---------------------------------------------------------------
const DRAFTS_DDL = [
  `CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_email TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL, website TEXT, city TEXT, category TEXT, angle TEXT, mobile_score INTEGER, rating REAL,
    review_count INTEGER, findings TEXT, subject TEXT NOT NULL, email1 TEXT NOT NULL, email2 TEXT NOT NULL,
    email3 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status)",
];
const schemaDone = new WeakSet();
async function ensureSchema(env) {
  if (schemaDone.has(env.DB)) return;
  for (const sql of [...DRAFTS_DDL, ...SOCIAL_DDL]) await env.DB.prepare(sql).run();
  for (const sql of SOCIAL_MIGRATIONS) { try { await env.DB.prepare(sql).run(); } catch { /* column already exists */ } }
  schemaDone.add(env.DB);
}

const bearerOk = (request, env) =>
  safeEqual((request.headers.get("authorization") || "").replace(/^Bearer /, ""), env.API_TOKEN);

// Pipeline -> dashboard: new drafts land as "pending". Existing rows are never overwritten,
// so a decision you already made is not undone by a re-run.
async function handleDraftImport(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  let added = 0, skipped = 0;
  for (const d of (body.drafts || []).slice(0, 200)) {
    if (!d.contact_email || !d.company || draftProblems(d).length) { skipped++; continue; }
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO drafts (contact_email, company, website, city, category, angle, mobile_score,
         rating, review_count, findings, subject, email1, email2, email3) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(String(d.contact_email).toLowerCase(), d.company, d.website ?? null, d.city ?? null, d.category ?? null,
           d.angle ?? null, d.mobile_score ?? null, d.rating ?? null, d.review_count ?? null,
           JSON.stringify(Array.isArray(d.findings) ? d.findings : []),
           d.subject, d.email1, d.email2, d.email3).run();
    if (r.meta.changes) added++; else skipped++;
  }
  return json({ ok: true, added, skipped });
}

// Pipeline run state (the SQLite file) lives in R2 so runs from any machine, or GitHub Actions, share it.
const STATE_KEY = "state/outreach.db";
async function handleState(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  if (request.method === "PUT") {
    await env.MEDIA.put(STATE_KEY, request.body, { httpMetadata: { contentType: "application/octet-stream" } });
    return json({ ok: true });
  }
  const obj = await env.MEDIA.get(STATE_KEY);
  if (!obj) return new Response("no state yet", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
}

const csrfOk = (request) => request.headers.get("x-requested-with") === "review";

async function handleReviewList(request, env) {
  const status = new URL(request.url).searchParams.get("status") || "pending";
  if (!REVIEW_STATUSES.includes(status)) return json({ error: "bad status" }, 400);
  const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0]));
  for (const r of (await env.DB.prepare("SELECT status, COUNT(*) n FROM drafts GROUP BY status").all()).results) {
    counts[r.status] = r.n;
  }
  const rows = (await env.DB.prepare(
    "SELECT * FROM drafts WHERE status=? ORDER BY id LIMIT 100").bind(status).all()).results;
  const drafts = rows.map((r) => ({ ...r, findings: safeJson(r.findings) }));
  return json({ counts, drafts });
}

function safeJson(t) { try { return JSON.parse(t) ?? []; } catch { return []; } }

async function handleReviewAction(request, env, id) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!REVIEW_ACTIONS.includes(body.action)) return json({ error: "bad action" }, 400);
  const d = await env.DB.prepare("SELECT * FROM drafts WHERE id=?").bind(id).first();
  if (!d) return json({ error: "not found" }, 404);

  const next = { subject: d.subject, email1: d.email1, email2: d.email2, email3: d.email3 };
  let edited = d.edited;
  if (body.action === "save" || body.action === "approve") {
    for (const k of Object.keys(next)) {
      if (typeof body[k] === "string" && body[k] !== d[k]) { next[k] = body[k]; edited = 1; }
    }
  }
  if (body.action === "approve") {
    const problems = draftProblems(next);
    if (problems.length) return json({ error: problems.join("; ") }, 422);
    const lead = await env.DB.prepare("SELECT status FROM leads WHERE contact_email=?").bind(d.contact_email).first();
    if (lead && lead.status === "dead") return json({ error: "this contact bounced or unsubscribed" }, 409);
  }
  const status = { approve: "approved", reject: "rejected", reset: "pending", save: d.status }[body.action];
  if (body.action === "save" || body.action === "approve") {
    await env.DB.prepare("UPDATE drafts SET subject=?, email1=?, email2=?, email3=?, edited=? WHERE id=?")
      .bind(next.subject, next.email1, next.email2, next.email3, edited, id).run();
  }
  if (body.action !== "save") {
    await env.DB.prepare("UPDATE drafts SET status=?, decided_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, id).run();
  }
  if (body.action === "approve") {
    // Approved drafts become tracked leads so webhook events and stats can match them.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO leads (company, contact_email, website, city, category, hook_angle, mobile_score)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(d.company, d.contact_email, d.website, d.city, d.category, d.angle, d.mobile_score).run();
  }
  return json({ ok: true, status });
}

// Downloads approved drafts as an Instantly CSV and marks them exported so they are not imported twice.
async function handleExport(request, env) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  const origin = new URL(request.url).origin;
  const rows = (await env.DB.prepare(
    `SELECT d.*, m.token FROM drafts d
     LEFT JOIN (SELECT contact_email, MAX(rowid) rid, token FROM media GROUP BY contact_email) m
       ON m.contact_email = d.contact_email
     LEFT JOIN leads l ON l.contact_email = d.contact_email
     WHERE d.status='approved' AND COALESCE(l.status,'') != 'dead' ORDER BY d.id`
  ).all()).results;
  const csv = toCsv(rows.map((r) => ({
    email: r.contact_email, first_name: "", company_name: r.company, website: r.website, city: r.city,
    category: r.category, angle: r.angle, video_url: r.token ? `${origin}/v/${r.token}` : "",
    subject: r.subject, email1: r.email1, email2: r.email2, email3: r.email3,
  })));
  for (const r of rows) {
    await env.DB.prepare("UPDATE drafts SET status='exported', decided_at=CURRENT_TIMESTAMP WHERE id=?").bind(r.id).run();
  }
  return new Response(csv, { headers: {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="instantly.csv"',
    "x-exported-count": String(rows.length),
  } });
}

// Push approved drafts into the Instantly campaign through its API (campaign stays a draft until launched in Instantly).
async function handleSendToInstantly(request, env) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  if (!env.INSTANTLY_API_KEY) return json({ error: "INSTANTLY_API_KEY is not set on the Worker" }, 400);
  const campaign = env.INSTANTLY_CAMPAIGN_ID;
  if (!campaign) return json({ error: "INSTANTLY_CAMPAIGN_ID is not set" }, 400);
  const rows = (await env.DB.prepare(
    `SELECT d.* FROM drafts d LEFT JOIN leads l ON l.contact_email = d.contact_email
     WHERE d.status='approved' AND COALESCE(l.status,'') != 'dead' ORDER BY d.id LIMIT 50`
  ).all()).results;
  let sent = 0;
  const failed = [];
  for (const r of rows) {
    let res;
    try {
      res = await fetch("https://api.instantly.ai/api/v2/leads", {
        method: "POST",
        headers: { authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          campaign, email: r.contact_email, company_name: r.company || "", website: r.website || "",
          skip_if_in_campaign: true,
          custom_variables: { Subject: r.subject, Email1: r.email1, Email2: r.email2, Email3: r.email3 },
        }),
      });
    } catch (e) {
      failed.push({ company: r.company, error: "network error" });
      continue;
    }
    if (res.ok) {
      await env.DB.prepare("UPDATE drafts SET status='exported', decided_at=CURRENT_TIMESTAMP WHERE id=?").bind(r.id).run();
      sent++;
    } else {
      failed.push({ company: r.company, error: `Instantly ${res.status}` });
      if (res.status === 401 || res.status === 402 || res.status === 429) break;
    }
  }
  return json({ ok: failed.length === 0, sent, failed, remaining: rows.length - sent });
}

// --- Instantly campaign status / launch / pause ------------------------------
const CAMPAIGN_STATUS = { "-99": "Account suspended", "-2": "Bounce protect", "-1": "Accounts unhealthy", 0: "Draft", 1: "Active", 2: "Paused", 3: "Completed", 4: "Running subsequences" };

async function instantly(env, path, method = "GET") {
  const res = await fetch(`https://api.instantly.ai/api/v2${path}`, {
    method, headers: { authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "content-type": "application/json" },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body };
}

async function handleCampaign(request, env) {
  if (!env.INSTANTLY_API_KEY || !env.INSTANTLY_CAMPAIGN_ID) return json({ configured: false });
  const r = await instantly(env, `/campaigns/${env.INSTANTLY_CAMPAIGN_ID}`);
  if (!r.ok) return json({ configured: true, error: `Instantly ${r.status}` });
  const c = r.body || {};
  return json({ configured: true, name: c.name, status: c.status, label: CAMPAIGN_STATUS[c.status] || "Unknown", daily_limit: c.daily_limit ?? null });
}

async function handleCampaignAction(request, env, action) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  if (!env.INSTANTLY_API_KEY || !env.INSTANTLY_CAMPAIGN_ID) return json({ error: "Instantly is not configured" }, 400);
  if (action === "activate") {
    let body = {};
    try { body = await request.json(); } catch {}
    if (body.confirm !== "LAUNCH") return json({ error: "Type LAUNCH to confirm" }, 400);
  }
  const r = await instantly(env, `/campaigns/${env.INSTANTLY_CAMPAIGN_ID}/${action}`, "POST");
  if (!r.ok) {
    const hint = r.status === 403 || r.status === 401 ? " (the API key may need campaign update access)" : "";
    return json({ error: `Instantly ${r.status}${hint}` }, 502);
  }
  return json({ ok: true, action });
}

// --- Poll Instantly for lead activity (used instead of webhooks) ---------------
// Records each (lead, event) once, so repeated polls never double count.
export async function syncInstantly(env, ctx) {
  if (!env.INSTANTLY_API_KEY || !env.INSTANTLY_CAMPAIGN_ID) return { skipped: "not configured" };
  await ensureSchema(env);
  let cursor, leadsSeen = 0, added = 0;
  for (let page = 0; page < 20; page++) {
    const res = await fetch("https://api.instantly.ai/api/v2/leads/list", {
      method: "POST",
      headers: { authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ campaign: env.INSTANTLY_CAMPAIGN_ID, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }),
    });
    if (!res.ok) return { error: `Instantly ${res.status}`, leadsSeen, added };
    const data = await res.json();
    for (const it of data.items || []) {
      leadsSeen++;
      const email = String(it.email || "").trim().toLowerCase();
      if (!email) continue;
      const lead = await env.DB.prepare("SELECT * FROM leads WHERE contact_email = ?").bind(email).first();
      for (const event of eventsFromLead(it)) {
        const seen = await env.DB.prepare("SELECT 1 x FROM touches WHERE contact_email=? AND event=?").bind(email, event).first();
        if (seen) continue;
        await env.DB.prepare("INSERT INTO touches (lead_id, contact_email, event, step, campaign, raw) VALUES (?,?,?,?,?,?)")
          .bind(lead?.id ?? null, email, event, null, env.INSTANTLY_CAMPAIGN_ID, "poll").run();
        added++;
        if (lead) {
          const next = { replied: "replied", booked: "booked", bounced: "dead", unsubscribed: "dead" }[event];
          if (next) await env.DB.prepare("UPDATE leads SET status=? WHERE id=?").bind(next, lead.id).run();
        }
        if (event === "booked") await env.DB.prepare("INSERT INTO bookings (lead_id, contact_email) VALUES (?,?)").bind(lead?.id ?? null, email).run();
        if (shouldAlert(event)) { const p = sendSms(env, alertText(event, lead, email)); if (ctx?.waitUntil) ctx.waitUntil(p); }
      }
    }
    cursor = data.next_starting_after;
    if (!cursor || !(data.items || []).length) break;
  }
  return { leadsSeen, added };
}

async function stats(env) {
  const count = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first()).n;
  const uniq = (ev) => count("SELECT COUNT(DISTINCT contact_email) n FROM touches WHERE event=?", ev);
  const [leads, sent, replied, bounced, booked, held, won, videoViews] = await Promise.all([
    count("SELECT COUNT(*) n FROM leads"), uniq("sent"), uniq("replied"), uniq("bounced"),
    count("SELECT COUNT(*) n FROM bookings"),
    count("SELECT COUNT(*) n FROM bookings WHERE held=1"),
    count("SELECT COUNT(*) n FROM bookings WHERE won=1"),
    uniq("video_viewed"),
  ]);
  const byAngle = await env.DB.prepare(
    `SELECT l.hook_angle angle, COUNT(DISTINCT t.contact_email) sent,
            COUNT(DISTINCT CASE WHEN r.event='replied' THEN r.contact_email END) replies
     FROM touches t JOIN leads l ON l.id=t.lead_id
     LEFT JOIN touches r ON r.contact_email=t.contact_email AND r.event='replied'
     WHERE t.event='sent' GROUP BY l.hook_angle ORDER BY replies DESC LIMIT 10`
  ).all();
  const byCity = await env.DB.prepare(
    `SELECT l.city, COUNT(*) leads, SUM(l.status IN ('replied','booked')) responded
     FROM leads l GROUP BY l.city ORDER BY leads DESC LIMIT 10`
  ).all();
  const recent = await env.DB.prepare(
    `SELECT t.created_at, t.event, COALESCE(l.company, t.contact_email) who
     FROM touches t LEFT JOIN leads l ON l.id=t.lead_id
     WHERE t.event IN ('replied','booked','bounced') ORDER BY t.id DESC LIMIT 15`
  ).all();
  return {
    totals: { leads, sent, replied, bounced, booked, held, won, videoViews },
    rates: { reply: rate(replied, sent), bounce: rate(bounced, sent), booking: rate(booked, sent) },
    byAngle: byAngle.results, byCity: byCity.results, recent: recent.results,
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncInstantly(env, ctx).catch(() => {}));
    ctx.waitUntil(ensureSchema(env).then(() => publishDue(env)).catch(() => {}));
  },
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/webhook/instantly" && request.method === "POST") return handleWebhook(request, env, ctx);
    if (pathname === "/api/leads" && request.method === "POST") return handleImport(request, env);
    if (pathname === "/api/drafts" && request.method === "POST") { await ensureSchema(env); return handleDraftImport(request, env); }
    if (pathname === "/api/social" && request.method === "POST") { await ensureSchema(env); return handleSocialIngest(request, env); }
    if (pathname === "/api/social/known" && request.method === "GET") { await ensureSchema(env); return handleSocialKnown(request, env); }
    if (pathname === "/api/state" && ["GET", "PUT"].includes(request.method)) return handleState(request, env);
    let m;
    if ((m = pathname.match(/^\/api\/social-image\/([0-9a-f]{32})$/)) && request.method === "PUT") return handleSocialImagePut(request, env, m[1]);
    if ((m = pathname.match(/^\/img\/social\/([0-9a-f]{32})\.jpg$/)) && request.method === "GET") return handleSocialImageGet(env, m[1]);
    if ((m = pathname.match(/^\/api\/media\/([^/]+)$/)) && request.method === "PUT") return handleMediaUpload(request, env, m[1]);
    if ((m = pathname.match(/^\/v\/([0-9a-f]{32})\.mp4$/)) && request.method === "GET") return handleMediaFile(request, env, m[1]);
    if ((m = pathname.match(/^\/v\/([0-9a-f]{32})$/)) && request.method === "GET") return handleMediaView(request, env, ctx, m[1]);

    if (!basicAuthOk(request, env)) return challenge();
    if (pathname === "/api/stats") return json(await stats(env));
    if (pathname === "/review") {
      return new Response(REVIEW_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
    }
    if (pathname === "/social") {
      return new Response(SOCIAL_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
    }
    if (pathname === "/api/social" && request.method === "GET") { await ensureSchema(env); return handleSocialList(request, env); }
    if ((m = pathname.match(/^\/api\/social\/(\d+)$/)) && request.method === "POST") { await ensureSchema(env); return handleSocialAction(request, env, Number(m[1])); }
    if (pathname === "/api/review" && request.method === "GET") { await ensureSchema(env); return handleReviewList(request, env); }
    if ((m = pathname.match(/^\/api\/review\/(\d+)$/)) && request.method === "POST") { await ensureSchema(env); return handleReviewAction(request, env, Number(m[1])); }
    if (pathname === "/api/send/instantly" && request.method === "POST") { await ensureSchema(env); return handleSendToInstantly(request, env); }
    if (pathname === "/api/sync/instantly" && request.method === "POST") {
      if (!csrfOk(request)) return json({ error: "missing header" }, 403);
      return json(await syncInstantly(env, ctx));
    }
    if (pathname === "/api/analytics" && request.method === "GET") {
      try { return json(await analyticsReport(env, Number(new URL(request.url).searchParams.get("days")) || 30)); }
      catch (e) { return json({ configured: true, error: String(e.message || e).slice(0, 120) }); }
    }
    if (pathname === "/api/campaign" && request.method === "GET") return handleCampaign(request, env);
    if (pathname === "/api/campaign/launch" && request.method === "POST") return handleCampaignAction(request, env, "activate");
    if (pathname === "/api/campaign/pause" && request.method === "POST") return handleCampaignAction(request, env, "pause");
    if (pathname === "/api/export/instantly" && request.method === "POST") { await ensureSchema(env); return handleExport(request, env); }
    if (pathname === "/" || pathname === "/dashboard") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
    }
    return new Response("Not found", { status: 404 });
  },
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Outreach Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#fff;--fg:#111827;--mut:#4b5563;--card:#fff;--line:#e5e7eb;--soft:#f3f4f6;--acc:#155387;--cta:#0066cc;--ok:#15803d;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#0f1720;--fg:#f3f4f6;--mut:#9ca3af;--card:#16212d;--line:#243242;--soft:#1b2836;--acc:#7cb7ee;--cta:#3b8fe0;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:300 15px/1.6 'Poppins',system-ui,sans-serif;padding:24px 16px;max-width:980px;margin-inline:auto}
h1{font-size:24px;font-weight:700;color:var(--acc);margin:0 0 4px}h2{font-size:13px;font-weight:600;color:var(--acc);text-transform:uppercase;letter-spacing:.05em;margin:28px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 1px 3px rgba(17,24,39,.06);padding:12px 14px}
.tile b{display:block;font-size:28px;font-weight:700;color:var(--acc)}.tile span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:600;font-size:13px}
.top{display:flex;align-items:center;gap:14px;padding-bottom:16px;margin-bottom:20px;border-bottom:1px solid var(--line)}.top img{height:44px;width:auto}@media(prefers-color-scheme:dark){.top img{background:#fff;border-radius:8px;padding:4px 8px}}.top a.nav{margin-left:auto;background:var(--cta);color:#fff;text-decoration:none;border-radius:999px;padding:8px 18px;font-weight:500;font-size:14px}a{color:var(--cta)}</style></head><body>
<div class="top"><img src="https://images.squarespace-cdn.com/content/v1/5dc50cc1afeeeb552425247c/d8489d11-b4c0-4699-abf0-75e870088b4f/Ocoos+Web+Consulting+Logo+01+-+smaller-min.png?format=500w" alt="Ocoos Web Consulting"><a class="nav" href="/social" style="margin-left:auto;background:transparent;color:var(--cta);border:1px solid var(--cta)">Social posts</a><a class="nav" href="/review" style="margin-left:0">Review drafts &rarr;</a></div>
<h1>Outreach dashboard</h1><div id="app">Loading…</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tile=(n,l)=>'<div class="tile"><b>'+esc(n)+'</b><span>'+esc(l)+'</span></div>';
const table=(h,rows)=>'<table><tr>'+h.map(x=>'<th>'+x+'</th>').join('')+'</tr>'+(rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join('')||'<tr><td colspan="9">No data yet</td></tr>')+'</table>';
fetch('/api/stats').then(r=>r.json()).then(d=>{const t=d.totals,r=d.rates;
document.getElementById('app').innerHTML=
'<div class="grid">'+tile(t.leads,'Leads')+tile(t.sent,'Contacted')+tile(t.videoViews,'Video views')+tile(t.replied,'Replies')+tile(r.reply+'%','Reply rate')+tile(t.booked,'Calls booked')+tile(t.won,'Won')+tile(r.bounce+'%','Bounce rate')+'</div>'+
'<h2>Hook performance</h2>'+table(['Hook angle','Contacted','Replies'],d.byAngle.map(a=>[a.angle||'—',a.sent,a.replies]))+
'<h2>By city</h2>'+table(['City','Leads','Responded'],d.byCity.map(c=>[c.city||'—',c.leads,c.responded||0]))+
'<div id="ga"></div><h2>Recent activity</h2>'+table(['When','Event','Who'],d.recent.map(e=>[e.created_at,e.event,e.who]));
loadGa();
}).catch(e=>{document.getElementById('app').textContent='Failed to load: '+e});
function spark(v){if(!v.length)return '';const m=Math.max(...v,1),w=300,h=48,st=w/Math.max(v.length-1,1);return '<svg viewBox="0 0 '+w+' '+h+'" width="100%" height="'+h+'" preserveAspectRatio="none" role="img" aria-label="Daily sessions"><polyline fill="none" stroke="var(--cta)" stroke-width="2" points="'+v.map((x,i)=>(i*st).toFixed(1)+','+(h-3-(x/m)*(h-6)).toFixed(1)).join(' ')+'"/></svg>'}
function loadGa(){fetch('/api/analytics').then(r=>r.json()).then(g=>{const el=document.getElementById('ga');if(!el)return;
if(!g.configured){el.innerHTML='';return}
if(g.error){el.innerHTML='<h2>Website traffic</h2><p style="color:var(--mut)">Analytics unavailable: '+esc(g.error)+'</p>';return}
el.innerHTML='<h2>Website traffic (last '+g.days+' days)</h2><div class="grid">'+tile(g.totals.sessions,'Sessions')+tile(g.totals.users,'Users')+tile(g.totals.keyEvents,'Key events')+tile(g.totals.engagementRate+'%','Engaged')+tile(g.outreach.sessions,'From outreach emails')+tile(g.outreach.keyEvents,'Outreach key events')+'</div><div style="margin:14px 0">'+spark(g.daily.map(d=>d.sessions))+'</div>'+
table(['Source / medium','Sessions','Key events'],g.sources.map(x=>[x.name,x.sessions,x.keyEvents]))+'<h2>Top pages</h2>'+table(['Page','Views'],g.pages.map(x=>[x.path,x.views]));
}).catch(()=>{})}
</script></body></html>`;
