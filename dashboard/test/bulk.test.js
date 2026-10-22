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
const basic = { authorization: "Basic " + Buffer.from("x:pw").toString("base64"), "x-requested-with": "review" };
const d = (n, extra = {}) => ({ company: "C" + n, contact_email: `c${n}@x.com`, subject: "s", email1: "a", email2: "b", email3: "c", ...extra });

test("bulk approve, reject and reset; one bad draft does not stop the rest", async () => {
  const e = mk();
  await call(e, "/api/drafts", { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ drafts: [d(1), d(2), d(3), d(4)] }) });
  await e.DB.prepare("UPDATE drafts SET email2=? WHERE contact_email='c2@x.com'").bind("word ".repeat(200)).run();
  const ids = (await (await call(e, "/api/review?status=pending", { headers: basic })).json()).drafts.map((x) => x.id);
  const bulk = (body, h = basic) => call(e, "/api/review/bulk", { method: "POST", headers: h, body: JSON.stringify(body) });
  assert.equal((await bulk({ action: "approve", ids }, { authorization: basic.authorization })).status, 403);
  assert.equal((await bulk({ action: "approve", ids: [] })).status, 400);
  assert.equal((await bulk({ action: "nope", ids })).status, 400);
  const r = await (await bulk({ action: "approve", ids: ids.slice(0, 3) })).json();
  assert.equal(r.done, 2);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /150 words/);
  assert.equal(r.failed[0].company, "C2");
  const rej = await (await bulk({ action: "reject", ids: [ids[3]], reason: "fit" })).json();
  assert.equal(rej.done, 1);
  const counts = (await (await call(e, "/api/review?status=pending", { headers: basic })).json()).counts;
  assert.equal(counts.approved, 2); assert.equal(counts.rejected, 1); assert.equal(counts.pending, 1);
  assert.equal((await (await call(e, "/api/skipped", { headers: basic })).json()).reasons.fit, 1);
  assert.equal((await (await bulk({ action: "reset", ids: [ids[3]] })).json()).done, 1);
  assert.equal((await call(e, "/api/review/bulk", { method: "POST", body: "{}" })).status, 401);
});
