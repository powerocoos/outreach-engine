// Hot leads: which prospects opened their private screenshot page (/a/<token>), and how often.
// Views from link scanners and from the owner are ignored so the counts mean a real person looked.
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";

const BOT_RE = /bot|crawl|spider|scan|preview|fetch|monitor|curl|wget|python|java\/|go-http|headless|phantom|slurp|proofpoint|mimecast|barracuda|symantec|safelinks|microsoft office|outlook-ios-preview|googleimageproxy|google-read-aloud|facebookexternalhit|whatsapp|slack|skype|telegram|discord|linkedin|twitter|pinterest|http-client|okhttp|axios|node-fetch|libwww|apache-httpclient/i;

export const OWNER_COOKIE = "ocoos_owner";

export function isBot(ua) {
  const s = String(ua || "").trim();
  if (!s) return true;
  return BOT_RE.test(s);
}

export function hasOwnerCookie(request) {
  return new RegExp(`(?:^|;\\s*)${OWNER_COOKIE}=1(?:;|$)`).test(request.headers.get("cookie") || "");
}

export const ownerCookieHeader = () =>
  `${OWNER_COOKIE}=1; Max-Age=31536000; Path=/a; Secure; HttpOnly; SameSite=Lax`;

// views: [{created_at, raw}] oldest first. Returns people-looking views only.
export function realViews(views) {
  return views.filter((v) => !isBot(v.raw));
}

export function heat(views) {
  const days = new Set(views.map((v) => String(v.created_at).slice(0, 10)));
  if (views.length >= 2 || days.size >= 2) return "hot";
  return views.length === 1 ? "warm" : "none";
}

export function alertTextForView(company, count) {
  return count > 1
    ? `${company} opened their audit page again (${count} views). Good time to follow up.`
    : `${company} just opened their audit page.`;
}

export async function hotLeads(env) {
  const rows = (await env.DB.prepare(
    `SELECT t.contact_email e, t.raw ua, t.created_at ts
       FROM touches t WHERE t.event='audit_viewed' ORDER BY t.created_at ASC, t.id ASC`).all()).results;
  const byEmail = new Map();
  for (const r of rows) {
    if (isBot(r.ua)) continue;
    if (!byEmail.has(r.e)) byEmail.set(r.e, []);
    byEmail.get(r.e).push({ created_at: r.ts, raw: r.ua });
  }
  const out = [];
  for (const [email, views] of byEmail) {
    const page = await env.DB.prepare(
      "SELECT token, company, website FROM audit_pages WHERE contact_email=? ORDER BY created_at DESC LIMIT 1").bind(email).first();
    const lead = await env.DB.prepare("SELECT id, company, phone, status FROM leads WHERE contact_email=?").bind(email).first();
    const replied = await env.DB.prepare("SELECT 1 x FROM touches WHERE contact_email=? AND event IN ('replied','booked')").bind(email).first();
    out.push({
      company: page?.company || lead?.company || "Unknown",
      website: page?.website || null,
      phone: lead?.phone || null,
      token: page?.token || null,
      views: views.length,
      days: new Set(views.map((v) => String(v.created_at).slice(0, 10))).size,
      first: views[0].created_at,
      last: views[views.length - 1].created_at,
      heat: heat(views),
      replied: !!replied,
    });
  }
  out.sort((a, b) => (a.heat === b.heat ? String(b.last).localeCompare(String(a.last)) : a.heat === "hot" ? -1 : 1));
  return out;
}

export async function handleHotList(env) {
  const out = await hotLeads(env);
  return new Response(JSON.stringify({ leads: out }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export const HOT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Hot leads</title>
${FONT_LINKS}<style>${BASE_CSS}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;color:#fff;margin-left:8px;vertical-align:middle}
.pill.hot{background:var(--bad)}.pill.warm{background:var(--cta)}.pill.new{background:var(--ok)}
.row2{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--mut);font-size:13px}
.row2 a{font-weight:500}</style></head><body>
${navHtml("hot")}
<h1>Hot leads</h1>
<p class="sub">Prospects who opened their private screenshot page. Link scanners and your own views are left out. Two or more views, or views on different days, count as hot: a good moment for a personal follow-up.</p>
<div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function fmt(s){var d=new Date(String(s).replace(" ","T")+"Z");return isNaN(d)?s:d.toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}
var seen=0;try{seen=Number(localStorage.getItem("hotSeen")||0)}catch(e){}
fetch("/api/hot",{headers:{"x-requested-with":"review"}}).then(function(r){return r.json()}).then(function(d){
  var box=document.getElementById("list");box.textContent="";
  if(!d.leads.length){box.appendChild(el("p",{cls:"empty",text:"No views yet. When a prospect opens their private page it shows up here."}));return}
  var newest=0;
  d.leads.forEach(function(l){
    var t=new Date(String(l.last).replace(" ","T")+"Z").getTime()||0;if(t>newest)newest=t;
    var h=el("h2",{text:l.company});
    h.appendChild(el("span",{cls:"pill "+l.heat,text:l.heat==="hot"?"Hot":"Warm"}));
    if(t>seen)h.appendChild(el("span",{cls:"pill new",text:"New"}));
    var meta=[l.views+(l.views===1?" view":" views"),"last "+fmt(l.last)];
    if(l.views>1)meta.push("first "+fmt(l.first));
    if(l.replied)meta.push("replied");
    var row=el("div",{cls:"row2"},[el("span",{text:meta.join(" \\u00b7 ")})]);
    if(l.phone)row.appendChild(el("a",{href:"tel:"+l.phone,text:l.phone}));
    if(l.website)row.appendChild(el("span",{text:l.website}));
    if(l.token)row.appendChild(el("a",{href:"/a/"+l.token,target:"_blank",rel:"noopener",text:"Open their page"}));
    box.appendChild(el("div",{cls:"card"},[h,row]));
  });
  try{localStorage.setItem("hotSeen",String(newest))}catch(e){}
}).catch(function(){document.getElementById("list").textContent="Could not load."});
</script></body></html>`;
