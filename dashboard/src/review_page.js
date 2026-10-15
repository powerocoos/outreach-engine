// Shared look for the review pages.
export const NAV_CSS = `.top{display:flex;align-items:center;gap:14px;position:relative;padding-bottom:16px;margin-bottom:20px;border-bottom:1px solid var(--line)}.top img{height:44px;width:auto}@media(prefers-color-scheme:dark){.top img{background:#fff;border-radius:8px;padding:4px 8px}}
.links{display:flex;gap:8px;align-items:center;margin-left:auto}.links a{color:var(--cta);border:1px solid var(--cta);text-decoration:none;border-radius:999px;padding:8px 18px;font-weight:500;font-size:14px;white-space:nowrap}.links a[aria-current=page]{background:var(--cta);color:#fff}
.menu-btn{display:none;margin-left:auto;align-items:center;justify-content:center;width:48px;height:48px;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:12px;font-size:24px;line-height:1;cursor:pointer}
@media(max-width:640px){.menu-btn{display:inline-flex}.links{display:none;position:absolute;top:100%;left:0;right:0;margin:8px 0 0;flex-direction:column;align-items:stretch;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:8px;box-shadow:0 8px 24px rgba(17,24,39,.18);z-index:20}.links.open{display:flex}.links a{border:0;border-radius:12px;padding:14px 16px;font-size:16px}.links a:not([aria-current=page]):active{background:var(--soft)}}`;
export const MOBILE_CSS = `@media(max-width:640px){body{padding:16px 12px}h1{font-size:21px}.card{padding:16px;border-radius:16px}.row{gap:8px}.row button.act{flex:1 1 calc(50% - 8px);min-height:46px;padding:10px 12px}.row button.act.primary{flex:1 1 100%}.bar{gap:8px}.bar .tab{flex:1 1 calc(50% - 8px);min-height:44px;text-align:center}input,textarea,select{font-size:16px}.camp{border-radius:16px}}`;
export function navHtml(active) {
  const link = (href, id, text) => `<a href="${href}"${active === id ? ' aria-current="page"' : ""}>${text}</a>`;
  return `<div class="top"><img src="https://images.squarespace-cdn.com/content/v1/5dc50cc1afeeeb552425247c/d8489d11-b4c0-4699-abf0-75e870088b4f/Ocoos+Web+Consulting+Logo+01+-+smaller-min.png?format=500w" alt="Ocoos Web Consulting"><button class="menu-btn" id="menu-btn" type="button" aria-label="Menu" aria-expanded="false" aria-controls="nav-links">&#9776;</button><nav class="links" id="nav-links">${link("/dashboard", "dashboard", "Dashboard")}${link("/review", "review", "Review drafts")}${link("/social", "social", "Social posts")}</nav></div><script>(function(){var b=document.getElementById("menu-btn"),l=document.getElementById("nav-links");b.onclick=function(){var o=l.classList.toggle("open");b.setAttribute("aria-expanded",String(o))}})()</script>`;
}
export const BASE_CSS = `
:root{--bg:#fff;--fg:#111827;--mut:#4b5563;--card:#fff;--line:#e5e7eb;--soft:#f3f4f6;--acc:#155387;--cta:#0066cc;--ok:#15803d;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#0f1720;--fg:#f3f4f6;--mut:#9ca3af;--card:#16212d;--line:#243242;--soft:#1b2836;--acc:#7cb7ee;--cta:#3b8fe0;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:300 15px/1.6 'Poppins',system-ui,sans-serif;padding:24px 16px;max-width:900px;margin-inline:auto}
a{color:var(--cta)}h1{font-size:24px;font-weight:700;color:var(--acc);margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}
.tab{border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:999px;padding:6px 14px;cursor:pointer;font:inherit}
.tab[aria-pressed=true]{border-color:var(--cta);background:var(--cta);color:#fff;font-weight:500}
.sp{flex:1}
button.act{border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:6px;padding:8px 16px;cursor:pointer;font:inherit;font-weight:500}
button.act.ok{background:var(--ok);border-color:var(--ok);color:#fff}button.act.bad{color:var(--bad)}
button.primary{background:var(--cta);border-color:var(--cta);color:#fff}
button:disabled{opacity:.5;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;margin:14px 0;box-shadow:0 1px 3px rgba(17,24,39,.06)}
.card h2{font-size:17px;font-weight:600;color:var(--acc);margin:0}.meta{color:var(--mut);font-size:13px;margin:2px 0 10px}
.find{margin:8px 0;padding:8px 12px;border-left:3px solid var(--cta);background:var(--soft);border-radius:6px;font-size:14px}
label{display:block;font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin:12px 0 4px}
input,textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font:inherit}
textarea{min-height:120px;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.wc{font-size:12px;color:var(--mut);float:right;text-transform:none;letter-spacing:0}
.camp{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:var(--soft);border:1px solid var(--line);border-radius:20px;padding:12px 16px;margin:0 0 16px}.camp b{color:var(--acc)}.pill{border-radius:999px;padding:2px 12px;font-size:13px;font-weight:500;background:var(--line)}.pill.on{background:var(--ok);color:#fff}.pill.warn{background:var(--bad);color:#fff}
.msg{color:var(--bad);font-size:13px;margin-top:8px}.empty{color:var(--mut);padding:30px 0;text-align:center}
${NAV_CSS}${MOBILE_CSS}`;
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">`;

