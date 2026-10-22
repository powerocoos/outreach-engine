// Reply inbox: prospect replies pulled from Instantly, each with a Claude-suggested answer you can edit and copy.
// Nothing is ever sent from here. You paste the answer into Instantly's inbox (or your mail app) yourself.
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const csrfOk = (request) => request.headers.get("x-requested-with") === "review";

export const REPLIES_DDL = [
  `CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT NOT NULL UNIQUE, thread_id TEXT,
    lead_email TEXT NOT NULL, company TEXT, subject TEXT, body TEXT, received_at TEXT, category TEXT, suggestion TEXT,
    status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  "CREATE INDEX IF NOT EXISTS idx_replies_status ON replies(status)",
];

export const CATEGORIES = ["interested", "question", "not_interested", "unsubscribe", "auto_reply", "other"];

const AUTO_SUBJECT = /^(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status|mail delivery|returned mail|failure notice)/i;
const AUTO_SENDER = /mailer-daemon|postmaster|no-?reply|donotreply/i;

export function isAutomatic(item) {
  return AUTO_SUBJECT.test(String(item.subject || "").trim()) || AUTO_SENDER.test(String(item.from_address_email || ""));
}

// Quoted history makes replies long; keep what the person actually wrote.
export function cleanBody(text) {
  let t = String(text || "").replace(/\r/g, "");
  const cut = t.search(/\n\s*(On .{5,120} wrote:|-{2,}\s*Original Message|From:\s.+\nSent:|_{5,})/i);
  if (cut > 0) t = t.slice(0, cut);
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.slice(0, 2000);
}

export function suggestionPrompt({ company, theirs, ours, findings, booking }) {
  const system = `You draft short replies for Xavier at Ocoos Web Consulting, a small web design company in North Central Florida. He sent a cold email offering a free 15-minute website audit to a local service business, and they replied.
Rules for the reply:
- Plain, warm, human, under 90 words. No bullet lists, no emojis, no sales-speak, no exclamation marks.
- Answer exactly what they asked. Use only facts from the original email or the verified findings given; never invent prices, timelines, results or claims.
- Never promise results (rankings, leads, revenue).
- If they are interested: thank them and offer the free 15-minute website audit call. ${booking ? "Include this booking link once: " + booking : "Ask which day and time works for them this week."}
- If they ask a question you cannot answer from the given facts, say Xavier will look into it and follow up, and ask a clarifying question if useful.
- If they decline, are not interested, or ask to stop: one polite sentence, no pitch, no follow-up ask. For a request to stop, confirm they will not be contacted again.
- If it is an automatic reply, out of office or bounce, write nothing and use the category auto_reply.
- Sign off with "Xavier" on its own line, then "Ocoos Web Consulting".
Return ONLY JSON: {"category": one of ${CATEGORIES.join(" | ")}, "reply": "the reply text, or empty for auto_reply"}.`;
  const user = `Business: ${company}
Verified findings about their site (use only these): ${findings.length ? findings.join(" | ") : "none"}
The email we sent them:
${ours || "(not available)"}

Their reply:
${theirs}`;
  return { system, user };
}

export function parseSuggestion(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const category = CATEGORIES.includes(j.category) ? j.category : "other";
    const reply = typeof j.reply === "string" ? j.reply.trim().slice(0, 1500) : "";
    return { category, reply };
  } catch { return null; }
}

async function suggest(env, row, fetchFn) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const draft = await env.DB.prepare("SELECT email1, findings FROM drafts WHERE contact_email=?").bind(row.lead_email).first();
  let findings = [];
  try { findings = (JSON.parse(draft?.findings || "[]") || []).filter((f) => typeof f === "string" && !/^Private page/.test(f)).slice(0, 8); } catch { /* none */ }
  const { system, user } = suggestionPrompt({ company: row.company || row.lead_email, theirs: row.body, ours: draft?.email1, findings, booking: env.BOOKING_LINK });
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 600, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return parseSuggestion((data.content || []).map((b) => b.text || "").join(""));
}

async function logSync(env, ok, detail) {
  await env.DB.prepare("INSERT INTO run_log (kind, ok, summary) VALUES ('replies_sync', ?, ?)").bind(ok ? 1 : 0, detail).run();
}

// Pull new received emails for the campaign, store them, and draft suggestions (max 5 per call to stay quick).
export async function syncReplies(env, fetchFn = fetch) {
  if (!env.INSTANTLY_API_KEY || !env.INSTANTLY_CAMPAIGN_ID) return { skipped: "Instantly is not configured" };
  const url = `https://api.instantly.ai/api/v2/emails?email_type=received&campaign_id=${encodeURIComponent(env.INSTANTLY_CAMPAIGN_ID)}&limit=50&sort_order=desc`;
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${env.INSTANTLY_API_KEY}` } });
  if (!res.ok) {
    const why = res.status === 401 || res.status === 403 ? "the Instantly API key needs permission to read emails (emails:read)" : `Instantly returned ${res.status}`;
    await logSync(env, false, why);
    return { error: why };
  }
  const items = (await res.json()).items || [];
  let added = 0;
  for (const it of items) {
    if (!it.id || !it.lead) continue;
    const body = cleanBody(it.body?.text || it.content_preview || "");
    if (!body) continue;
    const lead = await env.DB.prepare("SELECT company FROM leads WHERE contact_email=?").bind(String(it.lead).toLowerCase()).first()
      || await env.DB.prepare("SELECT company FROM drafts WHERE contact_email=?").bind(String(it.lead).toLowerCase()).first();
    const auto = isAutomatic(it);
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO replies (email_id, thread_id, lead_email, company, subject, body, received_at, category, status)
       VALUES (?,?,?,?,?,?,?,?,?)`).bind(it.id, it.thread_id || null, String(it.lead).toLowerCase(), lead?.company || null,
      String(it.subject || "").slice(0, 200), body, it.timestamp_email || it.timestamp_created || null, auto ? "auto_reply" : null, auto ? "done" : "new").run();
    added += r.meta?.changes || 0;
  }
  await fillSuggestions(env, fetchFn, 5);
  await logSync(env, true, `${items.length} checked, ${added} new`);
  return { added };
}

