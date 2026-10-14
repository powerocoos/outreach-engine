import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, shouldAlert, alertText, rate, safeEqual } from "../src/logic.js";

test("normalizeEvent maps reply and lowercases email", () => {
  const r = normalizeEvent({ event_type: "reply_received", lead_email: " Bob@Acme.COM ", step: 2, campaign_name: "hvac" });
  assert.deepEqual(r, { event: "replied", email: "bob@acme.com", step: 2, campaign: "hvac" });
});

test("normalizeEvent ignores unknown events", () => {
  assert.equal(normalizeEvent({ event_type: "weird", lead_email: "a@b.co" }).event, null);
});

test("only replies and bookings alert", () => {
  assert.equal(shouldAlert("replied"), true);
  assert.equal(shouldAlert("booked"), true);
  assert.equal(shouldAlert("opened"), false);
  assert.equal(shouldAlert("bounced"), false);
});

test("alertText includes phone and hook when known", () => {
  const t = alertText("replied", { company: "Cool Air", phone: "(352) 555-0100", hook_angle: "No tap-to-call" }, "a@b.co");
  assert.match(t, /Cool Air REPLIED/);
  assert.match(t, /\(352\) 555-0100/);
  assert.match(t, /No tap-to-call/);
});

test("alertText falls back to email when lead unknown", () => {
  assert.match(alertText("booked", null, "x@y.co"), /x@y\.co BOOKED a call/);
});

test("rate handles zero denominator", () => {
  assert.equal(rate(1, 0), 0);
  assert.equal(rate(1, 8), 12.5);
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "x"), false);
});
