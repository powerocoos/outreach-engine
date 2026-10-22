// Skipped (polished) leads and reject reasons.
// The pipeline skips sites that look well kept. They are pushed here so you can see what was skipped
// and choose "Send anyway"; the next run drafts an email for each one you chose.
import { safeEqual } from "./logic.js";
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bearerOk = (request, env) => safeEqual((request.headers.get("authorization") || "").replace(/^Bearer /, ""), env.API_TOKEN);
const csrfOk = (request) => request.headers.get("x-requested-with") === "review";

export const REJECT_REASONS = {
  polished: "Site already looks good",
  fit: "Not a good fit",
  contact: "Wrong or poor contact",
  dupe: "Duplicate or already contacted",
  other: "Other",
};

export const SKIPPED_DDL = [
  `CREATE TABLE IF NOT EXISTS skipped_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, website TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL, city TEXT, category TEXT, rating REAL, review_count INTEGER, polish INTEGER,
    findings TEXT, status TEXT NOT NULL DEFAULT 'skipped', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at TEXT)`,
];
export const DRAFT_MIGRATIONS = ["ALTER TABLE drafts ADD COLUMN reject_reason TEXT"];

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);

// Pipeline -> dashboard (bearer). Existing rows are kept, so a decision is never undone by a re-run.
export async function handleSkippedIngest(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  let added = 0;
  for (const s of Array.isArray(body.skipped) ? body.skipped.slice(0, 100) : []) {
    const website = str(s.website, 300), company = str(s.company, 200);
    if (!website || !company) continue;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO skipped_leads (website, company, city, category, rating, review_count, polish, findings)
       VALUES (?,?,?,?,?,?,?,?)`).bind(website, company, str(s.city, 100), str(s.category, 100),
      Number(s.rating) || null, Number(s.review_count) || null, Number(s.polish) || null,
      JSON.stringify((Array.isArray(s.findings) ? s.findings : []).slice(0, 8).map((f) => String(f).slice(0, 300)))).run();
    added += r.meta?.changes || 0;
  }
  return json({ ok: true, added });
}

// Pipeline asks which skipped sites you chose to send anyway; after drafting it marks them done.
export async function handleSkippedOverrides(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  const rows = (await env.DB.prepare("SELECT website FROM skipped_leads WHERE status='send'").all()).results;
  return json({ websites: rows.map((r) => r.website) });
}
export async function handleSkippedDone(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  for (const w of Array.isArray(body.websites) ? body.websites.slice(0, 100) : []) {
    await env.DB.prepare("UPDATE skipped_leads SET status='drafted' WHERE website=? AND status='send'").bind(String(w)).run();
  }
  return json({ ok: true });
}

export async function handleSkippedList(env) {
  const rows = (await env.DB.prepare("SELECT * FROM skipped_leads ORDER BY (status='skipped') DESC, id DESC LIMIT 200").all()).results;
  const reasons = (await env.DB.prepare(
    "SELECT COALESCE(reject_reason,'none') r, COUNT(*) n FROM drafts WHERE status='rejected' GROUP BY 1").all()).results;
  const out = rows.map((r) => {
    let f = []; try { f = JSON.parse(r.findings) || []; } catch { /* keep empty */ }
    return { ...r, findings: f };
  });
  return json({ skipped: out, reasons: Object.fromEntries(reasons.map((x) => [x.r, x.n])), labels: REJECT_REASONS });
}

export async function handleSkippedAction(request, env, id) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const status = { send: "send", dismiss: "dismissed", reset: "skipped" }[body.action];
  if (!status) return json({ error: "bad action" }, 400);
  const row = await env.DB.prepare("SELECT status FROM skipped_leads WHERE id=?").bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  if (row.status === "drafted") return json({ error: "already drafted" }, 409);
  await env.DB.prepare("UPDATE skipped_leads SET status=?, decided_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, id).run();
  return json({ ok: true, status });
}

export const SKIPPED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Skipped leads</title>
${FONT_LINKS}<style>${BASE_CSS}
.note{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:14px}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;color:#fff;background:var(--cta);margin-left:8px;vertical-align:middle}
.pill.send{background:var(--ok)}.pill.dim{background:var(--mut)}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}</style></head><body>
${navHtml("skipped")}
<h1>Skipped leads</h1>
<p class="sub">Sites the pipeline judged well kept, so no email was drafted. If one looks worth contacting, choose Send anyway and the next run drafts it for your review.</p>
<div class="note" id="why"></div><div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"x-requested-with":"review","content-type":"application/json"},opts.headers||{});return fetch(path,opts)}
var LABEL={skipped:"Skipped",send:"Will be drafted next run",drafted:"Drafted",dismissed:"Dismissed"};
function card(s){
  var h=el("h2",{text:s.company});h.appendChild(el("span",{cls:"pill "+(s.status==="send"||s.status==="drafted"?"send":s.status==="dismissed"?"dim":""),text:LABEL[s.status]||s.status}));
  var meta=[s.city,s.category,s.polish?"Polish "+s.polish+"/5":null,s.rating?s.rating+"\\u2605 ("+(s.review_count||0)+" reviews)":null].filter(Boolean).join(" \\u00b7 ");
  var m=el("div",{cls:"meta"});m.appendChild(document.createTextNode(meta+" \\u00b7 "));
  var url=/^https?:/.test(s.website)?s.website:"https://"+s.website;
  m.appendChild(el("a",{href:url,target:"_blank",rel:"noopener noreferrer",text:"website"}));
  var c=el("div",{cls:"card"},[h,m]);
  (s.findings||[]).forEach(function(f){c.appendChild(el("div",{cls:"find",text:f}))});
  var row=el("div",{cls:"row"});
  function act(text,cls,action){var b=el("button",{cls:"act "+cls,type:"button",text:text});b.onclick=function(){b.disabled=true;api("/api/skipped/"+s.id,{method:"POST",body:JSON.stringify({action:action})}).then(function(){load()})};row.appendChild(b)}
  if(s.status==="skipped"){act("Send anyway","ok","send");act("Dismiss","","dismiss")}
  else if(s.status==="send"||s.status==="dismissed"){act("Undo","","reset")}
  c.appendChild(row);return c}
function load(){api("/api/skipped").then(function(r){return r.json()}).then(function(j){
  var parts=[],tot=0;Object.keys(j.reasons).forEach(function(k){tot+=j.reasons[k];parts.push((j.labels[k]||"No reason given")+": "+j.reasons[k])});
  document.getElementById("why").textContent=tot?"Why you rejected drafts so far \\u2014 "+parts.join(" \\u00b7 "):"No rejected drafts yet. Choosing a reason when you reject builds a picture of what to skip automatically.";
  var box=document.getElementById("list");box.textContent="";
  if(!j.skipped.length)box.appendChild(el("p",{cls:"empty",text:"Nothing skipped yet."}));
  j.skipped.forEach(function(s){box.appendChild(card(s))})}).catch(function(){document.getElementById("list").textContent="Could not load."})}
load();
</script></body></html>`;