// Draft review page. The client script avoids template literals so it can live inside this one.
export const REVIEW_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Review drafts</title>
${FONT_LINKS}<style>${BASE_CSS}</style></head><body>
${navHtml("review")}
<h1>Review drafts</h1>
<p class="sub">Edit anything you like, then approve. Approved drafts go into the Instantly CSV with your edits.</p>
<div class="camp" id="camp"></div><div class="bar" id="bar"></div><div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
var STATUSES=["pending","approved","rejected","exported"], cur="pending", counts={};
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"x-requested-with":"review","content-type":"application/json"},opts.headers||{});return fetch(path,opts)}
function words(t){return t.trim().split(/\\s+/).filter(Boolean).length}
function renderBar(){var bar=document.getElementById("bar");bar.textContent="";
  STATUSES.forEach(function(s){var b=el("button",{cls:"tab",type:"button","aria-pressed":String(s===cur),text:s+" ("+(counts[s]||0)+")"});b.onclick=function(){cur=s;load()};bar.appendChild(b)});
  bar.appendChild(el("span",{cls:"sp"}));
  var ex=el("button",{cls:"act primary",type:"button",text:"Download CSV ("+(counts.approved||0)+")"});ex.disabled=!(counts.approved>0);
  ex.onclick=function(){ex.disabled=true;api("/api/export/instantly",{method:"POST",body:"{}"}).then(function(r){var n=r.headers.get("x-exported-count");return r.blob().then(function(b){var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="instantly.csv";a.click();alert("Downloaded "+n+" lead(s). They are now marked exported.");load()})})};
  var sb=el("button",{cls:"act primary",type:"button",text:"Send to Instantly ("+(counts.approved||0)+")"});sb.disabled=!(counts.approved>0);
  sb.onclick=function(){if(!confirm("Add "+(counts.approved||0)+" approved lead(s) to the Instantly campaign? Nothing is emailed until you launch the campaign in Instantly."))return;sb.disabled=true;api("/api/send/instantly",{method:"POST",body:"{}"}).then(function(r){return r.json()}).then(function(j){if(j.error){alert(j.error)}else{alert("Added "+j.sent+" lead(s) to Instantly."+(j.failed&&j.failed.length?" Failed: "+j.failed.map(function(f){return f.company+" ("+f.error+")"}).join(", "):""))}load()}).catch(function(e){alert("Failed: "+e);load()})};
  bar.appendChild(sb);
  bar.appendChild(ex)}
