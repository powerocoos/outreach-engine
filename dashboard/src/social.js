// Social posts: blog posts from the Squarespace RSS feed -> drafted Facebook/Instagram captions ->
// review here -> publish through the Meta Graph API (or copy by hand when it is not connected).
import { safeEqual } from "./logic.js";
import { BASE_CSS, FONT_LINKS, LOGO_HTML } from "./review_page.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bearerOk = (request, env) =>
  safeEqual((request.headers.get("authorization") || "").replace(/^Bearer /, ""), env.API_TOKEN);
const csrfOk = (request) => request.headers.get("x-requested-with") === "review";

export const SOCIAL_STATUSES = ["pending", "approved", "posted", "rejected"];
export const SOCIAL_DDL = [
  `CREATE TABLE IF NOT EXISTS social_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, post_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, summary TEXT, image_url TEXT, categories TEXT, pub_date TEXT, link TEXT,
    fb_text TEXT NOT NULL, ig_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    fb_post_id TEXT, ig_post_id TEXT, error TEXT, edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, posted_at TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_social_status ON social_posts(status)",
];

const FB_MAX = 3000;
const IG_MAX = 2200;
const isHttps = (u) => typeof u === "string" && /^https:\/\/[^\s]+$/.test(u);

// A post can only go to Instagram when its image is a JPEG (Instagram rejects PNG and WebP).
export const igImageOk = (url) => isHttps(url) && /\.jpe?g(\?|$)/i.test(url);

export function socialProblems(p) {
  const out = [];
  if (!p.fb_text || !p.fb_text.trim()) out.push("Facebook text is empty");
  else if (p.fb_text.length > FB_MAX) out.push("Facebook text is too long");
  if (!p.ig_text || !p.ig_text.trim()) out.push("Instagram caption is empty");
  else {
    if (p.ig_text.length > IG_MAX) out.push("Instagram caption is over 2,200 characters");
    if ((p.ig_text.match(/#\w+/g) || []).length > 30) out.push("Instagram allows at most 30 hashtags");
  }
  return out;
}

const configured = (env) => ({
  facebook: !!(env.META_PAGE_ID && env.META_PAGE_TOKEN),
  instagram: !!(env.META_IG_USER_ID && env.META_PAGE_TOKEN),
});

// ---- Meta Graph API ------------------------------------------------------------
// The Graph version is a variable because Meta retires old versions; bump META_GRAPH_VERSION if calls start failing.
const graph = (env, path) => `https://graph.facebook.com/${env.META_GRAPH_VERSION || "v23.0"}/${path}`;

async function graphCall(env, path, params, method = "POST") {
  const body = new URLSearchParams({ ...params, access_token: env.META_PAGE_TOKEN });
  const url = method === "GET" ? graph(env, path) + "?" + body : graph(env, path);
  const res = await fetch(url, method === "GET" ? {} : { method, body });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || data.error) {
    throw new Error((data.error && (data.error.message || data.error.type)) || `Meta API ${res.status}`);
  }
  return data;
}

export async function publishFacebook(env, post) {
  const data = await graphCall(env, `${env.META_PAGE_ID}/feed`, { message: post.fb_text, link: post.link || post.post_url });
  return data.id;
}

export async function publishInstagram(env, post, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  if (!igImageOk(post.image_url)) throw new Error("Instagram needs a JPEG image and this post's image is not one");
  const made = await graphCall(env, `${env.META_IG_USER_ID}/media`, { image_url: post.image_url, caption: post.ig_text });
  // Instagram prepares the image first; publishing before it is FINISHED fails.
  for (let i = 0; i < 6; i++) {
    const st = await graphCall(env, made.id, { fields: "status_code" }, "GET");
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("Instagram could not process the image");
    if (i === 5) throw new Error("Instagram is still processing the image; try Publish again in a minute");
    await sleep(2000);
  }
  const pub = await graphCall(env, `${env.META_IG_USER_ID}/media_publish`, { creation_id: made.id });
  return pub.id;
}

