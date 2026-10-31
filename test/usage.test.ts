import assert from "node:assert/strict";
import test from "node:test";
import {
  GO_PROVIDER_ID,
  GO_USAGE_SOURCE_EVENT,
  GO_USAGE_SOURCE_SCHEMA,
  GO_USAGE_URL,
  goResetMs,
  goUsageFromBody,
  goUsageSource,
  registerGoUsageSource,
  resolveGoApiKey,
} from "../src/usage.ts";

const NOW = 1793462987000;
const BODY = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-10-31T22:24:05.000Z" },
    weekly: { status: "ok", percent: 31, resetsAt: "2026-11-02T00:00:00.000Z" },
    monthly: { status: "ok", percent: 18, resetsAt: "2026-11-24T18:50:20.000Z" },
  },
};

function stubFetch(body: unknown, ok = true, capture?: { url?: string; init?: Record<string, unknown> }) {
  return (async (url: unknown, init?: unknown) => {
    if (capture) {
      capture.url = String(url);
      capture.init = (init ?? {}) as Record<string, unknown>;
    }
    return { ok, json: async () => body };
  }) as typeof fetch;
}

test("usage body maps to go windows with resets", () => {
  const usage = goUsageFromBody(GO_PROVIDER_ID, BODY, NOW)!;
  assert.ok(usage);
  assert.equal(usage.provider, GO_PROVIDER_ID);
  assert.equal(usage.fetchedAt, NOW);
  assert.equal(usage.limits.length, 1);
  assert.equal(usage.limits[0].name, "go");
  assert.equal(usage.limits[0].limitReached, false);
  const [rolling, weekly, monthly] = usage.limits[0].windows;
  assert.deepEqual(
    usage.limits[0].windows.map((w) => [w.label, w.usedPercent, w.windowSeconds]),
    [["5h", 0, 18000], ["week", 31, 604800], ["month", 18, 2592000]],
  );
  assert.equal(rolling.resetAt, Date.parse("2026-10-31T22:24:05.000Z"));
  assert.equal(weekly.resetAt, Date.parse("2026-11-02T00:00:00.000Z"));
  assert.equal(monthly.resetAt, Date.parse("2026-11-24T18:50:20.000Z"));
});

test("rate-limited status marks the limit reached", () => {
  const usage = goUsageFromBody(GO_PROVIDER_ID, { usage: { rolling: { status: "rate-limited", percent: 99 } } }, NOW)!;
  assert.equal(usage.limits[0].limitReached, true);
});

test("malformed bodies return undefined, never a confident zero", () => {
  assert.equal(goUsageFromBody(GO_PROVIDER_ID, null, NOW), undefined);
  assert.equal(goUsageFromBody(GO_PROVIDER_ID, {}, NOW), undefined);
  assert.equal(goUsageFromBody(GO_PROVIDER_ID, { usage: {} }, NOW), undefined);
  assert.equal(goUsageFromBody(GO_PROVIDER_ID, { usage: { rolling: { status: "ok" } } }, NOW), undefined);
});

test("reset parser accepts ISO and epochs, rejects garbage", () => {
  assert.equal(goResetMs("2026-11-24T18:50:20.000Z"), Date.parse("2026-11-24T18:50:20.000Z"));
  assert.equal(goResetMs(1793462987), 1793462987000);
  assert.equal(goResetMs(1793462987000), 1793462987000);
  assert.equal(goResetMs("nope"), null);
  assert.equal(goResetMs(undefined), null);
  assert.equal(goResetMs(42), null);
});

test("source fetch sends bearer + browser UA, refuses redirects", async () => {
  const capture: { url?: string; init?: Record<string, unknown> } = {};
  const source = goUsageSource(undefined);
  assert.equal(source.schema, GO_USAGE_SOURCE_SCHEMA);
  assert.equal(source.provider, GO_PROVIDER_ID);
  const usage = await source.fetch("DUMMY", stubFetch(BODY, true, capture), NOW);
  assert.equal(capture.url, GO_USAGE_URL);
  const headers = capture.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer DUMMY");
  assert.ok(headers["User-Agent"].includes("Mozilla"));
  assert.equal(capture.init?.redirect, "error");
  assert.equal(usage?.limits[0].windows[1].usedPercent, 31);
});

test("per-refresh key wins over the registration-time key", async () => {
  const capture: { url?: string; init?: Record<string, unknown> } = {};
  const source = goUsageSource("STALE");
  await source.fetch("FRESH", stubFetch(BODY, true, capture), NOW);
  assert.equal((capture.init?.headers as Record<string, string>).Authorization, "Bearer FRESH");
});

test("non-OK responses and missing keys return undefined", async () => {
  const source = goUsageSource(undefined);
  assert.equal(await source.fetch("DUMMY", stubFetch({}, false), NOW), undefined);
  assert.equal(
    await source.fetch(undefined, async () => { throw new Error("must not fetch without a key"); }, NOW),
    undefined,
  );
});

test("registration emits the source event", () => {
  const emitted: [string, Record<string, unknown>][] = [];
  registerGoUsageSource({ emit: (channel, payload) => emitted.push([channel, payload as Record<string, unknown>]) });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], GO_USAGE_SOURCE_EVENT);
  assert.equal(emitted[0][1].provider, GO_PROVIDER_ID);
  // Re-registration replaces per provider: emitting twice is idempotent.
  registerGoUsageSource({ emit: (channel, payload) => emitted.push([channel, payload as Record<string, unknown>]) });
  assert.equal(emitted.length, 2);
});

test("env fallback chain resolves without a stored credential", () => {
  assert.equal(resolveGoApiKey("STORED"), "STORED");
  assert.equal(resolveGoApiKey(undefined) ?? "no-env", typeof process.env.OPENCODE_GO_API_KEY === "string" && process.env.OPENCODE_GO_API_KEY ? process.env.OPENCODE_GO_API_KEY : "no-env");
});
