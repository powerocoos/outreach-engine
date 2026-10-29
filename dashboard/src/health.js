// Run health: did the outreach run happen and succeed, and are the keys that keep things running still good?
// The pipeline reports each run to POST /api/runs; the rest is checked live (GitHub, Instantly, Meta, failed posts).
import { safeEqual } from "./logic.js";
import { BASE_CSS, FONT_LINKS, navHtml } from "./review_page.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const bearerOk = (request, env) => safeEqual((request.headers.get("authorization") || "").replace(/^Bearer /, ""), env.API_TOKEN);

export const HEALTH_DDL = [
  `CREATE TABLE IF NOT EXISTS run_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 1,
    summary TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
];

export async function handleRunReport(request, env) {
  if (!bearerOk(request, env)) return json({ error: "unauthorized" }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const summary = JSON.stringify({
    failed: (Array.isArray(b.failed) ? b.failed : []).slice(0, 10).map((x) => String(x).slice(0, 200)),
    new_leads: Number(b.new_leads) || 0, drafted: Number(b.drafted) || 0, targets: String(b.targets || "").slice(0, 400),
  });
  await env.DB.prepare("INSERT INTO run_log (kind, ok, summary) VALUES ('outreach', ?, ?)").bind(b.ok ? 1 : 0, summary).run();
  return json({ ok: true });
}

const c = (id, label, status, detail) => ({ id, label, status, detail });

// Weekday expectations are in UTC like kick.js: the run is due from 9:20, and a missing run is a problem after 18:00.
export function runCheck(now, last) {
  const sqlTime = (s) => Date.parse(String(s).replace(" ", "T") + "Z");
  const fmtAgo = (t) => { const h = Math.round((now - t) / 3600000); return h < 1 ? "under an hour ago" : h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`; };
  if (last) {
    let s = {}; try { s = JSON.parse(last.summary) || {}; } catch { /* keep empty */ }
    const when = sqlTime(last.created_at);
    if (!last.ok) return c("run", "Outreach run", "bad", `Last run (${fmtAgo(when)}) had problems: ${(s.failed || []).join(", ") || "see the GitHub run log"}.`);
    const day = now.getUTCDay(), minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const weekday = day >= 1 && day <= 5;
    if (weekday && when < startOfDay && minutes > 18 * 60) return c("run", "Outreach run", "bad", `No run today. The last good run was ${fmtAgo(when)}.`);
    if (weekday && when < startOfDay && minutes > 9 * 60 + 20) return c("run", "Outreach run", "warn", `Not started yet today. The catch-up trigger should start it. Last good run ${fmtAgo(when)}.`);
    return c("run", "Outreach run", "ok", `Last run ${fmtAgo(when)}: ${s.new_leads ?? 0} new leads, ${s.drafted ?? 0} drafts.`);
  }
  return c("run", "Outreach run", "warn", "No run has reported in yet. This fills in after the next run.");
}

export function tokenCheck(headerValue, now) {
  if (!headerValue) return c("github-token", "GitHub token", "ok", "No expiry date reported.");
  const t = Date.parse(headerValue.replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isNaN(t)) return c("github-token", "GitHub token", "ok", "Expiry date not readable.");
  const days = Math.floor((t - now) / 86400000);
  const when = new Date(t).toISOString().slice(0, 10);
  if (days < 0) return c("github-token", "GitHub token", "bad", `Expired on ${when}. The catch-up trigger is off until it is renewed.`);
  if (days <= 3) return c("github-token", "GitHub token", "bad", `Expires in ${days} day(s), on ${when}. Renew it now.`);
  if (days <= 14) return c("github-token", "GitHub token", "warn", `Expires in ${days} days, on ${when}. Renew it soon.`);
  return c("github-token", "GitHub token", "ok", `Good until ${when} (${days} days).`);
}

