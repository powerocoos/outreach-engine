import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const wrap = (db) => ({ prepare(sql) { let args = []; const s = {
  bind(...a) { args = a; return s; },
  async first() { return db.prepare(sql).get(...args) ?? null; },
  async all() { return { results: db.prepare(sql).all(...args) }; },
  async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; } }; return s; } });

function mk() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { DB: wrap(db), MEDIA: {}, API_TOKEN: "tok", DASHBOARD_PASSWORD: "correct horse battery staple" };
}
const ctx = { waitUntil() {} };
const basic = (pw) => "Basic " + Buffer.from("x:" + pw).toString("base64");
const call = (e, path, headers = {}) => worker.fetch(new Request("https://x" + path, { headers }), e, ctx);

test("pages carry security headers and are never cached", async () => {
  const e = mk();
  const res = await call(e, "/review", { authorization: basic(e.DASHBOARD_PASSWORD) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("strict-transport-security"), /max-age=/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("public prospect pages keep normal caching but still get the other headers", async () => {
  const e = mk();
  const res = await call(e, "/a/" + "a".repeat(32));
  assert.notEqual(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("ten wrong passwords lock that address out, even for the right password", async () => {
  const e = mk();
  const ip = { "cf-connecting-ip": "203.0.113.9" };
  for (let i = 0; i < 10; i++) {
    const r = await call(e, "/api/stats", { ...ip, authorization: basic("guess" + i) });
    assert.equal(r.status, 401, "attempt " + i);
  }
  const locked = await call(e, "/api/stats", { ...ip, authorization: basic(e.DASHBOARD_PASSWORD) });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get("retry-after"), "900");
});

test("a different address is not affected by someone else's failures", async () => {
  const e = mk();
  for (let i = 0; i < 10; i++) await call(e, "/api/stats", { "cf-connecting-ip": "203.0.113.9", authorization: basic("bad" + i) });
  const ok = await call(e, "/api/stats", { "cf-connecting-ip": "198.51.100.4", authorization: basic(e.DASHBOARD_PASSWORD) });
  assert.equal(ok.status, 200);
});

test("the browser's first request with no credentials is not counted, and normal use never locks", async () => {
  const e = mk();
  const ip = { "cf-connecting-ip": "203.0.113.50" };
  for (let i = 0; i < 25; i++) assert.equal((await call(e, "/review", ip)).status, 401);
  for (let i = 0; i < 25; i++) assert.equal((await call(e, "/api/stats", { ...ip, authorization: basic(e.DASHBOARD_PASSWORD) })).status, 200);
});

test("failures older than the window no longer count", async () => {
  const e = mk();
  const old = Math.floor(Date.now() / 1000) - 1000; // outside the 900 s window
  await call(e, "/api/stats", { "cf-connecting-ip": "203.0.113.77", authorization: basic("x") }); // creates the table
  for (let i = 0; i < 10; i++) await e.DB.prepare("INSERT INTO auth_failures (ip, at) VALUES (?, ?)").bind("203.0.113.77", old).run();
  const ok = await call(e, "/api/stats", { "cf-connecting-ip": "203.0.113.77", authorization: basic(e.DASHBOARD_PASSWORD) });
  assert.equal(ok.status, 200);
});

test("machine endpoints with the bearer token are unaffected by the password lockout", async () => {
  const e = mk();
  for (let i = 0; i < 12; i++) await call(e, "/api/stats", { "cf-connecting-ip": "203.0.113.9", authorization: basic("bad" + i) });
  const res = await worker.fetch(new Request("https://x/api/state", { headers: { authorization: "Bearer wrong", "cf-connecting-ip": "203.0.113.9" } }), e, ctx);
  assert.equal(res.status, 401); // rejected by its own token check, not by the lockout
});
