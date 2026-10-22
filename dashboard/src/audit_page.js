// Private audit pages: screenshots of a lead's homepage plus the findings behind the outreach email.
// Upload (pipeline, bearer token): PUT /api/audit/<token>/(mobile|desktop).jpg, then PUT /api/audit/<token> (JSON)
// Public page:                     GET /a/<token>          (logs an audit_viewed touch)
// Public screenshot:               GET /a/<token>/(mobile|desktop).jpg
import { safeEqual, isValidToken } from "./logic.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const IMG_MAX = 3 * 1024 * 1024;
const KINDS = ["mobile", "desktop"];
const CONTACT = "https://www.ocooswebconsulting.com/contact?utm_source=outreach&utm_medium=email&utm_campaign=audit-page";

export const AUDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS audit_pages (token TEXT PRIMARY KEY, contact_email TEXT, company TEXT NOT NULL,
    website TEXT, findings TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];

const bearerOk = (request, env) =>
  safeEqual((request.headers.get("authorization") || "").replace(/^Bearer /, ""), env.API_TOKEN);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function handleAuditImagePut(request, env, token, kind) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  if (!isValidToken(token) || !KINDS.includes(kind)) return json({ error: "bad path" }, 400);
  if ((request.headers.get("content-type") || "") !== "image/jpeg") return json({ error: "image/jpeg only" }, 415);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > IMG_MAX) return json({ error: "image must be 1 byte to 3 MB" }, 413);
  const h = new Uint8Array(bytes.slice(0, 3));
  if (h[0] !== 0xff || h[1] !== 0xd8 || h[2] !== 0xff) return json({ error: "not a JPEG" }, 415);
  await env.MEDIA.put(`audit/${token}/${kind}.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return json({ ok: true });
}

export async function handleAuditPut(request, env, token) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  if (!isValidToken(token)) return json({ error: "bad token" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const findings = (Array.isArray(body.findings) ? body.findings : [])
    .map((f) => ({ text: String(f && f.text || "").slice(0, 300), service: String(f && f.service || "website").slice(0, 20) }))
    .filter((f) => f.text).slice(0, 12);
  if (!body.company) return json({ error: "company required" }, 400);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO audit_pages (token, contact_email, company, website, findings) VALUES (?,?,?,?,?)"
  ).bind(token, String(body.email || "").toLowerCase() || null, String(body.company).slice(0, 120),
         String(body.website || "").slice(0, 200), JSON.stringify(findings)).run();
  return json({ ok: true, path: `/a/${token}` });
}

export async function handleAuditImageGet(env, token, kind) {
  const obj = await env.MEDIA.get(`audit/${token}/${kind}.jpg`);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600", "x-robots-tag": "noindex" } });
}

const OTHER = [
  ["Website fixes and redesign", "Faster, clearer, built for phones."],
  ["Local SEO and content writing", "Pages and posts that show up when people nearby search."],
  ["Google Business Profile and ads", "Help with listings, reviews and Google or Facebook ads."],
  ["Graphic design and social media", "Logos, branded images and regular posts."],
];

export async function handleAuditView(request, env, token, hooks = {}) {
  const row = await env.DB.prepare("SELECT * FROM audit_pages WHERE token=?").bind(token).first();
  if (!row) return new Response("Not found", { status: 404 });
  const lead = row.contact_email
    ? await env.DB.prepare("SELECT id FROM leads WHERE contact_email=?").bind(row.contact_email).first() : null;
  // Your own views (owner cookie) are not logged. Scanner views are logged but ignored by the Hot leads page.
  if (!(hooks.isOwner && hooks.isOwner(request))) {
    const ua = (request.headers.get("user-agent") || "").slice(0, 200);
    await env.DB.prepare("INSERT INTO touches (lead_id, contact_email, event, raw) VALUES (?,?,?,?)")
      .bind(lead?.id ?? null, row.contact_email, "audit_viewed", ua).run();
    if (hooks.onView) await hooks.onView(row, ua).catch(() => {});
  }
  let findings = [];
  try { findings = JSON.parse(row.findings); } catch { /* keep empty */ }
  const list = findings.length
    ? `<ul>${findings.map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul>`
    : "<p>Nothing stood out on the first screen. Happy to look deeper if useful.</p>";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(row.company)}: website snapshot</title>
<style>:root{--bg:#f6f8fb;--fg:#14202e;--mut:#5b6b7c;--card:#fff;--line:#dfe6ee;--acc:#155387;--cta:#0066cc}
@media(prefers-color-scheme:dark){:root{--bg:#0f1720;--fg:#f3f4f6;--mut:#9ca3af;--card:#16212d;--line:#243242;--acc:#7cb7ee;--cta:#3b8fe0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.5rem;margin:.2rem 0 .4rem;color:var(--acc)}
h2{font-size:1.1rem;margin:1.6rem 0 .6rem}.sub{color:var(--mut);margin:0 0 1rem}
.shots{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
@media(min-width:700px){.shots{grid-template-columns:260px minmax(0,1fr);align-items:start}}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}
figure img{width:100%;height:auto;display:block;border-radius:8px}.shots figure:first-child img{max-height:560px;object-fit:cover;object-position:top}figcaption{color:var(--mut);font-size:.85rem;margin-top:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 18px 14px}
li{margin:.5rem 0}.other{list-style:none;padding:0}.other li{padding:.5rem 0;border-top:1px solid var(--line)}.other li:first-child{border-top:0}
.other b{display:block}.other span{color:var(--mut)}
.cta{display:inline-block;margin-top:1rem;background:var(--cta);color:#fff;text-decoration:none;padding:.75rem 1.2rem;border-radius:999px;font-weight:600}
.fine{color:var(--mut);font-size:.8rem;margin-top:1.5rem}</style></head><body><main>
<h1>${esc(row.company)}: how your homepage looks to a customer</h1>
<p class="sub">Screenshots of the first screen on a phone and on a computer, plus what I noticed. I'm Xavier with Ocoos Web Consulting in Ocala.</p>
<div class="shots">
<figure><img src="/a/${token}/mobile.jpg" alt="First screen of ${esc(row.company)} on a phone"><figcaption>On a phone</figcaption></figure>
<figure><img src="/a/${token}/desktop.jpg" alt="First screen of ${esc(row.company)} on a computer"><figcaption>On a computer</figcaption></figure>
</div>
<h2>What I noticed</h2><div class="card">${list}</div>
<h2>Other ways I can help</h2><div class="card"><ul class="other">${OTHER.map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join("")}</ul></div>
<a class="cta" href="${CONTACT}">Book a free 15-minute website audit</a>
<p class="fine">This page is private and was made only for ${esc(row.company)}. Observations come from the live homepage on the day it was checked.</p>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
}