// ---- HTTP handlers -------------------------------------------------------------
export async function handleSocialIngest(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  let added = 0, skipped = 0;
  for (const p of (body.posts || []).slice(0, 50)) {
    const bad = !isHttps(p.post_url) || !p.title || socialProblems(p).length || (p.image_url && !isHttps(p.image_url));
    if (bad) { skipped++; continue; }
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO social_posts (post_url, title, summary, image_url, categories, pub_date, link, fb_text, ig_text)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(p.post_url, String(p.title).slice(0, 300), p.summary ? String(p.summary).slice(0, 1000) : null,
           p.image_url || null, JSON.stringify(Array.isArray(p.categories) ? p.categories : []),
           p.pub_date || null, isHttps(p.link) ? p.link : p.post_url, p.fb_text, p.ig_text).run();
    if (r.meta.changes) added++; else skipped++;
  }
  return json({ ok: true, added, skipped });
}

// The pipeline asks which posts are already here so it does not pay to draft them again.
export async function handleSocialKnown(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  const rows = (await env.DB.prepare("SELECT post_url FROM social_posts").all()).results;
  return json({ urls: rows.map((r) => r.post_url) });
}

export async function handleSocialList(request, env) {
  const status = new URL(request.url).searchParams.get("status") || "pending";
  if (!SOCIAL_STATUSES.includes(status)) return json({ error: "bad status" }, 400);
  const counts = Object.fromEntries(SOCIAL_STATUSES.map((s) => [s, 0]));
  for (const r of (await env.DB.prepare("SELECT status, COUNT(*) n FROM social_posts GROUP BY status").all()).results) {
    counts[r.status] = r.n;
  }
  const rows = (await env.DB.prepare("SELECT * FROM social_posts WHERE status=? ORDER BY id DESC LIMIT 50").bind(status).all()).results;
  const posts = rows.map((r) => {
    let categories = [];
    try { categories = JSON.parse(r.categories) || []; } catch { /* keep empty */ }
    return { ...r, categories, ig_ok: igImageOk(r.image_url) };
  });
  return json({ counts, posts, connected: configured(env) });
}

const ACTIONS = ["save", "approve", "reject", "reset", "publish", "mark_posted"];

