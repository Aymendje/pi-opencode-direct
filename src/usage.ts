/**
 * OpenCode Go subscription usage as a gentle-shell usage source.
 *
 * gentle-shell ships native usage readers only for `openai-codex`,
 * `anthropic` and `nan`; every other provider shows "no subscription usage
 * for this provider" unless an extension registers a source through the
 * generic hook — event `gentle-pi:usage-source/v1` with schema
 * `gentle-pi.usage-source/v1` (validated by gentle-pi `lib/shell-usage.ts`
 * `parseUsageSource`, one source per provider). This module registers such
 * a source for the `opencode-go` provider (paid Go subscription).
 *
 * The data comes from the official Go usage endpoint:
 * `GET https://opencode.ai/zen/go/v1/usage` (Bearer API key), reporting
 * rolling/weekly/monthly windows with percent used + resetsAt. That maps
 * directly onto the hook's ProviderUsage windows. Only percentages and
 * countdowns are reported — no dollar figures are exposed by the endpoint.
 *
 * Scope is deliberately `opencode-go` only: keys without a Go subscription
 * answer 403, so registering free-tier or Zen-only providers would leave a
 * permanent "fetch failed" note in the panel. A non-OK response returns
 * undefined and the shell keeps the last good snapshot.
 */

export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const GO_PROVIDER_ID = "opencode-go";
export const GO_USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const GO_USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

/** Key priority: shell-supplied stored credential first, then env. */
const ENV_KEYS = ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"] as const;

// Cloudflare fronts the usage endpoint and answers 403 (error 1010) to
// non-browser User-Agents (plain urllib/undici); a browser UA passes.
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface GoUsageWindow {
  label: string;
  usedPercent: number;
  windowSeconds: number;
  resetAt: number | null;
}

export interface GoUsageLimit {
  name: string;
  windows: GoUsageWindow[];
  limitReached: boolean;
}

export interface GoProviderUsage {
  provider: string;
  plan?: string;
  limits: GoUsageLimit[];
  fetchedAt: number;
}

export type GoUsageFetch = typeof fetch;

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

// resetsAt arrives as an ISO string or an epoch (seconds or milliseconds);
// the panel wants epoch milliseconds or null.
export function goResetMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value);
    if (value > 1e9) return Math.floor(value * 1000);
    return null;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function windowFromEntry(label: string, entry: unknown, windowSeconds: number): GoUsageWindow | undefined {
  const node = record(entry);
  if (!node) return undefined;
  const percent = finite(node.percent);
  if (percent === undefined) return undefined;
  return {
    label,
    usedPercent: percent,
    windowSeconds,
    resetAt: goResetMs(node.resetsAt ?? node.reset_at ?? node.resets),
  };
}

export function goUsageFromBody(provider: string, body: unknown, now: number): GoProviderUsage | undefined {
  const root = record(body);
  const usage = record(root?.usage);
  if (!usage) return undefined;
  const windows = [
    windowFromEntry("5h", usage.rolling, 5 * 3600),
    windowFromEntry("week", usage.weekly, 7 * 24 * 3600),
    windowFromEntry("month", usage.monthly, 30 * 24 * 3600),
  ].filter((w): w is GoUsageWindow => w !== undefined);
  if (windows.length === 0) return undefined;
  // The API can mark a window `rate-limited` while its floored percent still
  // reads below 100; either signal means the cap is hit.
  const rateLimited = [usage.rolling, usage.weekly, usage.monthly].some(
    (entry) => record(entry)?.status === "rate-limited",
  );
  const planRaw = root?.plan ?? root?.plan_type ?? root?.tier ?? usage.plan;
  const plan = typeof planRaw === "string" && planRaw.length > 0 ? planRaw : undefined;
  return {
    provider,
    ...(plan ? { plan } : {}),
    limits: [
      {
        name: "go",
        windows,
        limitReached: rateLimited || windows.some((w) => w.usedPercent >= 100),
      },
    ],
    fetchedAt: now,
  };
}

export function resolveGoApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey) return apiKey;
  return ENV_KEYS.map((name) => process.env[name]).find((value) => value && value.length > 0);
}

/** Minimal bus slice the usage-source registration needs. */
export interface GoUsageSourceBus {
  emit(channel: string, payload: unknown): void;
}

export function goUsageSource(apiKey: string | undefined): {
  schema: typeof GO_USAGE_SOURCE_SCHEMA;
  provider: typeof GO_PROVIDER_ID;
  pendingNote: string;
  fetch: (key: string | undefined, fetchFn: GoUsageFetch, now: number) => Promise<GoProviderUsage | undefined>;
} {
  return {
    schema: GO_USAGE_SOURCE_SCHEMA,
    provider: GO_PROVIDER_ID,
    pendingNote: "no usage yet · r to fetch",
    fetch: async (key, fetchFn, now) => {
      // The shell resolves the provider's stored credential and passes it
      // per refresh; a registration-time key is only a fallback, then env.
      // Never logged, never thrown.
      const resolved = resolveGoApiKey(key ?? apiKey);
      if (!resolved) return undefined;
      try {
        const response = await fetchFn(GO_USAGE_URL, {
          redirect: "error",
          cache: "no-store",
          headers: { Authorization: `Bearer ${resolved}`, Accept: "application/json", "User-Agent": BROWSER_UA },
        });
        if (!response.ok) return undefined;
        return goUsageFromBody(GO_PROVIDER_ID, await response.json(), now);
      } catch {
        return undefined;
      }
    },
  };
}

// Register (or re-register) the opencode-go source. Re-registration replaces
// per provider, so calling this on every session_start is idempotent, not an
// accumulation — and it makes registration independent of extension load
// order. Nothing here fetches or touches the network: the shell decides when
// (and for which provider) to call fetch.
export function registerGoUsageSource(bus: GoUsageSourceBus, apiKey?: string): void {
  bus.emit(GO_USAGE_SOURCE_EVENT, goUsageSource(apiKey));
}
