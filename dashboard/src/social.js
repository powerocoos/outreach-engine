// Social posts: blog posts from the Squarespace RSS feed -> drafted Facebook/Instagram captions ->
// review here -> publish through the Meta Graph API (or copy by hand when it is not connected).
import { safeEqual } from "./logic.js";
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";

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
    scheduled_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, posted_at TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_social_status ON social_posts(status)",
];
// Tables created before scheduling existed need the columns added once (errors = already there).
export const SOCIAL_MIGRATIONS = [
  "ALTER TABLE social_posts ADD COLUMN scheduled_at TEXT",
  "ALTER TABLE social_posts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
];

// ---- Scheduling (Eastern Time) ---------------------------------------------------
const TZ = "America/New_York";
const SLOT_HOUR = "09:00";
const MAX_ATTEMPTS = 3;
const nowIso = (d = new Date()) => d.toISOString().slice(0, 19) + "Z";

function etParts(date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return o;
}

// "2026-10-16T09:00" typed in Eastern Time -> "2026-10-16T13:00:00Z" (null if not a real time).
export function easternToUtc(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || "");
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  const w = new Date(want);
  if (w.getUTCFullYear() !== y || w.getUTCMonth() !== mo - 1 || w.getUTCDate() !== d || w.getUTCHours() !== h || w.getUTCMinutes() !== mi) return null;
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(guess));
    const diff = want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    if (!diff) break;
    guess += diff;
  }
  const p = etParts(new Date(guess));
  if (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) !== want) return null;
  return nowIso(new Date(guess));
}

// UTC ISO -> { local: "2026-10-16T09:00", label: "Fri, Oct 16, 9:00 AM ET", date: "2026-10-16" }
export function utcToEastern(iso) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return null;
  const date = new Date(t), p = etParts(date);
  const label = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit" }).format(date) + " ET";
  return { local: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, label, date: `${p.year}-${p.month}-${p.day}` };
}

// The next 9:00 AM Eastern that is still ahead and on a day with nothing else scheduled.
export function nextSlot(takenDates, now = new Date()) {
  let { year, month, day } = etParts(now);
  let cursor = Date.UTC(+year, +month - 1, +day);
  for (let i = 0; i < 90; i++, cursor += 86400000) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    const at = easternToUtc(`${date}T${SLOT_HOUR}`);
    if (at && Date.parse(at) > now.getTime() + 5 * 60000 && !takenDates.has(date)) return at;
  }
  return null;
}

async function takenDates(env, exceptId = 0) {
  const rows = (await env.DB.prepare(
    "SELECT scheduled_at FROM social_posts WHERE status='approved' AND scheduled_at IS NOT NULL AND id<>?").bind(exceptId).all()).results;
  return new Set(rows.map((r) => utcToEastern(r.scheduled_at)?.date).filter(Boolean));
}

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
    const when = utcToEastern(r.scheduled_at);
    return { ...r, categories, ig_ok: igImageOk(r.image_url), scheduled_local: when?.local || "", scheduled_label: when?.label || "" };
  });
  const slot = nextSlot(await takenDates(env));
  return json({ counts, posts, connected: configured(env), next_slot_label: slot ? utcToEastern(slot).label : "" });
}

const ACTIONS = ["save", "approve", "reject", "reset", "publish", "mark_posted", "schedule"];

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

  if (body.action === "schedule") {
    if (p.status !== "approved") return json({ error: "approve it first" }, 409);
    let at = null;
    if (body.scheduled_local) {
      at = easternToUtc(body.scheduled_local);
      if (!at) return json({ error: "that is not a valid date and time" }, 422);
      if (Date.parse(at) < Date.now() - 60000) return json({ error: "that time has already passed" }, 422);
    }
    await env.DB.prepare("UPDATE social_posts SET scheduled_at=?, attempts=0, error=NULL WHERE id=?").bind(at, id).run();
    return json({ ok: true, scheduled_at: at, label: at ? utcToEastern(at).label : null });
  }
  if (body.action === "publish") {
    await env.DB.prepare("UPDATE social_posts SET attempts=0 WHERE id=?").bind(id).run();
    return publish(env, { ...p }, body.channel);
  }
  if (body.action === "mark_posted") {
    if (p.status !== "approved") return json({ error: "approve it first" }, 409);
    await env.DB.prepare("UPDATE social_posts SET status='posted', posted_at=CURRENT_TIMESTAMP, error=NULL WHERE id=?").bind(id).run();
    return json({ ok: true, status: "posted" });
  }
  const status = { approve: "approved", reject: "rejected", reset: "pending", save: p.status }[body.action];
  if (body.action !== "save") {
    // Approving books the next free 9:00 AM Eastern slot (change or clear it on the card); anything else clears it.
    let at = null;
    if (body.action === "approve") {
      const slot = nextSlot(await takenDates(env, id));
      at = p.scheduled_at || slot;
    }
    await env.DB.prepare("UPDATE social_posts SET status=?, decided_at=CURRENT_TIMESTAMP, scheduled_at=?, attempts=0 WHERE id=?").bind(status, at, id).run();
  }
  return json({ ok: true, status });
}

