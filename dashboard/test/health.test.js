import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { runCheck, tokenCheck, gatherHealth, alertOnProblems } from "../src/health.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { prepare(sql) { let args = []; const s = {
    bind(...a) { args = a; return s; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; } }; return s; } };
}
const mk = () => ({ DB: makeDb(), MEDIA: {}, API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw" });
const ctx = { waitUntil() {} };
const call = (e, path, init = {}) => worker.fetch(new Request("https://x" + path, init), e, ctx);
const bearer = { authorization: "Bearer tok" };
const basic = { authorization: "Basic " + Buffer.from("x:pw").toString("base64"), "x-requested-with": "review" };

const WED_NOON = new Date("2026-10-21T16:00:00Z");   // Wednesday
const WED_EVE = new Date("2026-10-21T20:00:00Z");
const run = (ok, created, failed = []) => ({ ok, created_at: created, summary: JSON.stringify({ failed, new_leads: 4, drafted: 2 }) });

test("run check: ok, failed, late and missing", () => {
  assert.equal(runCheck(WED_NOON, run(1, "2026-10-21 09:40:00")).status, "ok");
  const bad = runCheck(WED_NOON, run(0, "2026-10-21 09:40:00", ["visual.py"]));
  assert.equal(bad.status, "bad"); assert.match(bad.detail, /visual\.py/);
  assert.equal(runCheck(WED_NOON, run(1, "2026-10-20 09:40:00")).status, "warn");
  assert.equal(runCheck(WED_EVE, run(1, "2026-10-20 09:40:00")).status, "bad");
  assert.equal(runCheck(new Date("2026-10-24T20:00:00Z"), run(1, "2026-10-23 09:40:00")).status, "ok"); // Saturday
  assert.equal(runCheck(WED_EVE, null).status, "warn");
});

test("token expiry warnings", () => {
  const now = WED_NOON.getTime();
  assert.equal(tokenCheck("2026-12-31 00:00:00 UTC", now).status, "ok");
  assert.equal(tokenCheck("2026-11-01 00:00:00 UTC", now).status, "warn");
  assert.equal(tokenCheck("2026-10-23 00:00:00 UTC", now).status, "bad");
  assert.equal(tokenCheck("2026-10-01 00:00:00 UTC", now).status, "bad");
});

const fakeFetch = (map) => async (url) => {
  for (const [k, v] of Object.entries(map)) if (String(url).includes(k)) return v();
  return new Response("{}", { status: 404 });
};

test("live checks flag a failed GitHub run, a bad Instantly key and a bad Meta token", async () => {
  const e = mk();
  Object.assign(e, { GITHUB_DISPATCH_TOKEN: "g", INSTANTLY_API_KEY: "i", INSTANTLY_CAMPAIGN_ID: "c", META_PAGE_ID: "1", META_PAGE_TOKEN: "m" });
  const f = fakeFetch({
    "api.github.com": () => new Response(JSON.stringify({ workflow_runs: [{ name: "Outreach run", status: "completed", conclusion: "failure", created_at: "2026-10-21T09:30:00Z" }] }),
      { headers: { "github-authentication-token-expiration": "2026-12-31 00:00:00 UTC" } }),
    "instantly.ai": () => new Response("{}", { status: 401 }),
    "graph.facebook.com": () => new Response("{}", { status: 400 }),
  });
  const h = await gatherHealth(e, WED_NOON, f);
  const by = Object.fromEntries(h.checks.map((x) => [x.id, x.status]));
  assert.equal(by["gh-Outreach run"], "bad");
  assert.equal(by.instantly, "bad");
  assert.equal(by.meta, "bad");
  assert.equal(by["github-token"], "ok");
  assert.equal(h.status, "bad");
});

test("run reports need the token and appear in health", async () => {
  const e = mk();
  const body = JSON.stringify({ ok: false, failed: ["visual.py"], new_leads: 3, drafted: 1 });
  assert.equal((await call(e, "/api/runs", { method: "POST", body })).status, 401);
  assert.equal((await call(e, "/api/runs", { method: "POST", headers: bearer, body })).status, 200);
  assert.equal((await call(e, "/api/health")).status, 401);
  const h = await (await call(e, "/api/health?fresh=1", { headers: basic })).json();
  assert.equal(h.checks.find((x) => x.id === "run").status, "bad");
  assert.equal((await call(e, "/health", { headers: basic })).status, 200);
});

test("text alert is sent once per new problem", async () => {
  const e = mk();
  await call(e, "/api/runs", { method: "POST", headers: bearer, body: JSON.stringify({ ok: false, failed: ["x"] }) });
  const sent = [];
  await alertOnProblems(e, async (_e, t) => { sent.push(t); });
  await alertOnProblems(e, async (_e, t) => { sent.push(t); });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Outreach run/);
});