export async function fillSuggestions(env, fetchFn = fetch, limit = 5, id = null) {
  if (!env.ANTHROPIC_API_KEY) return 0;
  const rows = id
    ? (await env.DB.prepare("SELECT * FROM replies WHERE id=?").bind(id).all()).results
    : (await env.DB.prepare("SELECT * FROM replies WHERE suggestion IS NULL AND status='new' ORDER BY id LIMIT ?").bind(limit).all()).results;
  let n = 0;
  for (const row of rows) {
    let s = null;
    try { s = await suggest(env, row, fetchFn); } catch { /* try again next time */ }
    if (!s) continue;
    await env.DB.prepare("UPDATE replies SET category=?, suggestion=?, status=CASE WHEN ?='auto_reply' THEN 'done' ELSE status END WHERE id=?")
      .bind(s.category, s.reply, s.category, row.id).run();
    n++;
  }
  return n;
}

export async function handleRepliesList(env, status) {
  const st = ["new", "done"].includes(status) ? status : "new";
  const rows = (await env.DB.prepare("SELECT * FROM replies WHERE status=? ORDER BY id DESC LIMIT 100").bind(st).all()).results;
  const counts = Object.fromEntries((await env.DB.prepare("SELECT status, COUNT(*) n FROM replies GROUP BY status").all()).results.map((r) => [r.status, r.n]));
  const last = await env.DB.prepare("SELECT ok, summary, created_at FROM run_log WHERE kind='replies_sync' ORDER BY id DESC LIMIT 1").first();
  return json({ replies: rows, counts, ai: !!env.ANTHROPIC_API_KEY, configured: !!(env.INSTANTLY_API_KEY && env.INSTANTLY_CAMPAIGN_ID),
    sync: last ? { ok: !!last.ok, detail: last.summary, at: last.created_at } : null });
}

export async function handleRepliesSync(request, env) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  const r = await syncReplies(env).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
  return json(r);
}

export async function handleReplyAction(request, env, id) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const row = await env.DB.prepare("SELECT id FROM replies WHERE id=?").bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  if (body.action === "done" || body.action === "reopen") {
    await env.DB.prepare("UPDATE replies SET status=? WHERE id=?").bind(body.action === "done" ? "done" : "new", id).run();
    return json({ ok: true });
  }
  if (body.action === "regenerate") {
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Add the ANTHROPIC_API_KEY secret to the Worker to get suggested answers" }, 400);
    await env.DB.prepare("UPDATE replies SET suggestion=NULL WHERE id=?").bind(id).run();
    const n = await fillSuggestions(env, fetch, 1, id);
    return n ? json({ ok: true }) : json({ error: "Could not draft an answer right now. Try again." }, 502);
  }
  return json({ error: "bad action" }, 400);
}

