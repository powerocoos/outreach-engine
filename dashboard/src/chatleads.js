// Chat leads: people who talked to the website chatbot (chat.ocooswebconsulting.com) and left their details.
// The chatbot Worker keeps its own D1 database ("website-chatbot"); this dashboard reads it through the
// CHAT_DB binding. If the binding is missing, everything here quietly shows zero.
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const csrfOk = (request) => request.headers.get("x-requested-with") === "review";

// The chatbot's schema.sql creates the table; these add the follow-up columns this page needs.
export const CHAT_MIGRATIONS = [
  "ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new'",
  "ALTER TABLE leads ADD COLUMN handled_at TEXT",
];

const done = new WeakSet();
export async function ensureChatSchema(env) {
  if (!env.CHAT_DB || done.has(env.CHAT_DB)) return;
  for (const sql of CHAT_MIGRATIONS) { try { await env.CHAT_DB.prepare(sql).run(); } catch { /* column already exists */ } }
  done.add(env.CHAT_DB);
}

// Count shown on the menu badge and home page: leads nobody has marked as contacted yet.
export async function chatLeadsWaiting(env) {
  if (!env.CHAT_DB) return 0;
  try {
    await ensureChatSchema(env);
    return (await env.CHAT_DB.prepare("SELECT COUNT(*) n FROM leads WHERE client='ocoos' AND status='new'").first())?.n || 0;
  } catch { return 0; }
}

export async function handleChatLeadsList(env, status) {
  if (!env.CHAT_DB) return json({ configured: false, leads: [], counts: {} });
  await ensureChatSchema(env);
  const st = ["new", "done"].includes(status) ? status : "new";
  const rows = (await env.CHAT_DB.prepare(
    `SELECT id, created_at, name, email, phone, business, summary, transcript, status, handled_at
       FROM leads WHERE client='ocoos' AND status=? ORDER BY id DESC LIMIT 100`).bind(st).all()).results;
  const counts = Object.fromEntries((await env.CHAT_DB.prepare(
    "SELECT status, COUNT(*) n FROM leads WHERE client='ocoos' GROUP BY status").all()).results.map((r) => [r.status, r.n]));
  return json({ configured: true, leads: rows, counts });
}

export async function handleChatLeadAction(request, env, id) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  if (!env.CHAT_DB) return json({ error: "chat database not connected" }, 400);
  await ensureChatSchema(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const row = await env.CHAT_DB.prepare("SELECT id FROM leads WHERE id=? AND client='ocoos'").bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  if (body.action === "done") {
    await env.CHAT_DB.prepare("UPDATE leads SET status='done', handled_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  if (body.action === "reopen") {
    await env.CHAT_DB.prepare("UPDATE leads SET status='new', handled_at=NULL WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  return json({ error: "bad action" }, 400);
}

export const CHAT_LEADS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Chat leads</title>
${FONT_LINKS}<style>${BASE_CSS}
.note{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:14px}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;color:#fff;margin-left:8px;vertical-align:middle;background:var(--ok)}
.row2{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;margin-top:6px}.row2 a{font-weight:500}
.sum{margin:10px 0 0}.theirs{white-space:pre-wrap;border-left:3px solid var(--line);padding:4px 12px;margin:8px 0;font-size:13px;color:var(--mut)}
details{margin-top:10px}summary{cursor:pointer;color:var(--cta);font-size:14px}</style></head><body>
${navHtml("chatleads")}
<h1>Chat leads</h1>
<p class="sub">People who chatted with the website bot and left their details. Follow up by email or phone, then mark them contacted. Nothing is sent from here.</p>
<div class="note" id="note" style="display:none"></div>
<div class="bar"><button class="tab" id="t-new" aria-pressed="true" type="button">To follow up</button><button class="tab" id="t-done" aria-pressed="false" type="button">Contacted</button></div>
<div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"x-requested-with":"review","content-type":"application/json"},opts.headers||{});return fetch(path,opts)}
function fmt(s){var d=new Date(String(s).replace(" ","T").replace(/Z?$/,"Z"));return isNaN(d)?(s||""):d.toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
var cur="new";
function card(l){
  var h=el("h2",{text:l.name});
  if(l.status==="new")h.appendChild(el("span",{cls:"pill",text:"New"}));
  var meta=[fmt(l.created_at)];if(l.business)meta.push(l.business);
  var c=el("div",{cls:"card"},[h,el("div",{cls:"meta",text:meta.join(" \\u00b7 ")})]);
  var row2=el("div",{cls:"row2"});
  if(l.email)row2.appendChild(el("a",{href:"mailto:"+l.email,text:l.email}));
  if(l.phone)row2.appendChild(el("a",{href:"tel:"+l.phone.replace(/[^0-9+]/g,""),text:l.phone}));
  c.appendChild(row2);
  if(l.summary)c.appendChild(el("p",{cls:"sum",text:l.summary}));
  if(l.transcript)c.appendChild(el("details",{},[el("summary",{text:"See the conversation"}),el("div",{cls:"theirs",text:l.transcript})]));
  var row=el("div",{cls:"row"});
  var b=el("button",{cls:"act"+(l.status==="new"?" primary":""),type:"button",text:l.status==="new"?"Mark contacted":"Reopen"});
  b.onclick=function(){b.disabled=true;api("/api/chat-leads/"+l.id,{method:"POST",body:JSON.stringify({action:l.status==="new"?"done":"reopen"})}).then(load,function(){b.disabled=false})};
  row.appendChild(b);c.appendChild(row);return c}
function load(){
  ["new","done"].forEach(function(k){document.getElementById("t-"+k).setAttribute("aria-pressed",String(k===cur))});
  api("/api/chat-leads?status="+cur).then(function(r){return r.json()}).then(function(j){
    var n=document.getElementById("note");
    if(!j.configured){n.style.display="block";n.textContent="The chatbot database is not connected to this dashboard yet."}else n.style.display="none";
    var box=document.getElementById("list");box.textContent="";
    if(!j.leads.length)box.appendChild(el("p",{cls:"empty",text:cur==="new"?"No chat leads waiting.":"Nobody marked contacted yet."}));
    j.leads.forEach(function(l){box.appendChild(card(l))})}).catch(function(){document.getElementById("list").textContent="Could not load."})}
document.getElementById("t-new").onclick=function(){cur="new";load()};
document.getElementById("t-done").onclick=function(){cur="done";load()};
load();
</script></body></html>`;
