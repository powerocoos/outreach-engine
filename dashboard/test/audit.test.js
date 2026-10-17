import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      };
      return stmt;
    },
  };
}
const store = new Map();
const MEDIA = {
  async put(k, v) { store.set(k, v); },
  async get(k) { return store.has(k) ? { body: store.get(k) } : null; },
};
const env = () => ({ DB: makeDb(), MEDIA, API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw" });
const ctx = { waitUntil() {} };
const call = (e, path, init = {}) => worker.fetch(new Request("https://x" + path, init), e, ctx);
const T = "a".repeat(32);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const authed = { authorization: "Bearer tok" };

test("uploads need the bearer token and a real JPEG", async () => {
  const e = env();
  assert.equal((await call(e, `/api/audit/${T}/mobile.jpg`, { method: "PUT", body: JPEG, headers: { "content-type": "image/jpeg" } })).status, 401);
  assert.equal((await call(e, `/api/audit/${T}/mobile.jpg`, { method: "PUT", body: "nope", headers: { ...authed, "content-type": "image/jpeg" } })).status, 415);
  assert.equal((await call(e, `/api/audit/${T}/mobile.jpg`, { method: "PUT", body: JPEG, headers: { ...authed, "content-type": "image/png" } })).status, 415);
  assert.equal((await call(e, `/api/audit/${T}/mobile.jpg`, { method: "PUT", body: JPEG, headers: { ...authed, "content-type": "image/jpeg" } })).status, 200);
  assert.equal((await call(e, `/api/audit/${T}`, { method: "PUT", headers: authed, body: JSON.stringify({ findings: [] }) })).status, 400);
});

test("public page renders findings escaped, serves screenshots, logs a view, and is noindex", async () => {
  const e = env();
  for (const k of ["mobile", "desktop"]) {
    await call(e, `/api/audit/${T}/${k}.jpg`, { method: "PUT", body: JPEG, headers: { ...authed, "content-type": "image/jpeg" } });
  }
  const put = await call(e, `/api/audit/${T}`, { method: "PUT", headers: authed, body: JSON.stringify({
    email: "Owner@Acme.com", company: "Acme <b>AC</b>", website: "acme.com",
    findings: [{ text: "No call button on the first screen <script>x</script>", service: "design" }, { text: "" }],
  }) });
  assert.equal(put.status, 200);
  const page = await call(e, `/a/${T}`, { headers: { "user-agent": "test" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-robots-tag"), "noindex");
  const html = await page.text();
  assert.ok(html.includes("Acme &lt;b&gt;AC&lt;/b&gt;"));
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!html.includes("<script>x"));
  assert.ok(html.includes(`/a/${T}/mobile.jpg`));
  assert.ok(html.includes("Other ways I can help"));
  const img = await call(e, `/a/${T}/desktop.jpg`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  const touch = await e.DB.prepare("SELECT event, contact_email FROM touches").first();
  assert.equal(touch.event, "audit_viewed");
  assert.equal(touch.contact_email, "owner@acme.com");
});

test("unknown tokens and bad paths are 404", async () => {
  const e = env();
  assert.equal((await call(e, `/a/${"b".repeat(32)}`)).status, 404);
  assert.equal((await call(e, `/a/${"b".repeat(32)}/mobile.jpg`)).status, 404);
  assert.equal((await call(e, "/a/short")).status, 401); // falls through to the dashboard login
});
