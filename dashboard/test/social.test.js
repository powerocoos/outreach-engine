import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { igImageOk, socialProblems, easternToUtc, utcToEastern, nextSlot, publishDue } from "../src/social.js";

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
const META = { META_PAGE_ID: "PAGE1", META_IG_USER_ID: "IG1", META_PAGE_TOKEN: "tok-secret" };
const env = (extra = {}) => ({ DB: makeDb(), API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw", ...extra });
const ctx = { waitUntil() {} };
const basic = "Basic " + btoa("admin:pw");
const POST = {
  post_url: "https://www.ocooswebconsulting.com/updates/google-ads", title: "Google Ads for Local Businesses",
  summary: "s", image_url: "https://images.squarespace-cdn.com/x/a.jpg?format=1500w", categories: ["Google Ads"],
  pub_date: "2026-10-12T13:35:56Z", link: "https://www.ocooswebconsulting.com/updates/google-ads?utm_source=facebook",
  fb_text: "Is your ad budget working?", ig_text: "Is your ad budget working? #OcalaFlorida",
};
const call = (e, path, init = {}) => worker.fetch(new Request("https://x" + path, init), e, ctx);
const ingest = (e, posts) => call(e, "/api/social", { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ posts }) });
const act = (e, id, body) => call(e, `/api/social/${id}`, { method: "POST", headers: { authorization: basic, "x-requested-with": "review" }, body: JSON.stringify(body) });

// Records Graph API calls and answers like Meta does.
function mockMeta(t, { igFails = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (u.includes("/PAGE1/feed")) return reply({ id: "PAGE1_111" });
    if (u.includes("/IG1/media_publish")) return igFails ? reply({ error: { message: "IG down" } }, 400) : reply({ id: "ig-222" });
    if (u.includes("/IG1/media")) return reply({ id: "creation-9" });
    if (u.includes("/creation-9")) return reply({ status_code: "FINISHED" });
    return reply({ error: { message: "unexpected " + u } }, 500);
  });
  return calls;
}

test("ingest needs the token, rejects bad posts and dedupes", async () => {
  const e = env();
  assert.equal((await call(e, "/api/social", { method: "POST", body: "{}" })).status, 401);
  const r = await (await ingest(e, [POST, POST, { ...POST, post_url: "http://insecure", title: "x" }, { ...POST, post_url: "https://a.com/b", fb_text: "" }])).json();
  assert.deepEqual(r, { ok: true, added: 1, skipped: 3 });
  const known = await (await call(e, "/api/social/known", { headers: { authorization: "Bearer tok" } })).json();
  assert.deepEqual(known.urls, [POST.post_url]);
  assert.equal((await call(e, "/api/social/known")).status, 401);
});

test("list needs the dashboard login and reports connections", async () => {
  const e = env(META);
  await ingest(e, [POST]);
  assert.equal((await call(e, "/api/social")).status, 401);
  const j = await (await call(e, "/api/social", { headers: { authorization: basic } })).json();
  assert.equal(j.counts.pending, 1);
  assert.deepEqual(j.connected, { facebook: true, instagram: true });
  assert.equal(j.posts[0].ig_ok, true);
  const none = await (await call(env(), "/api/social", { headers: { authorization: basic } })).json();
  assert.deepEqual(none.connected, { facebook: false, instagram: false });
});

test("approve validates and keeps edits; csrf header required", async () => {
  const e = env();
  await ingest(e, [POST]);
  assert.equal((await call(e, "/api/social/1", { method: "POST", headers: { authorization: basic }, body: JSON.stringify({ action: "approve" }) })).status, 403);
  assert.equal((await act(e, 1, { action: "approve", fb_text: "   " })).status, 422);
  assert.equal((await act(e, 1, { action: "approve", ig_text: "Edited caption #a" })).status, 200);
  const row = await e.DB.prepare("SELECT status, ig_text, edited FROM social_posts").first();
  assert.deepEqual({ ...row }, { status: "approved", ig_text: "Edited caption #a", edited: 1 });
});

test("publish posts to Facebook and Instagram once, even if pressed twice", async (t) => {
  const e = env(META);
  await ingest(e, [POST]);
  assert.equal((await act(e, 1, { action: "publish", channel: "both" })).status, 409); // not approved yet
  await act(e, 1, { action: "approve" });
  const calls = mockMeta(t);
  const r = await (await act(e, 1, { action: "publish", channel: "both" })).json();
  assert.equal(r.status, "posted");
  assert.deepEqual(r.results, { facebook: "PAGE1_111", instagram: "ig-222" });
  const fb = calls.find((c) => c.url.includes("/PAGE1/feed"));
  assert.equal(fb.body.message, POST.fb_text);
  assert.equal(fb.body.link, POST.link);
  assert.equal(fb.body.access_token, "tok-secret");
  const ig = calls.find((c) => c.url.endsWith("/IG1/media"));
  assert.equal(ig.body.image_url, POST.image_url);
  assert.equal(ig.body.caption, POST.ig_text);
  const n = calls.length;
  await act(e, 1, { action: "publish", channel: "both" });
  assert.equal(calls.length, n, "second press must not call Meta again");
});

