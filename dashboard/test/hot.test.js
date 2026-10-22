import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { isBot, heat } from "../src/hot.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { prepare(sql) { let args = []; const s = {
    bind(...a) { args = a; return s; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; } }; return s; } };
}
const MEDIA = { async put() {}, async get() { return null; } };
const mk = () => ({ DB: makeDb(), MEDIA, API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw" });
const ctx = { waitUntil() {} };
const call = (e, path, init = {}) => worker.fetch(new Request("https://x" + path, init), e, ctx);
const basic = { authorization: "Basic " + Buffer.from("x:pw").toString("base64") };
const T = "c".repeat(32);
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1";

async function seed(e) {
  await call(e, `/api/audit/${T}`, { method: "PUT", headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ email: "a@acme.com", company: "Acme AC", website: "acme.com", findings: [{ text: "x" }] }) });
}

test("bot detection and heat", () => {
  assert.ok(isBot(""));
  assert.ok(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)"));
  assert.ok(isBot("python-requests/2.31"));
  assert.ok(!isBot(PHONE));
  assert.equal(heat([{ created_at: "2026-10-21 10:00:00" }]), "warm");
  assert.equal(heat([{ created_at: "2026-10-21 10:00:00" }, { created_at: "2026-10-21 10:05:00" }]), "hot");
});

test("hot list ignores scanners and the owner, and ranks repeat viewers first", async () => {
  const e = mk(); await seed(e);
  await call(e, `/a/${T}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; Proofpoint Scanner)" } });
  await call(e, `/a/${T}`, { headers: { "user-agent": PHONE, cookie: "ocoos_owner=1" } });
  let list = await (await call(e, "/api/hot", { headers: basic })).json();
  assert.equal(list.leads.length, 0);
  await call(e, `/a/${T}`, { headers: { "user-agent": PHONE } });
  list = await (await call(e, "/api/hot", { headers: basic })).json();
  assert.equal(list.leads.length, 1);
  assert.equal(list.leads[0].heat, "warm");
  assert.equal(list.leads[0].views, 1);
  await call(e, `/a/${T}`, { headers: { "user-agent": PHONE } });
  list = await (await call(e, "/api/hot", { headers: basic })).json();
  assert.equal(list.leads[0].heat, "hot");
  assert.equal(list.leads[0].company, "Acme AC");
});

test("hot page needs login and sets the owner cookie", async () => {
  const e = mk();
  assert.equal((await call(e, "/hot")).status, 401);
  assert.equal((await call(e, "/api/hot")).status, 401);
  const r = await call(e, "/hot", { headers: basic });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /ocoos_owner=1/);
  assert.ok((await r.text()).includes("Hot leads"));
});

test("text alert goes out on the first real view only", async () => {
  const e = mk(); await seed(e);
  Object.assign(e, { TWILIO_SID: "s", TWILIO_TOKEN: "t", TWILIO_FROM: "+1", ALERT_PHONE: "+2" });
  const bodies = []; const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { bodies.push(String(o.body)); return new Response("{}"); };
  const pending = []; const c2 = { waitUntil: (p) => pending.push(p) };
  const go = (ua) => worker.fetch(new Request(`https://x/a/${T}`, { headers: { "user-agent": ua } }), e, c2);
  try {
    await go("Googlebot"); await go(PHONE); await go(PHONE);
    await Promise.all(pending);
  } finally { globalThis.fetch = real; }
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Acme\+AC/);
});
