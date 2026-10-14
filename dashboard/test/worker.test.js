import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

// Minimal D1 shim over node:sqlite so the real Worker code runs unmodified.
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

const env = () => ({ DB: makeDb(), WEBHOOK_SECRET: "wh", API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw" });
const ctx = { waitUntil() {} };
const basic = "Basic " + btoa("admin:pw");

test("webhook rejects bad secret", async () => {
  const r = await worker.fetch(new Request("https://x/webhook/instantly", { method: "POST", headers: { "x-webhook-secret": "no" }, body: "{}" }), env(), ctx);
  assert.equal(r.status, 401);
});

test("import -> reply webhook -> stats", async () => {
  const e = env();
  const imp = await worker.fetch(new Request("https://x/api/leads", {
    method: "POST", headers: { authorization: "Bearer tok" },
    body: JSON.stringify({ leads: [{ company: "Cool Air", contact_email: "Bob@CoolAir.com", city: "Gainesville", hook_angle: "No tap-to-call" }] }),
  }), e, ctx);
  assert.deepEqual(await imp.json(), { ok: true, imported: 1 });

  const hook = (event_type) => worker.fetch(new Request("https://x/webhook/instantly", {
    method: "POST", headers: { "x-webhook-secret": "wh" },
    body: JSON.stringify({ event_type, lead_email: "bob@coolair.com", campaign_name: "hvac" }),
  }), e, ctx);
  await hook("email_sent");
  await hook("reply_received");

  const s = await (await worker.fetch(new Request("https://x/api/stats", { headers: { authorization: basic } }), e, ctx)).json();
  assert.equal(s.totals.leads, 1);
  assert.equal(s.totals.sent, 1);
  assert.equal(s.totals.replied, 1);
  assert.equal(s.rates.reply, 100);
  assert.equal(s.byAngle[0].angle, "No tap-to-call");
  assert.equal(s.byAngle[0].replies, 1);
  const lead = await e.DB.prepare("SELECT status FROM leads").first();
  assert.equal(lead.status, "replied");
});

test("dashboard requires auth", async () => {
  const r = await worker.fetch(new Request("https://x/dashboard"), env(), ctx);
  assert.equal(r.status, 401);
  const ok = await worker.fetch(new Request("https://x/dashboard", { headers: { authorization: basic } }), env(), ctx);
  assert.equal(ok.status, 200);
});

// --- hosted video ---------------------------------------------------------
function makeR2() {
  const store = new Map();
  return {
    async put(key, body, opts) {
      const buf = new Uint8Array(await new Response(body).arrayBuffer());
      store.set(key, { buf, type: opts?.httpMetadata?.contentType });
    },
    async get(key, opts) {
      const o = store.get(key);
      if (!o) return null;
      const range = opts?.range?.get?.("range");
      if (range) {
        const [, a, b] = range.match(/bytes=(\d+)-(\d*)/);
        const offset = Number(a), end = b ? Number(b) : o.buf.length - 1;
        return { body: o.buf.slice(offset, end + 1), size: o.buf.length, range: { offset, length: end - offset + 1 } };
      }
      return { body: o.buf, size: o.buf.length };
    },
  };
}

test("video upload -> view page logs event -> file served with range", async () => {
  const e = { ...env(), MEDIA: makeR2() };
  await e.DB.prepare("INSERT INTO leads (company, contact_email) VALUES ('Cool Air','bob@coolair.com')").run();
  const token = "a".repeat(32);

  const bad = await worker.fetch(new Request(`https://x/api/media/${token}`, { method: "PUT", headers: { authorization: "Bearer nope", "content-type": "video/mp4" }, body: "x" }), e, ctx);
  assert.equal(bad.status, 401);
  const wrongType = await worker.fetch(new Request(`https://x/api/media/${token}`, { method: "PUT", headers: { authorization: "Bearer tok", "content-type": "text/html" }, body: "x" }), e, ctx);
  assert.equal(wrongType.status, 415);
  const badToken = await worker.fetch(new Request("https://x/api/media/short", { method: "PUT", headers: { authorization: "Bearer tok", "content-type": "video/mp4" }, body: "x" }), e, ctx);
  assert.equal(badToken.status, 400);

  const up = await worker.fetch(new Request(`https://x/api/media/${token}?email=Bob@CoolAir.com`, { method: "PUT", headers: { authorization: "Bearer tok", "content-type": "video/mp4" }, body: "0123456789" }), e, ctx);
  assert.equal(up.status, 200);

  const page = await worker.fetch(new Request(`https://x/v/${token}`), e, ctx);
  assert.equal(page.status, 200);
  assert.match(await page.text(), new RegExp(`/v/${token}\\.mp4`));
  const ev = await e.DB.prepare("SELECT event, contact_email FROM touches").first();
  assert.deepEqual({ ...ev }, { event: "video_viewed", contact_email: "bob@coolair.com" });

  const full = await worker.fetch(new Request(`https://x/v/${token}.mp4`), e, ctx);
  assert.equal(full.status, 200);
  assert.equal((await full.arrayBuffer()).byteLength, 10);
  const part = await worker.fetch(new Request(`https://x/v/${token}.mp4`, { headers: { range: "bytes=2-4" } }), e, ctx);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-4/10");

  const missing = await worker.fetch(new Request(`https://x/v/${"b".repeat(32)}`), e, ctx);
  assert.equal(missing.status, 404);
  const s = await (await worker.fetch(new Request("https://x/api/stats", { headers: { authorization: basic } }), e, ctx)).json();
  assert.equal(s.totals.videoViews, 1);
});
