import test from "node:test";
import assert from "node:assert/strict";
import { buildFunnel } from "../src/funnel.js";

const PHONE = "Mozilla/5.0 (iPhone) Safari/604.1";
const d = (email, category, city, status) => ({ contact_email: email, category, city, status });

test("funnel counts businesses per trade and ignores scanner views", () => {
  const drafts = [d("a@x.com", "plumber", "Ocala", "approved"), d("b@x.com", "plumber", "Newberry", "rejected"),
    d("c@x.com", "roofing", "Ocala", "exported"), d("z@x.com", null, null, "pending")];
  const touches = [
    { contact_email: "a@x.com", event: "sent" }, { contact_email: "a@x.com", event: "sent" },
    { contact_email: "a@x.com", event: "audit_viewed", raw: "Googlebot" },
    { contact_email: "a@x.com", event: "audit_viewed", raw: PHONE },
    { contact_email: "a@x.com", event: "replied" },
    { contact_email: "c@x.com", event: "sent" }, { contact_email: "nobody@x.com", event: "sent" },
  ];
  const trade = buildFunnel(drafts, touches, "category");
  const plumber = trade.find((r) => r.name === "plumber");
  assert.deepEqual([plumber.drafted, plumber.approved, plumber.sent, plumber.viewed, plumber.replied], [2, 1, 1, 1, 1]);
  assert.equal(plumber.reply_rate, 100);
  assert.equal(plumber.reject_rate, 50);
  const roof = trade.find((r) => r.name === "roofing");
  assert.equal(roof.reject_rate, 0); // approved only
  assert.equal(trade.find((r) => r.name === "Unknown").reject_rate, null); // pending only: not rejected
  assert.equal(plumber.enough, false);
  assert.equal(trade[0].name, "plumber"); // most sent first
  assert.ok(trade.find((r) => r.name === "Unknown"));
  const town = buildFunnel(drafts, touches, "city");
  assert.equal(town.find((r) => r.name === "Ocala").sent, 2);
});

test("auto-replies are not counted as replies in the funnel, stats or hot leads", async () => {
  const { handleFunnel } = await import("../src/funnel.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const d1 = {
    prepare: (sql) => { const st = db.prepare(sql); const mk = (a) => ({
      bind: (...b) => mk(b), all: async () => ({ results: st.all(...a) }), first: async () => st.get(...a) ?? null, run: async () => ({ meta: st.run(...a) }) }); return mk([]); },
  };
  for (const [e, c] of [["a@x.com", "HVAC"], ["b@x.com", "HVAC"], ["c@x.com", "HVAC"]])
    db.prepare("INSERT INTO drafts (contact_email, company, category, city, status, subject, email1, email2, email3) VALUES (?,?,?,?,?,?,?,?,?)").run(e, "Co " + e, c, "Ocala", "exported", "s", "1", "2", "3");
  for (const e of ["a@x.com", "b@x.com", "c@x.com"]) {
    db.prepare("INSERT INTO touches (contact_email, event) VALUES (?, 'sent')").run(e);
    db.prepare("INSERT INTO touches (contact_email, event) VALUES (?, 'replied')").run(e);
  }
  db.prepare("INSERT INTO replies (email_id, lead_email, category, status) VALUES ('1','a@x.com','auto_reply','done')").run();
  db.prepare("INSERT INTO replies (email_id, lead_email, category, status) VALUES ('2','b@x.com',NULL,'new')").run();
  // c@x.com has no reply text on file yet: it still counts.
  const r = await (await handleFunnel(new Request("https://x/api/funnel"), { DB: d1 })).json();
  assert.equal(r.rows.find((x) => x.name === "HVAC").replied, 2);
});