// Posts to the chosen channel(s). A channel that already has an id is skipped, so pressing Publish twice
// (or retrying after one channel failed) can never post the same thing twice.
async function publish(env, p, channel) {
  if (p.status !== "approved") return json({ error: "approve it first" }, 409);
  const conn = configured(env);
  const want = Array.isArray(channel) ? channel : channel === "both" ? ["facebook", "instagram"] : [channel];
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
${navHtml("social")}
<h1>Social posts</h1>
<p class="sub">New blog posts are turned into a Facebook caption and an Instagram caption. Edit, approve, then publish.</p>
<div class="note" id="conn"></div><div class="bar" id="bar"></div><div id="list"><p class="empty">Loading&hellip;</p></div>
<script>
var STATUSES=["pending","approved","posted","rejected"], cur="pending", counts={}, connected={}, nextSlot="";
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
  if(p.status==="pending"){row.appendChild(btn("Approve","ok","approve",1));row.appendChild(btn("Save edits","","save",0));row.appendChild(btn("Reject","bad","reject",1));
    if((connected.facebook||connected.instagram)&&nextSlot)c.appendChild(el("div",{cls:"ids",text:"Approving books this post for "+nextSlot+". You can change or clear the time after approving."}))}
  else if(p.status==="approved"){
    if(connected.facebook||connected.instagram){
      c.appendChild(el("div",{cls:"find",text:p.scheduled_label?"Scheduled to post automatically: "+p.scheduled_label:"Not scheduled. It will only post when you click Publish."}));
      var dt=el("input",{type:"datetime-local"});dt.value=p.scheduled_local||"";
      var sr=el("div",{cls:"row"});
      var sv=el("button",{cls:"act ok",type:"button",text:"Save schedule"});sv.onclick=function(){send("schedule",{scheduled_local:dt.value}).then(function(x){if(x.ok)load()})};
      var cl=el("button",{cls:"act",type:"button",text:"Do not auto-post"});cl.onclick=function(){send("schedule",{scheduled_local:""}).then(function(x){if(x.ok)load()})};
      c.appendChild(el("label",{text:"Publish at (Eastern Time)"}));c.appendChild(dt);sr.appendChild(sv);sr.appendChild(cl);c.appendChild(sr)}
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
function load(){api("/api/social?status="+cur).then(function(r){return r.json()}).then(function(j){counts=j.counts;connected=j.connected||{};nextSlot=j.next_slot_label||"";renderBar();var list=document.getElementById("list");list.textContent="";
  if(!j.posts.length)list.appendChild(el("p",{cls:"empty",text:"Nothing here."}));
  j.posts.forEach(function(p){list.appendChild(card(p))})}).catch(function(e){document.getElementById("list").textContent="Failed to load: "+e})}
load();
</script></body></html>`;

// ---- Generated post cards (JPEG) -----------------------------------------------
// The pipeline renders a branded card when a blog post has no JPEG Instagram can use.
// Upload (bearer): PUT /api/social-image/<32 hex>   Public: GET /img/social/<32 hex>.jpg
const IMG_MAX = 5 * 1024 * 1024;

export async function handleSocialImagePut(request, env, token) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  if ((request.headers.get("content-type") || "") !== "image/jpeg") return json({ error: "image/jpeg only" }, 415);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > IMG_MAX) return json({ error: "image must be 1 byte to 5 MB" }, 413);
  const head = new Uint8Array(bytes.slice(0, 3));
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return json({ error: "not a JPEG" }, 415);
  await env.MEDIA.put(`social/${token}.jpg`, bytes, { httpMetadata: { contentType: "image/jpeg" } });
  return json({ ok: true, path: `/img/social/${token}.jpg` });
}

export async function handleSocialImageGet(env, token) {
  const obj = await env.MEDIA.get(`social/${token}.jpg`);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
}

// Cron: post anything whose scheduled time has arrived. Only channels that can take the post are tried, each
// channel posts at most once, and after MAX_ATTEMPTS failures it stops and shows the error on the card.
export async function publishDue(env, now = new Date()) {
  const conn = configured(env);
  if (!conn.facebook && !conn.instagram) return 0;
  const due = (await env.DB.prepare(
    "SELECT * FROM social_posts WHERE status='approved' AND scheduled_at IS NOT NULL AND scheduled_at<=? AND attempts<? ORDER BY scheduled_at LIMIT 3"
  ).bind(nowIso(now), MAX_ATTEMPTS).all()).results;
  let n = 0;
  for (const p of due) {
    const channels = [];
    if (conn.facebook && !p.fb_post_id) channels.push("facebook");
    if (conn.instagram && !p.ig_post_id && igImageOk(p.image_url)) channels.push("instagram");
    if (!channels.length) {
      if (p.fb_post_id || p.ig_post_id) await env.DB.prepare("UPDATE social_posts SET status='posted', posted_at=CURRENT_TIMESTAMP, error=NULL WHERE id=?").bind(p.id).run();
      continue;
    }
    await publish(env, { ...p }, channels);
    const after = await env.DB.prepare("SELECT status FROM social_posts WHERE id=?").bind(p.id).first();
    if (after?.status !== "posted") await env.DB.prepare("UPDATE social_posts SET attempts=attempts+1 WHERE id=?").bind(p.id).run();
    n++;
  }
  return n;
}
