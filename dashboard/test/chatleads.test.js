import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { chatLeadsWaiting, CHAT_LEADS_PAGE } from "../src/chatleads.js";

const wrap = (db) => ({ prepare(sql) { let args = []; const s = {
  bind(...a) { args = a; return s; },
  async first() { return db.prepare(sql).get(...args) ?? null; },
  async all() { return { results: db.prepare(sql).all(...args) }; },
  async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; } }; return s; } });

function mainDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return wrap(db);
}
// The chatbot Worker's table as first deployed: no status column yet.
function chatDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL, created_at TEXT NOT NULL, name TEXT NOT NULL,
    email TEXT, phone TEXT, business TEXT, summary TEXT, session_id TEXT, transcript TEXT)`);
  const ins = db.prepare("INSERT INTO leads (client, created_at, name, email, phone, business, summary, session_id, transcript) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("ocoos", "2026-10-28T18:30:00.000Z", "Dana Smith", "dana@smithhvac.com", "", "Smith HVAC", "Wants a redesign before spring.", "s-secret-1", "Visitor: hi\nBot: hello");
  ins.run("ocoos", "2026-10-28T19:10:00.000Z", "Ann Lee", "", "(352) 555-0100", "", "Needs Google Ads help.", "s-secret-2", "Visitor: ads?");
  ins.run("otherclient", "2026-10-28T19:15:00.000Z", "Not Ours", "x@y.com", "", "", "other client's lead", "s3", "");
  return wrap(db);
}
const mk = (withChat = true) => ({ DB: mainDb(), ...(withChat ? { CHAT_DB: chatDb() } : {}), MEDIA: {}, API_TOKEN: "tok", DASHBOARD_PASSWORD: "pw" });
const ctx = { waitUntil() {} };
const call = (e, path, init = {}) => worker.fetch(new Request("https://x" + path, init), e, ctx);
const basic = { authorization: "Basic " + Buffer.from("x:pw").toString("base64"), "x-requested-with": "review" };

test("pages and APIs need the dashboard password", async () => {
  const e = mk();
  assert.equal((await call(e, "/chat-leads")).status, 401);
  assert.equal((await call(e, "/api/chat-leads")).status, 401);
  assert.equal((await call(e, "/api/chat-leads/1", { method: "POST", body: "{}" })).status, 401);
});

test("list adds the status column on first use and shows only this business's new leads", async () => {
  const e = mk();
  const j = await (await call(e, "/api/chat-leads", { headers: basic })).json();
  assert.equal(j.configured, true);
  assert.deepEqual(j.leads.map((l) => l.name), ["Ann Lee", "Dana Smith"]); // newest first
  assert.equal(j.leads[1].business, "Smith HVAC");
  assert.match(j.leads[1].transcript, /Bot: hello/);
  assert.equal(j.leads[0].session_id, undefined, "visitor session ids are not exposed");
  assert.deepEqual(j.counts, { new: 2 });
});

test("marking contacted moves a lead between tabs and reopen puts it back", async () => {
  const e = mk();
  const post = (id, action, headers = basic) => call(e, "/api/chat-leads/" + id, { method: "POST", headers, body: JSON.stringify({ action }) });
  await call(e, "/api/chat-leads", { headers: basic }); // runs the migration
  assert.equal((await post(1, "done")).status, 200);
  let list = await (await call(e, "/api/chat-leads?status=done", { headers: basic })).json();
  assert.deepEqual(list.leads.map((l) => l.name), ["Dana Smith"]);
  assert.ok(list.leads[0].handled_at);
  assert.equal((await (await call(e, "/api/summary", { headers: basic })).json()).chatLeads, 1);
  assert.equal((await post(1, "reopen")).status, 200);
  list = await (await call(e, "/api/chat-leads?status=new", { headers: basic })).json();
  assert.equal(list.leads.length, 2);
});

test("actions are checked: missing header, unknown lead, other client's lead, bad action", async () => {
  const e = mk();
  const { "x-requested-with": _, ...noCsrf } = basic;
  const post = (id, action, headers = basic) => call(e, "/api/chat-leads/" + id, { method: "POST", headers, body: JSON.stringify({ action }) });
  assert.equal((await post(1, "done", noCsrf)).status, 403);
  assert.equal((await post(999, "done")).status, 404);
  assert.equal((await post(3, "done")).status, 404, "another client's lead cannot be changed from here");
  assert.equal((await post(1, "delete")).status, 400);
});

test("summary counts waiting chat leads, and the menu and home page link to them", async () => {
  const e = mk();
  assert.equal((await (await call(e, "/api/summary", { headers: basic })).json()).chatLeads, 2);
  const home = await (await call(e, "/dashboard", { headers: basic })).text();
  assert.match(home, /href="\/chat-leads"/);
  assert.match(home, /Chat leads to follow up/);
  assert.match(CHAT_LEADS_PAGE, /aria-current="page"[^>]*>Chat leads/);
});

test("without the chat database everything still works and shows zero", async () => {
  const e = mk(false);
  assert.equal(await chatLeadsWaiting(e), 0);
  assert.equal((await (await call(e, "/api/summary", { headers: basic })).json()).chatLeads, 0);
  const j = await (await call(e, "/api/chat-leads", { headers: basic })).json();
  assert.deepEqual(j, { configured: false, leads: [], counts: {} });
  assert.equal((await call(e, "/api/chat-leads/1", { method: "POST", headers: basic, body: '{"action":"done"}' })).status, 400);
});

test("page script is valid JavaScript", () => {
  const scripts = [...CHAT_LEADS_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  for (const s of scripts) new Function(s);
});
