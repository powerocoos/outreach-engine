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

test("unset secrets reject empty credentials", async () => {
  const e = { DB: makeDb() };   // no secrets configured at all
  const hook = await worker.fetch(new Request("https://x/webhook/instantly", { method: "POST", body: "{}" }), e, ctx);
  assert.equal(hook.status, 401);
  const dash = await worker.fetch(new Request("https://x/dashboard", { headers: { authorization: "Basic " + btoa("admin:") } }), e, ctx);
  assert.equal(dash.status, 401);
  const imp = await worker.fetch(new Request("https://x/api/leads", { method: "POST", body: "{}" }), e, ctx);
  assert.equal(imp.status, 401);
});

// --- draft review ---------------------------------------------------------
const draft = (over = {}) => ({
  contact_email: "Bob@CoolAir.com", company: "Cool Air", website: "http://coolair.com/", city: "Gainesville",
  category: "HVAC contractor", angle: "Slow mobile load", mobile_score: 31, rating: 4.9, review_count: 120,
  findings: ["In Google's mobile speed test, the main content takes about 9.0 seconds to appear."],
  subject: "Google's mobile test on Cool Air", email1: "Hi there. Worth a look?", email2: "Following up. Want it?",
  email3: "Last note. Useful?", ...over,
});
const post = (e, path, body, headers = {}) => worker.fetch(new Request("https://x" + path, {
  method: "POST", headers: { authorization: "Bearer tok", ...headers }, body: JSON.stringify(body) }), e, ctx);
const review = (e, path, body) => post(e, path, body, { authorization: basic, "x-requested-with": "review" });

test("drafts import needs the token and never overwrites a decision", async () => {
  const e = env();
  const bad = await worker.fetch(new Request("https://x/api/drafts", { method: "POST", body: "{}" }), e, ctx);
  assert.equal(bad.status, 401);
  assert.deepEqual(await (await post(e, "/api/drafts", { drafts: [draft(), draft({ company: "" })] })).json(), { ok: true, added: 1, skipped: 1 });
  const id = (await e.DB.prepare("SELECT id FROM drafts").first()).id;
  await review(e, "/api/review/" + id, { action: "reject" });
  await post(e, "/api/drafts", { drafts: [draft({ subject: "changed" })] });
  const row = await e.DB.prepare("SELECT status, subject, contact_email FROM drafts").first();
  assert.equal(row.status, "rejected");
  assert.equal(row.subject, "Google's mobile test on Cool Air");
  assert.equal(row.contact_email, "bob@coolair.com");
});

test("review actions require auth and the csrf header", async () => {
  const e = env();
  await post(e, "/api/drafts", { drafts: [draft()] });
  const noAuth = await worker.fetch(new Request("https://x/api/review/1", { method: "POST", body: "{}" }), e, ctx);
  assert.equal(noAuth.status, 401);
  const noHeader = await post(e, "/api/review/1", { action: "approve" }, { authorization: basic });
  assert.equal(noHeader.status, 403);
});

test("approve with edits -> lead created -> export csv marks exported", async () => {
  const e = env();
  await post(e, "/api/drafts", { drafts: [draft()] });
  const r = await review(e, "/api/review/1", { action: "approve", email1: 'Hi, "quoted" edit.\nWorth a look?' });
  assert.deepEqual(await r.json(), { ok: true, status: "approved" });
  assert.equal((await e.DB.prepare("SELECT hook_angle FROM leads").first()).hook_angle, "Slow mobile load");
  const list = await (await worker.fetch(new Request("https://x/api/review?status=approved", { headers: { authorization: basic } }), e, ctx)).json();
  assert.equal(list.counts.approved, 1);
  assert.equal(list.drafts[0].edited, 1);
  const ex = await review(e, "/api/export/instantly", {});
  assert.equal(ex.headers.get("x-exported-count"), "1");
  const csv = await ex.text();
  assert.match(csv, /^email,first_name,company_name,/);
  assert.match(csv, /bob@coolair\.com/);
  assert.match(csv, /"Hi, ""quoted"" edit\.\nWorth a look\?"/);
  assert.equal((await e.DB.prepare("SELECT status FROM drafts").first()).status, "exported");
  const again = await review(e, "/api/export/instantly", {});
  assert.equal(again.headers.get("x-exported-count"), "0");
});

test("cannot approve an empty edit or a bounced contact", async () => {
  const e = env();
  await post(e, "/api/drafts", { drafts: [draft(), draft({ contact_email: "dead@x.com", company: "Dead Co" })] });
  const empty = await review(e, "/api/review/1", { action: "approve", email2: "  " });
  assert.equal(empty.status, 422);
  await e.DB.prepare("INSERT INTO leads (company, contact_email, status) VALUES ('Dead Co','dead@x.com','dead')").run();
  const dead = await review(e, "/api/review/2", { action: "approve" });
  assert.equal(dead.status, 409);
});

