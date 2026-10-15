// Draft review page. The client script avoids template literals so it can live inside this one.
export const REVIEW_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Review drafts</title>
<style>
:root{--bg:#fff;--fg:#1c1b1a;--mut:#6b6762;--card:#f6f4f1;--line:#e4e0da;--acc:#c2410c;--ok:#15803d;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#161514;--fg:#f1eeea;--mut:#a39d95;--card:#201f1d;--line:#34312e;--acc:#fb923c;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px;max-width:900px;margin-inline:auto}
a{color:var(--acc)}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0}
.tab{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 14px;cursor:pointer;font:inherit}
.tab[aria-pressed=true]{border-color:var(--acc);color:var(--acc);font-weight:600}
.sp{flex:1}
button.act{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:8px 14px;cursor:pointer;font:inherit}
button.act.ok{background:var(--ok);border-color:var(--ok);color:#fff}button.act.bad{color:var(--bad)}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button:disabled{opacity:.5;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.card h2{font-size:16px;margin:0}.meta{color:var(--mut);font-size:13px;margin:2px 0 10px}
.find{margin:8px 0;padding:8px 12px;border-left:3px solid var(--acc);background:var(--bg);border-radius:4px;font-size:14px}
label{display:block;font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin:12px 0 4px}
input,textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
textarea{min-height:120px;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.wc{font-size:12px;color:var(--mut);float:right;text-transform:none;letter-spacing:0}
.msg{color:var(--bad);font-size:13px;margin-top:8px}.empty{color:var(--mut);padding:30px 0;text-align:center}
</style></head><body>
<h1>Review drafts</h1>
<p class="sub"><a href="/dashboard">&larr; Dashboard</a> &middot; Edit anything you like, then approve. Approved drafts go into the Instantly CSV with your edits.</p>
<div class="bar" id="bar"></div><div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
var STATUSES=["pending","approved","rejected","exported"], cur="pending", counts={};
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"x-requested-with":"review","content-type":"application/json"},opts.headers||{});return fetch(path,opts)}
function words(t){return t.trim().split(/\\s+/).filter(Boolean).length}
function renderBar(){var bar=document.getElementById("bar");bar.textContent="";
  STATUSES.forEach(function(s){var b=el("button",{cls:"tab",type:"button","aria-pressed":String(s===cur),text:s+" ("+(counts[s]||0)+")"});b.onclick=function(){cur=s;load()};bar.appendChild(b)});
  bar.appendChild(el("span",{cls:"sp"}));
  var ex=el("button",{cls:"act primary",type:"button",text:"Download Instantly CSV ("+(counts.approved||0)+")"});ex.disabled=!(counts.approved>0);
  ex.onclick=function(){ex.disabled=true;api("/api/export/instantly",{method:"POST",body:"{}"}).then(function(r){var n=r.headers.get("x-exported-count");return r.blob().then(function(b){var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="instantly.csv";a.click();alert("Downloaded "+n+" lead(s). They are now marked exported.");load()})})};
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
load();
</script></body></html>`;