export async function gatherHealth(env, now = new Date(), fetchFn = fetch) {
  const checks = [];
  const last = await env.DB.prepare("SELECT ok, summary, created_at FROM run_log WHERE kind='outreach' ORDER BY id DESC LIMIT 1").first();
  checks.push(runCheck(now, last));

  if (env.GITHUB_DISPATCH_TOKEN) {
    try {
      const repo = env.GITHUB_REPO || "powerocoos/outreach-engine";
      const res = await fetchFn(`https://api.github.com/repos/${repo}/actions/runs?per_page=10`, { headers: {
        Authorization: "Bearer " + env.GITHUB_DISPATCH_TOKEN, Accept: "application/vnd.github+json", "User-Agent": "ocoos-outreach-dashboard" } });
      if (res.status === 401) checks.push(c("github-token", "GitHub token", "bad", "GitHub rejected the token (expired or revoked). The catch-up trigger is off until it is renewed."));
      else if (!res.ok) checks.push(c("github", "GitHub", "warn", `Could not read GitHub runs (${res.status}).`));
      else {
        checks.push(tokenCheck(res.headers.get("github-authentication-token-expiration"), now.getTime()));
        const runs = (await res.json()).workflow_runs || [];
        for (const name of ["Outreach run", "Social drafts"]) {
          const latest = runs.find((r) => r.name === name && r.status === "completed");
          if (!latest) continue;
          const bad = ["failure", "timed_out", "startup_failure"].includes(latest.conclusion);
          checks.push(c("gh-" + name, `GitHub: ${name}`, bad ? "bad" : "ok", bad ? `Latest run ${latest.conclusion} (${String(latest.created_at).slice(0, 10)}).` : `Latest run succeeded (${String(latest.created_at).slice(0, 10)}).`));
        }
      }
    } catch { checks.push(c("github", "GitHub", "warn", "Could not reach GitHub.")); }
  } else {
    checks.push(c("github-token", "GitHub token", "warn", "Not set, so the catch-up trigger is off and late GitHub runs will not be rescued."));
  }

  if (env.INSTANTLY_API_KEY && env.INSTANTLY_CAMPAIGN_ID) {
    try {
      const r = await fetchFn(`https://api.instantly.ai/api/v2/campaigns/${env.INSTANTLY_CAMPAIGN_ID}`, { headers: { authorization: `Bearer ${env.INSTANTLY_API_KEY}` } });
      checks.push(r.ok ? c("instantly", "Instantly", "ok", "Connected.") : c("instantly", "Instantly", "bad", r.status === 402 ? "Instantly returned 402 (payment required). Check the plan or billing in Instantly; the key is probably fine." : `Instantly returned ${r.status}. The API key may be wrong or revoked.`));
    } catch { checks.push(c("instantly", "Instantly", "warn", "Could not reach Instantly.")); }
  }

  if (env.INSTANTLY_API_KEY && env.INSTANTLY_CAMPAIGN_ID) {
    const sync = await env.DB.prepare("SELECT ok, summary FROM run_log WHERE kind='replies_sync' ORDER BY id DESC LIMIT 1").first();
    if (sync && !sync.ok) checks.push(c("replies", "Reply inbox", "bad", `Could not check for replies: ${sync.summary}.`));
    else if (!env.ANTHROPIC_API_KEY) checks.push(c("replies", "Reply inbox", "warn", "Suggested answers are off: add the ANTHROPIC_API_KEY secret to the Worker."));
    else checks.push(c("replies", "Reply inbox", "ok", sync ? `Last check: ${sync.summary}.` : "Waiting for the first check."));
  }

  if (env.META_PAGE_ID && env.META_PAGE_TOKEN) {
    try {
      const r = await fetchFn(`https://graph.facebook.com/${env.META_GRAPH_VERSION || "v23.0"}/${env.META_PAGE_ID}?fields=name`, { headers: { authorization: `Bearer ${env.META_PAGE_TOKEN}` } });
      checks.push(r.ok ? c("meta", "Facebook and Instagram", "ok", "Connected.") : c("meta", "Facebook and Instagram", "bad", `Meta returned ${r.status}. The token may have expired.`));
    } catch { checks.push(c("meta", "Facebook and Instagram", "warn", "Could not reach Meta.")); }
  }
  try {
    const n = (await env.DB.prepare("SELECT COUNT(*) n FROM social_posts WHERE status='approved' AND error IS NOT NULL AND error!='' AND attempts>=3").first())?.n || 0;
    if (n) checks.push(c("social-fail", "Social posts", "bad", `${n} approved post(s) failed to publish. Open Social posts to see the error.`));
  } catch { /* table may not exist yet */ }

  const worst = checks.some((x) => x.status === "bad") ? "bad" : checks.some((x) => x.status === "warn") ? "warn" : "ok";
  return { status: worst, checks };
}

