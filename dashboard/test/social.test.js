import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { igImageOk, socialProblems } from "../src/social.js";

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
