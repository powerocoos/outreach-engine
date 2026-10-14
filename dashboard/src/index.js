import { normalizeEvent, shouldAlert, alertText, rate, safeEqual, isValidToken } from "./logic.js";

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
    headers: { "www-authenticate": 'Basic realm="Red Panda outreach"' },
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
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/webhook/instantly" && request.method === "POST") return handleWebhook(request, env, ctx);
    if (pathname === "/api/leads" && request.method === "POST") return handleImport(request, env);
    let m;
    if ((m = pathname.match(/^\/api\/media\/([^/]+)$/)) && request.method === "PUT") return handleMediaUpload(request, env, m[1]);
    if ((m = pathname.match(/^\/v\/([0-9a-f]{32})\.mp4$/)) && request.method === "GET") return handleMediaFile(request, env, m[1]);
    if ((m = pathname.match(/^\/v\/([0-9a-f]{32})$/)) && request.method === "GET") return handleMediaView(request, env, ctx, m[1]);

    if (!basicAuthOk(request, env)) return challenge();
    if (pathname === "/api/stats") return json(await stats(env));
    if (pathname === "/" || pathname === "/dashboard") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
    }
    return new Response("Not found", { status: 404 });
  },
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Outreach Dashboard</title>
<style>
:root{--bg:#fff;--fg:#1c1b1a;--mut:#6b6762;--card:#f6f4f1;--line:#e4e0da;--acc:#c2410c}
@media(prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f1eeea;--mut:#a39d95;--card:#201f1d;--line:#34312e;--acc:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px;max-width:980px;margin-inline:auto}
h1{font-size:20px;margin:0 0 20px}h2{font-size:14px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin:28px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tile b{display:block;font-size:26px;color:var(--acc)}.tile span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:500;font-size:13px}
</style></head><body>
<h1>Red Panda outreach</h1><div id="app">Loading…</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const tile=(n,l)=>'<div class="tile"><b>'+esc(n)+'</b><span>'+esc(l)+'</span></div>';
const table=(h,rows)=>'<table><tr>'+h.map(x=>'<th>'+x+'</th>').join('')+'</tr>'+(rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>').join('')||'<tr><td colspan="9">No data yet</td></tr>')+'</table>';
fetch('/api/stats').then(r=>r.json()).then(d=>{const t=d.totals,r=d.rates;
document.getElementById('app').innerHTML=
'<div class="grid">'+tile(t.leads,'Leads')+tile(t.sent,'Contacted')+tile(t.videoViews,'Video views')+tile(t.replied,'Replies')+tile(r.reply+'%','Reply rate')+tile(t.booked,'Calls booked')+tile(t.won,'Won')+tile(r.bounce+'%','Bounce rate')+'</div>'+
'<h2>Hook performance</h2>'+table(['Hook angle','Contacted','Replies'],d.byAngle.map(a=>[a.angle||'—',a.sent,a.replies]))+
'<h2>By city</h2>'+table(['City','Leads','Responded'],d.byCity.map(c=>[c.city||'—',c.leads,c.responded||0]))+
'<h2>Recent activity</h2>'+table(['When','Event','Who'],d.recent.map(e=>[e.created_at,e.event,e.who]));
}).catch(e=>{document.getElementById('app').textContent='Failed to load: '+e});
</script></body></html>`;