test("a failed channel keeps the post approved and a retry only redoes that channel", async (t) => {
  const e = env(META);
  await ingest(e, [POST]);
  await act(e, 1, { action: "approve" });
  let calls = mockMeta(t, { igFails: true });
  const r = await (await act(e, 1, { action: "publish", channel: "both" })).json();
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /instagram: IG down/);
  let row = await e.DB.prepare("SELECT status, fb_post_id, ig_post_id, error FROM social_posts").first();
  assert.equal(row.status, "approved");
  assert.equal(row.fb_post_id, "PAGE1_111");
  assert.match(row.error, /IG down/);
  t.mock.restoreAll();
  calls = mockMeta(t);
  const again = await (await act(e, 1, { action: "publish", channel: "both" })).json();
  assert.equal(again.status, "posted");
  assert.equal(calls.some((c) => c.url.includes("/PAGE1/feed")), false, "Facebook must not be posted again");
});

test("a PNG image blocks Instagram only", async (t) => {
  assert.equal(igImageOk("https://i.com/a.png?format=1500w"), false);
  assert.equal(igImageOk("https://i.com/a.JPG?format=1500w"), true);
  const e = env(META);
  await ingest(e, [{ ...POST, image_url: "https://images.squarespace-cdn.com/x/a.png?format=1500w" }]);
  await act(e, 1, { action: "approve" });
  const calls = mockMeta(t);
  const ig = await act(e, 1, { action: "publish", channel: "instagram" });
  assert.match((await ig.json()).errors[0], /JPEG/);
  const fb = await (await act(e, 1, { action: "publish", channel: "facebook" })).json();
  assert.equal(fb.status, "posted", "Facebook-only is enough when the image can't go to Instagram");
  assert.equal(calls.some((c) => c.url.includes("/IG1/media")), false);
});

test("without Meta secrets publish is refused but manual mark-as-posted works", async () => {
  const e = env();
  await ingest(e, [POST]);
  await act(e, 1, { action: "approve" });
  const r = await act(e, 1, { action: "publish", channel: "facebook" });
  assert.equal(r.status, 502);
  assert.match((await r.json()).errors[0], /not connected/);
  assert.equal((await (await act(e, 1, { action: "mark_posted" })).json()).status, "posted");
});

test("caption checks", () => {
  assert.deepEqual(socialProblems({ fb_text: "a", ig_text: "b" }), []);
  assert.equal(socialProblems({ fb_text: "a", ig_text: "x".repeat(2201) }).length, 1);
  assert.equal(socialProblems({ fb_text: "a", ig_text: Array(31).fill("#t").join(" ") }).length, 1);
});

test("the social page and dashboard link render", async () => {
  const e = env();
  assert.equal((await call(e, "/social")).status, 401);
  const page = await (await call(e, "/social", { headers: { authorization: basic } })).text();
  assert.match(page, /<title>Social posts<\/title>/);
  assert.match(page, /Poppins/);
  const dash = await (await call(e, "/dashboard", { headers: { authorization: basic } })).text();
  assert.match(dash, /href="\/social"/);
});

test("generated card: upload needs token, JPEG only, then public GET serves it", async () => {
  const store = new Map();
  const MEDIA = {
    async put(k, v, o) { store.set(k, { v, o }); },
    async get(k) { const e = store.get(k); return e ? { body: e.v } : null; },
  };
  const e = env({ MEDIA });
  const key = "a".repeat(32);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const put = (headers, body = jpeg) => worker.fetch(new Request(`https://d/api/social-image/${key}`, { method: "PUT", headers, body }), e, ctx);
  assert.equal((await put({ "content-type": "image/jpeg" })).status, 401);
  assert.equal((await put({ authorization: "Bearer tok", "content-type": "image/png" })).status, 415);
  assert.equal((await put({ authorization: "Bearer tok", "content-type": "image/jpeg" }, new Uint8Array([1, 2, 3, 4]))).status, 415);
  assert.equal((await put({ authorization: "Bearer tok", "content-type": "image/jpeg" })).status, 200);
  const got = await worker.fetch(new Request(`https://d/img/social/${key}.jpg`), e, ctx); // no Basic auth: Instagram must reach it
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.equal((await worker.fetch(new Request(`https://d/img/social/${"b".repeat(32)}.jpg`), e, ctx)).status, 404);
});

test("Eastern time conversion handles daylight saving", () => {
  assert.equal(easternToUtc("2026-10-16T09:00"), "2026-10-16T13:00:00Z"); // EDT = UTC-4
  assert.equal(easternToUtc("2026-11-10T09:00"), "2026-11-10T14:00:00Z"); // EST = UTC-5
  assert.equal(easternToUtc("2026-13-40T09:00"), null);
  assert.equal(easternToUtc("tomorrow"), null);
  assert.equal(utcToEastern("2026-10-16T13:00:00Z").local, "2026-10-16T09:00");
  assert.match(utcToEastern("2026-10-16T13:00:00Z").label, /Fri, Oct 16, 9:00 AM ET/);
});