function field(label,node,wcFor){var l=el("label",{text:label});if(wcFor){var w=el("span",{cls:"wc"});l.appendChild(w);var u=function(){w.textContent=words(node.value)+" words"};node.addEventListener("input",u);u()}return [l,node]}
function card(d){
  var c=el("div",{cls:"card"});
  c.appendChild(el("h2",{text:d.company}));
  var meta=[d.contact_email,d.city,d.rating?d.rating+"\\u2605 ("+d.review_count+" reviews)":null].filter(Boolean).join(" \\u00b7 ");
  var m=el("div",{cls:"meta"});m.appendChild(document.createTextNode(meta+" \\u00b7 "));
  if(d.website&&/^https?:\\/\\//.test(d.website)){var a=el("a",{href:d.website,target:"_blank",rel:"noopener noreferrer",text:"website"});m.appendChild(a)}
  c.appendChild(m);
  (d.findings||[]).forEach(function(f){c.appendChild(el("div",{cls:"find",text:f}))});
  var subj=el("input",{type:"text",value:d.subject});
  var e1=el("textarea",{}),e2=el("textarea",{}),e3=el("textarea",{});e1.value=d.email1;e2.value=d.email2;e3.value=d.email3;
  field("Subject",subj).concat(field("Email 1 (day 1)",e1,1),field("Email 2 (day 4)",e2,1),field("Email 3 (day 8)",e3,1)).forEach(function(n){c.appendChild(n)});
  var msg=el("div",{cls:"msg"});
  function send(action){msg.textContent="";return api("/api/review/"+d.id,{method:"POST",body:JSON.stringify({action:action,subject:subj.value,email1:e1.value,email2:e2.value,email3:e3.value})}).then(function(r){return r.json().then(function(j){if(!r.ok){msg.textContent=j.error||"Something went wrong";return false}return true})})}
  var row=el("div",{cls:"row"});
  function btn(text,cls,action,reload){var b=el("button",{cls:"act "+cls,type:"button",text:text});b.onclick=function(){b.disabled=true;send(action).then(function(ok){b.disabled=false;if(ok){if(reload)load();else{msg.style.color="var(--ok)";msg.textContent="Saved"}}})};return b}
  if(d.status==="pending"){row.appendChild(btn("Approve","ok","approve",1));row.appendChild(btn("Save edits","","save",0));row.appendChild(btn("Reject","bad","reject",1))}
  else if(d.status==="approved"){row.appendChild(btn("Save edits","","save",0));row.appendChild(btn("Move back to pending","","reset",1))}
  else if(d.status==="rejected"){row.appendChild(btn("Move back to pending","","reset",1))}
  c.appendChild(row);c.appendChild(msg);return c}
function load(){api("/api/review?status="+cur).then(function(r){return r.json()}).then(function(j){counts=j.counts;renderBar();var list=document.getElementById("list");list.textContent="";
  if(!j.drafts.length)list.appendChild(el("p",{cls:"empty",text:"Nothing here."}));
  j.drafts.forEach(function(d){list.appendChild(card(d))})}).catch(function(e){document.getElementById("list").textContent="Failed to load: "+e})}
function loadCamp(){var box=document.getElementById("camp");api("/api/campaign").then(function(r){return r.json()}).then(function(c){box.textContent="";
  if(!c.configured){box.textContent="Instantly is not connected yet.";return}
  if(c.error){box.textContent="Campaign status unavailable: "+c.error;return}
  box.appendChild(el("b",{text:c.name||"Campaign"}));
  box.appendChild(el("span",{cls:"pill"+(c.status===1?" on":(c.status<0?" warn":"")),text:c.label}));
  if(c.daily_limit)box.appendChild(el("span",{text:c.daily_limit+" emails/day max"}));
  box.appendChild(el("span",{cls:"sp"}));
  var sy=el("button",{cls:"act",type:"button",text:"Refresh stats"});sy.onclick=function(){sy.disabled=true;api("/api/sync/instantly",{method:"POST",body:"{}"}).then(function(r){return r.json()}).then(function(j){alert(j.error?j.error:j.skipped?j.skipped:("Checked "+j.leadsSeen+" lead(s), "+j.added+" new event(s)."));sy.disabled=false}).catch(function(e){alert("Failed: "+e);sy.disabled=false})};box.appendChild(sy);
  function act(path,body){return api(path,{method:"POST",body:JSON.stringify(body||{})}).then(function(r){return r.json()}).then(function(j){if(j.error)alert(j.error);loadCamp()})}
  if(c.status===1){var p=el("button",{cls:"act bad",type:"button",text:"Pause campaign"});p.onclick=function(){p.disabled=true;act("/api/campaign/pause")};box.appendChild(p)}
  else if(c.status===0||c.status===2){var l=el("button",{cls:"act primary",type:"button",text:c.status===0?"Launch campaign":"Resume campaign"});
    l.onclick=function(){var t=prompt("This starts sending real emails to everyone in the campaign"+(c.daily_limit?" (up to "+c.daily_limit+" per day)":"")+". Make sure mailbox warm-up has had about 2 weeks and you have reviewed the first drafts.\\n\\nType LAUNCH to confirm.");if(t!=="LAUNCH")return;l.disabled=true;act("/api/campaign/launch",{confirm:"LAUNCH"})};box.appendChild(l)}
  }).catch(function(){box.textContent="Campaign status unavailable"})}
load();loadCamp();
</script></body></html>`;