let cache = { at: 0, data: null };
export async function handleHealth(request, env) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (!fresh && cache.data && Date.now() - cache.at < 600000) return json(cache.data);
  cache = { at: Date.now(), data: await gatherHealth(env) };
  return json(cache.data);
}

// Called from the 30-minute cron: text once when a new problem appears (no-op without Twilio secrets).
export async function alertOnProblems(env, sendSms) {
  const h = await gatherHealth(env);
  const sig = h.checks.filter((x) => x.status === "bad").map((x) => x.id).sort().join(",");
  const prev = (await env.DB.prepare("SELECT summary FROM run_log WHERE kind='alert' ORDER BY id DESC LIMIT 1").first())?.summary || "";
  if (sig === prev) return;
  await env.DB.prepare("INSERT INTO run_log (kind, ok, summary) VALUES ('alert', ?, ?)").bind(sig ? 0 : 1, sig).run();
  if (sig) await sendSms(env, "Ocoos dashboard problem: " + h.checks.filter((x) => x.status === "bad").map((x) => x.label).join(", "));
}

export const HEALTH_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Health</title>
${FONT_LINKS}<style>${BASE_CSS}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:var(--ok)}.dot.warn{background:#d97706}.dot.bad{background:var(--bad)}</style></head><body>
${navHtml("dashboard")}
<h1>Run health</h1>
<p class="sub">Whether the daily run happened, and whether the keys behind it still work. A red or amber bar shows at the top of every dashboard page when something needs attention.</p>
<div class="bar"><button class="act" id="re" type="button">Check again</button> <button class="act" id="sms" type="button">Send a test text</button> <span class="meta" id="smsr"></span></div><div id="list"><p class="empty">Checking&hellip;</p></div>
<script>
function el(t,a,k){var e=document.createElement(t);for(var x in (a||{})){if(x==="text")e.textContent=a[x];else if(x==="cls")e.className=a[x];else e.setAttribute(x,a[x]);}(k||[]).forEach(function(c){e.appendChild(c)});return e}
function load(){fetch("/api/health?fresh=1",{headers:{"x-requested-with":"review"}}).then(function(r){return r.json()}).then(function(d){
  var box=document.getElementById("list");box.textContent="";
  d.checks.forEach(function(c){var h=el("h2",{},[el("span",{cls:"dot "+c.status}),document.createTextNode(c.label)]);box.appendChild(el("div",{cls:"card"},[h,el("div",{cls:"meta",text:c.detail})]))})}).catch(function(){document.getElementById("list").textContent="Could not load."})}
document.getElementById("re").onclick=load;
document.getElementById("sms").onclick=function(){var o=document.getElementById("smsr");o.textContent="Sending\u2026";fetch("/api/test-sms",{method:"POST",headers:{"x-requested-with":"review"}}).then(function(r){return r.json()}).then(function(d){o.textContent=d.ok?"Sent. Check your phone.":(d.error||"Failed")}).catch(function(){o.textContent="Could not reach the dashboard."})};
load();
</script></body></html>`;