test("next slot is the next free 9:00 AM Eastern, one post per day", () => {
  const now = new Date("2026-10-15T06:20:00Z"); // 2:20 AM Eastern
  assert.equal(nextSlot(new Set(), now), "2026-10-15T13:00:00Z");
  assert.equal(nextSlot(new Set(["2026-10-15"]), now), "2026-10-16T13:00:00Z");
  assert.equal(nextSlot(new Set(), new Date("2026-10-15T14:00:00Z")), "2026-10-16T13:00:00Z"); // 10 AM: today's slot passed
  assert.equal(nextSlot(new Set(), new Date("2026-10-15T12:58:00Z")), "2026-10-16T13:00:00Z"); // under 5 minutes away
});

test("approving books 9 AM slots on separate days; schedule can change or clear it", async () => {
  const e = env(META);
  await ingest(e, [POST, { ...POST, post_url: "https://a.com/two", title: "Two" }]);
  const a = await (await act(e, 1, { action: "approve" })).json();
  assert.equal(a.status, "approved");
  await act(e, 2, { action: "approve" });
  const list = await (await call(e, "/api/social?status=approved", { headers: { authorization: basic } })).json();
  const [b, c] = list.posts; // newest first: id 2 then 1
  assert.match(c.scheduled_label, /9:00 AM ET/);
  assert.match(b.scheduled_label, /9:00 AM ET/);
  assert.notEqual(b.scheduled_at.slice(0, 10), c.scheduled_at.slice(0, 10));
  const ok = await (await act(e, 1, { action: "schedule", scheduled_local: "2099-01-05T08:30" })).json();
  assert.equal(ok.scheduled_at, "2099-01-05T13:30:00Z");
  assert.equal((await act(e, 1, { action: "schedule", scheduled_local: "2001-01-01T09:00" })).status, 422);
  assert.equal((await act(e, 1, { action: "schedule", scheduled_local: "garbage" })).status, 422);
  assert.equal((await (await act(e, 1, { action: "schedule", scheduled_local: "" })).json()).scheduled_at, null);
  await act(e, 1, { action: "reset" });
  assert.equal((await act(e, 1, { action: "schedule", scheduled_local: "2099-01-05T08:30" })).status, 409); // not approved
});

test("cron publishes only due posts, once, and stops retrying after three failures", async (t) => {
  const e = env(META);
  await ingest(e, [POST, { ...POST, post_url: "https://a.com/two", title: "Two" }]);
  await act(e, 1, { action: "approve" });
  await act(e, 2, { action: "approve" });
  const set = (id, at) => e.DB.prepare("UPDATE social_posts SET scheduled_at=? WHERE id=?").bind(at, id).run();
  await set(1, "2026-10-15T13:00:00Z");
  await set(2, "2099-01-01T13:00:00Z");
  const calls = mockMeta(t);
  assert.equal(await publishDue(e, new Date("2026-10-15T13:00:30Z")), 1);
  assert.equal(calls.filter((c) => c.url.includes("/PAGE1/feed")).length, 1);
  assert.equal((await e.DB.prepare("SELECT status FROM social_posts WHERE id=1").first()).status, "posted");
  assert.equal((await e.DB.prepare("SELECT status FROM social_posts WHERE id=2").first()).status, "approved");
  assert.equal(await publishDue(e, new Date("2026-10-15T13:30:00Z")), 0); // nothing left that is due, nothing re-posted
  assert.equal(calls.filter((c) => c.url.includes("/PAGE1/feed")).length, 1);

  const f = env(META);
  await ingest(f, [POST]);
  await act(f, 1, { action: "approve" });
  await f.DB.prepare("UPDATE social_posts SET scheduled_at='2026-10-15T13:00:00Z' WHERE id=1").run();
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }));
  for (let i = 0; i < 5; i++) await publishDue(f, new Date("2026-10-15T14:00:00Z"));
  const row = await f.DB.prepare("SELECT status, attempts, error FROM social_posts WHERE id=1").first();
  assert.equal(row.attempts, 3);
  assert.equal(row.status, "approved");
  assert.match(row.error, /facebook/);
});

test("cron does nothing when Meta is not connected, and the list shows the next slot", async () => {
  const e = env();
  await ingest(e, [POST]);
  await act(e, 1, { action: "approve" });
  await e.DB.prepare("UPDATE social_posts SET scheduled_at='2026-10-15T13:00:00Z' WHERE id=1").run();
  assert.equal(await publishDue(e, new Date("2026-10-16T00:00:00Z")), 0);
  const list = await (await call(e, "/api/social?status=approved", { headers: { authorization: basic } })).json();
  assert.match(list.next_slot_label, /9:00 AM ET/);
});