export async function handleSocialAction(request, env, id) {
  if (!csrfOk(request)) return json({ error: "missing header" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!ACTIONS.includes(body.action)) return json({ error: "bad action" }, 400);
  const p = await env.DB.prepare("SELECT * FROM social_posts WHERE id=?").bind(id).first();
  if (!p) return json({ error: "not found" }, 404);

  const next = { fb_text: p.fb_text, ig_text: p.ig_text };
  let edited = p.edited;
  if (["save", "approve"].includes(body.action)) {
    for (const k of Object.keys(next)) {
      if (typeof body[k] === "string" && body[k] !== p[k]) { next[k] = body[k]; edited = 1; }
    }
    if (body.action === "approve") {
      const problems = socialProblems(next);
      if (problems.length) return json({ error: problems.join("; ") }, 422);
    }
    await env.DB.prepare("UPDATE social_posts SET fb_text=?, ig_text=?, edited=? WHERE id=?")
      .bind(next.fb_text, next.ig_text, edited, id).run();
  }

  if (body.action === "publish") return publish(env, { ...p }, body.channel);
  if (body.action === "mark_posted") {
    if (p.status !== "approved") return json({ error: "approve it first" }, 409);
    await env.DB.prepare("UPDATE social_posts SET status='posted', posted_at=CURRENT_TIMESTAMP, error=NULL WHERE id=?").bind(id).run();
    return json({ ok: true, status: "posted" });
  }
  const status = { approve: "approved", reject: "rejected", reset: "pending", save: p.status }[body.action];
  if (body.action !== "save") {
    await env.DB.prepare("UPDATE social_posts SET status=?, decided_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, id).run();
  }
  return json({ ok: true, status });
}

// Posts to the chosen channel(s). A channel that already has an id is skipped, so pressing Publish twice
// (or retrying after one channel failed) can never post the same thing twice.
async function publish(env, p, channel) {
  if (p.status !== "approved") return json({ error: "approve it first" }, 409);
  const conn = configured(env);
  const want = channel === "both" ? ["facebook", "instagram"] : [channel];
  if (!want.every((c) => c === "facebook" || c === "instagram")) return json({ error: "bad channel" }, 400);
  const results = {}, errors = [];
  for (const c of want) {
    if (!conn[c]) { errors.push(`${c} is not connected`); continue; }
    if (c === "facebook" && p.fb_post_id) { results.facebook = p.fb_post_id; continue; }
    if (c === "instagram" && p.ig_post_id) { results.instagram = p.ig_post_id; continue; }
    try {
      const pid = c === "facebook" ? await publishFacebook(env, p) : await publishInstagram(env, p);
      results[c] = pid;
      await env.DB.prepare(`UPDATE social_posts SET ${c === "facebook" ? "fb_post_id" : "ig_post_id"}=? WHERE id=?`).bind(pid, p.id).run();
      p[c === "facebook" ? "fb_post_id" : "ig_post_id"] = pid;
    } catch (e) {
      errors.push(`${c}: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  // Fully posted once every connected channel that can take this post has an id.
  const done = (!conn.facebook || p.fb_post_id) && (!conn.instagram || p.ig_post_id || !igImageOk(p.image_url));
  const anyPosted = !!(p.fb_post_id || p.ig_post_id);
  await env.DB.prepare(
    "UPDATE social_posts SET error=?, status=?, posted_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE posted_at END WHERE id=?"
  ).bind(errors.join("; ") || null, done && anyPosted && !errors.length ? "posted" : "approved", done && anyPosted && !errors.length ? 1 : 0, p.id).run();
  return json({ ok: !errors.length, results, errors, status: done && anyPosted && !errors.length ? "posted" : "approved" }, errors.length && !Object.keys(results).length ? 502 : 200);
}

// ---- Page ----------------------------------------------------------------------
// Client script avoids template literals and ${ so it can sit inside this one.
export const SOCIAL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Social posts</title>
${FONT_LINKS}<style>${BASE_CSS}
.thumb{width:100%;max-height:220px;object-fit:cover;border-radius:12px;margin:8px 0}.ids{color:var(--mut);font-size:13px;margin-top:8px}.note{background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin:0 0 14px;font-size:14px}</style></head><body>
${LOGO_HTML}
<h1>Social posts</h1>
<p class="sub">New blog posts are turned into a Facebook caption and an Instagram caption. Edit, approve, then publish.</p>
<div class="note" id="conn"></div><div class="bar" id="bar"></div><div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
var STATUSES=["pending","approved","posted","rejected"], cur="pending", counts={}, connected={};
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"x-requested-with":"review","content-type":"application/json"},opts.headers||{});return fetch(path,opts)}
function field(label,node,max){var l=el("label",{text:label});var w=el("span",{cls:"wc"});l.appendChild(w);var u=function(){w.textContent=node.value.length+" / "+max+" characters"};node.addEventListener("input",u);u();return [l,node]}
function renderBar(){var bar=document.getElementById("bar");bar.textContent="";
  STATUSES.forEach(function(s){var b=el("button",{cls:"tab",type:"button","aria-pressed":String(s===cur),text:s+" ("+(counts[s]||0)+")"});b.onclick=function(){cur=s;load()};bar.appendChild(b)});
  var c=document.getElementById("conn");
  if(connected.facebook||connected.instagram){c.textContent="Connected: "+[connected.facebook?"Facebook":null,connected.instagram?"Instagram":null].filter(Boolean).join(" and ")+". Publish posts straight from here."}
  else{c.textContent="Facebook and Instagram are not connected yet, so approved posts show Copy buttons to paste into Meta Business Suite. Once the Meta secrets are added, a Publish button appears."}}
function card(p){
  var c=el("div",{cls:"card"});c.appendChild(el("h2",{text:p.title}));
  var m=el("div",{cls:"meta"});m.appendChild(document.createTextNode((p.categories||[]).join(", ")+(p.pub_date?" \\u00b7 "+p.pub_date.slice(0,16)+" \\u00b7 ":" \\u00b7 ")));
  m.appendChild(el("a",{href:p.post_url,target:"_blank",rel:"noopener noreferrer",text:"view blog post"}));c.appendChild(m);
  if(p.image_url){c.appendChild(el("img",{cls:"thumb",src:p.image_url,alt:""}))}
  var fb=el("textarea",{}),ig=el("textarea",{});fb.value=p.fb_text;ig.value=p.ig_text;
  field("Facebook",fb,3000).concat(field("Instagram",ig,2200)).forEach(function(n){c.appendChild(n)});
  if(!p.ig_ok)c.appendChild(el("div",{cls:"msg",text:"Instagram can only take a JPEG image and this post does not have one, so post it to Facebook only or add a JPEG image in Squarespace."}));
  var msg=el("div",{cls:"msg"});
  function send(action,extra){msg.textContent="";msg.style.color="";return api("/api/social/"+p.id,{method:"POST",body:JSON.stringify(Object.assign({action:action,fb_text:fb.value,ig_text:ig.value},extra||{}))}).then(function(r){return r.json().then(function(j){if(!r.ok||(j.errors&&j.errors.length)){msg.textContent=(j.errors&&j.errors.join("; "))||j.error||"Something went wrong"}return {ok:r.ok&&!(j.errors&&j.errors.length),j:j}})})}
  var row=el("div",{cls:"row"});
  function btn(text,cls,action,reload,extra){var b=el("button",{cls:"act "+cls,type:"button",text:text});b.onclick=function(){b.disabled=true;send(action,extra).then(function(x){b.disabled=false;if(x.ok||reload==="always"){if(reload)load();else{msg.style.color="var(--ok)";msg.textContent="Saved"}}})};return b}
  function copyBtn(text,get){var b=el("button",{cls:"act",type:"button",text:text});b.onclick=function(){navigator.clipboard.writeText(get()).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent=text},1500)})};return b}
  if(p.status==="pending"){row.appendChild(btn("Approve","ok","approve",1));row.appendChild(btn("Save edits","","save",0));row.appendChild(btn("Reject","bad","reject",1))}
  else if(p.status==="approved"){
    if(connected.facebook&&connected.instagram&&p.ig_ok)row.appendChild(btn("Publish to both","primary","publish","always",{channel:"both"}));
    if(connected.facebook)row.appendChild(btn("Publish to Facebook"+(p.fb_post_id?" (done)":""),"primary","publish","always",{channel:"facebook"}));
    if(connected.instagram&&p.ig_ok)row.appendChild(btn("Publish to Instagram"+(p.ig_post_id?" (done)":""),"primary","publish","always",{channel:"instagram"}));
    row.appendChild(copyBtn("Copy Facebook text",function(){return fb.value+"\\n\\n"+(p.link||p.post_url)}));
    row.appendChild(copyBtn("Copy Instagram caption",function(){return ig.value}));
    row.appendChild(btn("Save edits","","save",0));row.appendChild(btn("Mark as posted","ok","mark_posted",1));row.appendChild(btn("Move back to pending","","reset",1))}
  else if(p.status==="rejected"){row.appendChild(btn("Move back to pending","","reset",1))}
  c.appendChild(row);c.appendChild(msg);
  if(p.error){c.appendChild(el("div",{cls:"msg",text:"Last attempt: "+p.error}))}
  if(p.fb_post_id||p.ig_post_id){c.appendChild(el("div",{cls:"ids",text:"Posted"+(p.fb_post_id?" \\u00b7 Facebook "+p.fb_post_id:"")+(p.ig_post_id?" \\u00b7 Instagram "+p.ig_post_id:"")}))}
  return c}
function load(){api("/api/social?status="+cur).then(function(r){return r.json()}).then(function(j){counts=j.counts;connected=j.connected||{};renderBar();var list=document.getElementById("list");list.textContent="";
  if(!j.posts.length)list.appendChild(el("p",{cls:"empty",text:"Nothing here."}));
  j.posts.forEach(function(p){list.appendChild(card(p))})}).catch(function(e){document.getElementById("list").textContent="Failed to load: "+e})}
load();
</script></body></html>`;
