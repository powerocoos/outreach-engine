import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

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
const post = (e, path, body, h) => call(e, path, { method: "POST", headers: h, body: JSON.stringify(body) });

test("skipped sites are ingested once and need a login to view", async () => {
  const e = mk();
  const s = { website: "acme.com", company: "Acme", city: "Ocala", polish: 4, findings: ["Old footer year"] };
  assert.equal((await post(e, "/api/skipped", { skipped: [s] }, {})).status, 401);
  assert.equal((await (await post(e, "/api/skipped", { skipped: [s] }, bearer)).json()).added, 1);
  assert.equal((await (await post(e, "/api/skipped", { skipped: [s] }, bearer)).json()).added, 0);
  assert.equal((await call(e, "/api/skipped")).status, 401);
  assert.equal((await call(e, "/skipped")).status, 401);
  const list = await (await call(e, "/api/skipped", { headers: basic })).json();
  assert.equal(list.skipped.length, 1);
  assert.deepEqual(list.skipped[0].findings, ["Old footer year"]);
});

test("send anyway flows to the pipeline and is marked done", async () => {
  const e = mk();
  await post(e, "/api/skipped", { skipped: [{ website: "a.com", company: "A" }, { website: "b.com", company: "B" }] }, bearer);
  const list = await (await call(e, "/api/skipped", { headers: basic })).json();
  const a = list.skipped.find((x) => x.website === "a.com");
  assert.equal((await post(e, `/api/skipped/${a.id}`, { action: "bogus" }, basic)).status, 400);
  assert.equal((await post(e, `/api/skipped/${a.id}`, { action: "send" }, { authorization: basic.authorization })).status, 403);
  assert.equal((await post(e, `/api/skipped/${a.id}`, { action: "send" }, basic)).status, 200);
  assert.deepEqual((await (await call(e, "/api/skipped/overrides", { headers: bearer })).json()).websites, ["a.com"]);
  await post(e, "/api/skipped/done", { websites: ["a.com"] }, bearer);
  assert.deepEqual((await (await call(e, "/api/skipped/overrides", { headers: bearer })).json()).websites, []);
  assert.equal((await post(e, `/api/skipped/${a.id}`, { action: "dismiss" }, basic)).status, 409);
});

test("reject reasons are stored and counted", async () => {
  const e = mk();
  const d = (n) => ({ company: "C" + n, contact_email: `c${n}@x.com`, subject: "s", email1: "a", email2: "b", email3: "c" });
  await post(e, "/api/drafts", { drafts: [d(1), d(2), d(3)] }, bearer);
  const pending = (await (await call(e, "/api/review?status=pending", { headers: basic })).json()).drafts;
  await post(e, `/api/review/${pending[0].id}`, { action: "reject", reason: "polished" }, basic);
  await post(e, `/api/review/${pending[1].id}`, { action: "reject", reason: "not-a-reason" }, basic);
  await post(e, `/api/review/${pending[2].id}`, { action: "reject" }, basic);
  const list = await (await call(e, "/api/skipped", { headers: basic })).json();
  assert.equal(list.reasons.polished, 1);
  assert.equal(list.reasons.none, 2);
  // moving back to pending clears the reason
  await post(e, `/api/review/${pending[0].id}`, { action: "reset" }, basic);
  assert.equal((await (await call(e, "/api/skipped", { headers: basic })).json()).reasons.polished, undefined);
});
