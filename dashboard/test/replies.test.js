import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { cleanBody, isAutomatic, parseSuggestion, syncReplies, suggestionPrompt } from "../src/replies.js";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { prepare(sql) { let args = []; const s = {
    bind(...a) { args = a; return s; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; } }; return s; } };
}
const mk = () => ({ DB: makeDb(), MEDIA: {}, API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw", INSTANTLY_API_KEY: "i", INSTANTLY_CAMPAIGN_ID: "c1" });
const ctx = { waitUntil() {} };
const call = (e, path, init = {}) => worker.fetch(new Request("https://x" + path, init), e, ctx);
const basic = { authorization: "Basic " + Buffer.from("x:pw").toString("base64"), "x-requested-with": "review" };

test("helpers strip quoted history, spot automatic mail and parse suggestions", () => {
  assert.equal(cleanBody("Sure, call me Friday.\n\nOn Mon, Oct 19, 2026 at 9:00 AM Xavier <x@y.com> wrote:\n> hi there"), "Sure, call me Friday.");
  assert.ok(isAutomatic({ subject: "Automatic reply: away", from_address_email: "a@b.com" }));
  assert.ok(isAutomatic({ subject: "Re: hi", from_address_email: "MAILER-DAEMON@x.com" }));
  assert.ok(!isAutomatic({ subject: "Re: your site", from_address_email: "bob@acme.com" }));
  assert.deepEqual(parseSuggestion('Here: {"category":"interested","reply":"Great, thanks."}'), { category: "interested", reply: "Great, thanks." });
  assert.equal(parseSuggestion('{"category":"weird","reply":"x"}').category, "other");
  assert.equal(parseSuggestion("nope"), null);
  const p = suggestionPrompt({ company: "Acme", theirs: "tell me more", ours: "Hi", findings: ["a"], booking: "https://cal.example/x" });
  assert.match(p.system, /cal\.example/); assert.match(p.user, /Acme/);
});

const instantly = (items) => async (url, init) => {
  if (String(url).includes("instantly.ai")) {
    assert.match(String(url), /email_type=received/);
    return new Response(JSON.stringify({ items }), { status: 200 });
  }
  const body = JSON.parse(init.body);
  assert.ok(body.messages[0].content.includes("Their reply"));
  return new Response(JSON.stringify({ content: [{ text: '{"category":"interested","reply":"Thanks! Which day works?\\n\\nXavier\\nOcoos Web Consulting"}' }] }), { status: 200 });
};

test("sync stores replies once, skips automatic ones and drafts suggestions", async () => {
  const e = mk(); e.ANTHROPIC_API_KEY = "k";
  await e.DB.prepare("INSERT INTO drafts (contact_email, company, subject, email1, email2, email3, findings) VALUES ('bob@acme.com','Acme AC','s','Hello Acme','b','c','[\"Footer year is old\"]')").run();
  const items = [
    { id: "e1", lead: "Bob@Acme.com", subject: "Re: your site", body: { text: "Yes, interested.\n> quoted" }, thread_id: "t1", timestamp_email: "2026-10-22T14:00:00Z", from_address_email: "bob@acme.com" },
    { id: "e2", lead: "oo@x.com", subject: "Automatic reply: away", body: { text: "I am out" }, from_address_email: "oo@x.com" },
  ];
  const f = instantly(items);
  assert.deepEqual(await syncReplies(e, f), { added: 2 });
  assert.deepEqual(await syncReplies(e, f), { added: 0 });
  const list = await (await call(e, "/api/replies", { headers: basic })).json();
  assert.equal(list.replies.length, 1);
  assert.equal(list.replies[0].company, "Acme AC");
  assert.equal(list.replies[0].category, "interested");
  assert.match(list.replies[0].suggestion, /Which day/);
  assert.equal(list.replies[0].body, "Yes, interested.");
  assert.equal(list.counts.done, 1);
  assert.equal((await call(e, `/api/replies/${list.replies[0].id}`, { method: "POST", headers: basic, body: JSON.stringify({ action: "done" }) })).status, 200);
  assert.equal((await (await call(e, "/api/replies", { headers: basic })).json()).replies.length, 0);
});

test("a key without email access is reported, and the page needs a login", async () => {
  const e = mk();
  const r = await syncReplies(e, async () => new Response("{}", { status: 403 }));
  assert.match(r.error, /emails:read/);
  const list = await (await call(e, "/api/replies", { headers: basic })).json();
  assert.equal(list.sync.ok, false);
  assert.equal((await call(e, "/replies")).status, 401);
  assert.equal((await call(e, "/api/replies/sync", { method: "POST" })).status, 401);
});
