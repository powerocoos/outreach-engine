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