export const REPLIES_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Replies</title>
${FONT_LINKS}<style>${BASE_CSS}
.note{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:14px}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;color:#fff;background:var(--mut);margin-left:8px;vertical-align:middle}
.pill.interested{background:var(--ok)}.pill.question{background:var(--cta)}.pill.unsubscribe{background:var(--bad)}
.theirs{white-space:pre-wrap;border-left:3px solid var(--line);padding:4px 12px;margin:8px 0;color:var(--fg)}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}</style></head><body>
${navHtml("replies")}
<h1>Replies</h1>
<p class="sub">Replies to your outreach, each with a suggested answer. Edit it, copy it, and paste it into Instantly or your mail app. Nothing is sent from here.</p>
<div class="note" id="note"></div>
<div class="bar"><button class="tab" id="t-new" aria-pressed="true" type="button">To answer</button><button class="tab" id="t-done" aria-pressed="false" type="button">Done</button><span class="sp"></span><button class="act" id="sync" type="button">Check for replies</button></div>
<div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"x-requested-with":"review","content-type":"application/json"},opts.headers||{});return fetch(path,opts)}
var cur="new",ai=true;
var LABEL={interested:"Interested",question:"Question",not_interested:"Not interested",unsubscribe:"Wants to stop",auto_reply:"Automatic",other:"Other"};
function fmt(s){var d=new Date(String(s).replace(" ","T").replace(/Z?$/,"Z"));return isNaN(d)?(s||""):d.toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
function card(r){
  var h=el("h2",{text:r.company||r.lead_email});if(r.category)h.appendChild(el("span",{cls:"pill "+r.category,text:LABEL[r.category]||r.category}));
  var c=el("div",{cls:"card"},[h,el("div",{cls:"meta",text:[r.lead_email,fmt(r.received_at),r.subject].filter(Boolean).join(" \\u00b7 ")}),el("div",{cls:"theirs",text:r.body})]);
  var ta=el("textarea",{"aria-label":"Suggested answer"});ta.value=r.suggestion||"";
  if(r.suggestion===null||r.suggestion===undefined){c.appendChild(el("p",{cls:"meta",text:ai?"Drafting a suggested answer\\u2026 it appears after the next check.":"Add the ANTHROPIC_API_KEY secret to the Worker to get suggested answers."}))}
  else if(r.suggestion===""){c.appendChild(el("p",{cls:"meta",text:"No answer needed."}))}
  else{c.appendChild(el("label",{text:"Suggested answer (edit before sending)"}));c.appendChild(ta)}
  var msg=el("span",{cls:"meta"});var row=el("div",{cls:"row"});
  function b(t,cls,fn){var x=el("button",{cls:"act "+cls,type:"button",text:t});x.onclick=fn;row.appendChild(x);return x}
  if(r.suggestion){b("Copy answer","primary",function(){ta.select();var done=function(){msg.textContent="Copied."};if(navigator.clipboard)navigator.clipboard.writeText(ta.value).then(done,function(){document.execCommand("copy");done()});else{document.execCommand("copy");done()}})}
  row.appendChild(el("a",{href:"https://app.instantly.ai/app/unibox",target:"_blank",rel:"noopener noreferrer",text:"Open Instantly inbox",style:"align-self:center"}));
  if(r.status==="new"){if(ai)b("New suggestion","",function(){msg.textContent="Working\\u2026";api("/api/replies/"+r.id,{method:"POST",body:JSON.stringify({action:"regenerate"})}).then(function(x){return x.json()}).then(function(j){if(j.error)msg.textContent=j.error;else load()})});b("Mark done","ok",function(){api("/api/replies/"+r.id,{method:"POST",body:JSON.stringify({action:"done"})}).then(load)})}
  else b("Reopen","",function(){api("/api/replies/"+r.id,{method:"POST",body:JSON.stringify({action:"reopen"})}).then(load)});
  row.appendChild(msg);c.appendChild(row);return c}
function load(){
  ["new","done"].forEach(function(k){document.getElementById("t-"+k).setAttribute("aria-pressed",String(k===cur))});
  api("/api/replies?status="+cur).then(function(r){return r.json()}).then(function(j){
    ai=j.ai;var n=document.getElementById("note");
    n.textContent=!j.configured?"Instantly is not connected yet.":j.sync&&!j.sync.ok?"Could not check for replies: "+j.sync.detail+".":!j.ai?"Replies are listed, but suggested answers need the ANTHROPIC_API_KEY secret on the Worker.":j.sync?"Last checked "+fmt(j.sync.at)+" ("+j.sync.detail+"). Replies are checked every 30 minutes.":"Replies are checked every 30 minutes. Use Check for replies to look now.";
    var box=document.getElementById("list");box.textContent="";
    if(!j.replies.length)box.appendChild(el("p",{cls:"empty",text:cur==="new"?"No replies waiting. Nice and quiet.":"Nothing marked done yet."}));
    j.replies.forEach(function(r){box.appendChild(card(r))})}).catch(function(){document.getElementById("list").textContent="Could not load."})}
document.getElementById("t-new").onclick=function(){cur="new";load()};
document.getElementById("t-done").onclick=function(){cur="done";load()};
document.getElementById("sync").onclick=function(){var s=this;s.disabled=true;api("/api/replies/sync",{method:"POST",body:"{}"}).then(function(){s.disabled=false;load()},function(){s.disabled=false})};
load();
</script></body></html>`;
