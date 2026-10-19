import test from "node:test";
import assert from "node:assert/strict";
import { shouldDispatch, kickOutreach } from "../src/kick.js";

const at = (s) => new Date(s);
const run = (s) => ({ created_at: s });

test("no run yet on a weekday morning -> dispatch", () => {
  assert.equal(shouldDispatch(at("2026-10-19T09:40:00Z"), [run("2026-10-17T15:48:43Z")]), true);
});
test("a run created today (even late) blocks dispatch", () => {
  assert.equal(shouldDispatch(at("2026-10-19T12:00:00Z"), [run("2026-10-19T10:05:00Z")]), false);
});
test("weekends, too early and too late never dispatch", () => {
  assert.equal(shouldDispatch(at("2026-10-17T12:00:00Z"), []), false);
  assert.equal(shouldDispatch(at("2026-10-19T08:30:00Z"), []), false);
  assert.equal(shouldDispatch(at("2026-10-19T18:30:00Z"), []), false);
});
test("disabled without a token; dispatches with one", async () => {
  assert.equal(await kickOutreach({}, at("2026-10-19T12:00:00Z")), "disabled");
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push([opts.method || "GET", url]);
    if (!opts.method) return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) };
    return { ok: true, status: 204 };
  };
  assert.equal(await kickOutreach({ GITHUB_DISPATCH_TOKEN: "t" }, at("2026-10-19T12:00:00Z"), fakeFetch), "dispatched");
  assert.equal(calls[1][0], "POST");
});