test("review page requires auth", async () => {
  const r = await worker.fetch(new Request("https://x/review"), env(), ctx);
  assert.equal(r.status, 401);
  const ok = await worker.fetch(new Request("https://x/review", { headers: { authorization: basic } }), env(), ctx);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Review drafts/);
});

test("state upload and download use the token", async () => {
  const e = env(); e.MEDIA = makeR2();
  const none = await worker.fetch(new Request("https://x/api/state", { headers: { authorization: "Bearer tok" } }), e, ctx);
  assert.equal(none.status, 404);
  await worker.fetch(new Request("https://x/api/state", { method: "PUT", headers: { authorization: "Bearer tok" }, body: "dbbytes" }), e, ctx);
  const got = await worker.fetch(new Request("https://x/api/state", { headers: { authorization: "Bearer tok" } }), e, ctx);
  assert.equal(await got.text(), "dbbytes");
  const bad = await worker.fetch(new Request("https://x/api/state"), e, ctx);
  assert.equal(bad.status, 401);
});

test("send approved drafts to Instantly via API", async () => {
  const e = { ...env(), INSTANTLY_API_KEY: "k", INSTANTLY_CAMPAIGN_ID: "camp-1" };
  await post(e, "/api/drafts", { drafts: [draft()] });
  await review(e, "/api/review/1", { action: "approve" });
  const missing = await review({ ...e, INSTANTLY_API_KEY: undefined }, "/api/send/instantly", {});
  assert.equal(missing.status, 400);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); };
  try {
    const r = await (await review(e, "/api/send/instantly", {})).json();
    assert.equal(r.sent, 1);
    assert.equal(calls[0].url, "https://api.instantly.ai/api/v2/leads");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.campaign, "camp-1");
    assert.equal(body.custom_variables.Email1, draft().email1);
    assert.equal(calls[0].init.headers.authorization, "Bearer k");
    assert.equal((await e.DB.prepare("SELECT status FROM drafts").first()).status, "exported");
  } finally { globalThis.fetch = realFetch; }
});

test("campaign status, launch needs typed confirmation, pause works", async () => {
  const e = { ...env(), INSTANTLY_API_KEY: "k", INSTANTLY_CAMPAIGN_ID: "camp-1" };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    return new Response(JSON.stringify({ name: "Test campaign", status: 0, daily_limit: 10 }), { status: 200 });
  };
  try {
    const st = await (await worker.fetch(new Request("https://x/api/campaign", { headers: { authorization: basic } }), e, ctx)).json();
    assert.equal(st.label, "Draft");
    assert.equal(st.daily_limit, 10);
    const noConfirm = await review(e, "/api/campaign/launch", {});
    assert.equal(noConfirm.status, 400);
    assert.equal(calls.filter((c) => c.url.endsWith("/activate")).length, 0);
    const ok = await review(e, "/api/campaign/launch", { confirm: "LAUNCH" });
    assert.equal(ok.status, 200);
    assert.ok(calls.some((c) => c.url.endsWith("/campaigns/camp-1/activate") && c.method === "POST"));
    const paused = await review(e, "/api/campaign/pause", {});
    assert.equal(paused.status, 200);
    const unauth = await worker.fetch(new Request("https://x/api/campaign/launch", { method: "POST" }), e, ctx);
    assert.equal(unauth.status, 401);
  } finally { globalThis.fetch = realFetch; }
});

test("polling sync records events once and updates lead status", async () => {
  const e = { ...env(), INSTANTLY_API_KEY: "k", INSTANTLY_CAMPAIGN_ID: "camp-1" };
  await post(e, "/api/drafts", { drafts: [draft()] });
  await review(e, "/api/review/1", { action: "approve" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [
    { email: "bob@coolair.com", timestamp_last_contact: "2026-10-20T10:00:00Z", email_reply_count: 1, status: 1 },
    { email: "gone@x.com", timestamp_last_contact: "2026-10-20T10:00:00Z", status: -1 },
  ] }), { status: 200 });
  try {
    const hit = () => worker.fetch(new Request("https://x/api/sync/instantly", { method: "POST", headers: { authorization: basic, "x-requested-with": "review" } }), e, ctx).then((r) => r.json());
    const r1 = await hit();
    assert.equal(r1.leadsSeen, 2);
    assert.equal(r1.added, 4); // bob: sent+replied, gone: sent+bounced
    const r2 = await hit();
    assert.equal(r2.added, 0);
    assert.equal((await e.DB.prepare("SELECT status FROM leads WHERE contact_email='bob@coolair.com'").first()).status, "replied");
    assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM touches WHERE event='replied'").first()).n, 1);
  } finally { globalThis.fetch = realFetch; }
});
