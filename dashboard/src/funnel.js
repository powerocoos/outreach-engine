// Funnel by trade and town: drafted -> approved -> sent -> viewed page -> replied -> booked.
// Groups come from the draft's category and city; events are matched by contact email.
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";
import { isBot } from "./hot.js";

export const MIN_SAMPLE = 20;

export function buildFunnel(drafts, touches, by) {
  const key = by === "city" ? "city" : "category";
  const group = new Map();
  const ofEmail = new Map();
  const row = (name) => {
    if (!group.has(name)) group.set(name, { name, drafted: 0, approved: 0, rejected: 0, sent: new Set(), viewed: new Set(), replied: new Set(), booked: new Set(), bounced: new Set() });
    return group.get(name);
  };
  for (const d of drafts) {
    const g = row((d[key] || "Unknown").trim() || "Unknown");
    ofEmail.set(d.contact_email, g);
    g.drafted++;
    if (d.status === "approved" || d.status === "exported") g.approved++;
    else if (d.status === "rejected") g.rejected++;
  }
  const field = { sent: "sent", replied: "replied", booked: "booked", bounced: "bounced", audit_viewed: "viewed" };
  for (const t of touches) {
    const g = ofEmail.get(t.contact_email);
    const f = field[t.event];
    if (!g || !f) continue;
    if (f === "viewed" && isBot(t.raw)) continue;
    g[f].add(t.contact_email);
  }
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return [...group.values()].map((g) => ({
    name: g.name, drafted: g.drafted, approved: g.approved, sent: g.sent.size, viewed: g.viewed.size,
    replied: g.replied.size, booked: g.booked.size, bounced: g.bounced.size,
    view_rate: pct(g.viewed.size, g.sent.size), reply_rate: pct(g.replied.size, g.sent.size),
    // Share of reviewed drafts you rejected; drafts still waiting for review do not count either way.
    rejected: g.rejected, reject_rate: pct(g.rejected, g.approved + g.rejected),
    enough: g.sent.size >= MIN_SAMPLE,
  })).sort((a, b) => b.sent - a.sent || b.drafted - a.drafted);
}

export async function handleFunnel(request, env) {
  const by = new URL(request.url).searchParams.get("by") === "city" ? "city" : "category";
  const drafts = (await env.DB.prepare("SELECT contact_email, category, city, status FROM drafts").all()).results;
  const touches = (await env.DB.prepare(
    "SELECT contact_email, event, raw FROM touches WHERE event IN ('sent','replied','booked','bounced','audit_viewed')").all()).results;
  return new Response(JSON.stringify({ by, min_sample: MIN_SAMPLE, rows: buildFunnel(drafts, touches, by) }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const FUNNEL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Funnel</title>
${FONT_LINKS}<style>${BASE_CSS}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;min-width:560px}th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left;white-space:normal}th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.early{color:var(--mut);font-size:12px}.note{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:14px}</style></head><body>
${navHtml("funnel")}
<h1>Funnel</h1>
<p class="sub">How each trade or town moves from draft to reply. Sent, page views, replies and calls are counted per business, not per email.</p>
<div class="bar"><button class="tab" id="b-category" aria-pressed="true" type="button">By trade</button><button class="tab" id="b-city" aria-pressed="false" type="button">By town</button></div>
<div class="note" id="note"></div><div class="wrap" id="tbl"></div>
<script>
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
var by="category";
function p(v){return v===null?"\\u2013":v+"%"}
function load(){
  ["category","city"].forEach(function(k){document.getElementById("b-"+k).setAttribute("aria-pressed",String(k===by))});
  fetch("/api/funnel?by="+by,{headers:{"x-requested-with":"review"}}).then(function(r){return r.json()}).then(function(d){
    var sent=d.rows.reduce(function(a,r){return a+r.sent},0);
    document.getElementById("note").textContent=sent?("Rates are only worth comparing once a group has "+d.min_sample+" or more emails sent. Smaller groups are marked early."):"Nothing sent yet. Drafted, approved and rejected counts are already filling in, and the rest appears once the campaign is launched.";
    var t=el("table"),h=el("tr");
    ["","Drafted","Approved","Rejected","Sent","Viewed page","Replied","Booked","Bounced"].forEach(function(x,i){h.appendChild(el("th",{text:i?x:(by==="city"?"Town":"Trade")}))});
    t.appendChild(h);
    d.rows.forEach(function(r){
      var tr=el("tr"),n=el("td",{text:r.name});if(r.sent&&!r.enough)n.appendChild(el("div",{cls:"early",text:"early: only "+r.sent+" sent"}));tr.appendChild(n);
      [r.drafted,r.approved,p(r.reject_rate),r.sent,r.viewed+(r.view_rate===null?"":" ("+p(r.view_rate)+")"),r.replied+(r.reply_rate===null?"":" ("+p(r.reply_rate)+")"),r.booked,r.bounced].forEach(function(v){tr.appendChild(el("td",{text:String(v)}))});
      t.appendChild(tr)});
    var box=document.getElementById("tbl");box.textContent="";
    if(!d.rows.length)box.appendChild(el("p",{cls:"empty",text:"No drafts yet."}));else box.appendChild(t)});
}
document.getElementById("b-category").onclick=function(){by="category";load()};
document.getElementById("b-city").onclick=function(){by="city";load()};
load();
</script></body></html>`;
