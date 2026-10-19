// Catch-up trigger for the weekday outreach run. GitHub's own schedule is best-effort and often starts hours
// late or skips a day, so this Worker (which runs every 30 minutes) starts the workflow itself when no run
// has begun yet today. Needs the secret GITHUB_DISPATCH_TOKEN (fine-grained token, this repo, Actions: read and write).

const DEFAULT_REPO = "powerocoos/outreach-engine";
const WORKFLOW = "outreach.yml";
const START_AFTER_UTC_MINUTES = 9 * 60 + 20;   // 5:20 AM Eastern (EDT)
const STOP_AFTER_UTC_MINUTES = 18 * 60;        // do not start new runs after 2 PM Eastern (EDT)

export function shouldDispatch(now, runs) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minutes < START_AFTER_UTC_MINUTES || minutes > STOP_AFTER_UTC_MINUTES) return false;
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Any run created today (queued, running or finished, scheduled or manual) counts as "already started".
  return !runs.some((r) => Date.parse(r.created_at) >= startOfDay);
}

export async function kickOutreach(env, now = new Date(), fetchFn = fetch) {
  if (!env.GITHUB_DISPATCH_TOKEN) return "disabled";
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const headers = {
    Authorization: "Bearer " + env.GITHUB_DISPATCH_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "ocoos-outreach-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = "https://api.github.com/repos/" + repo + "/actions/workflows/" + WORKFLOW;
  const res = await fetchFn(base + "/runs?per_page=10", { headers });
  if (!res.ok) return "list failed " + res.status;
  const data = await res.json();
  if (!shouldDispatch(now, data.workflow_runs || [])) return "not needed";
  const d = await fetchFn(base + "/dispatches", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  return d.status === 204 ? "dispatched" : "dispatch failed " + d.status;
}
