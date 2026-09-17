import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createProvider,
  type Api, type FetchFunction, type Model, type Provider, type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";

export const PROVIDER_ID = "opencode-zen-free";
export const BASE_URL = "https://opencode.ai/zen/v1";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-completions"]);

export function freeModels(): Model<Api>[] {
  return opencodeProvider().getModels()
    .filter((m) => SUPPORTED_APIS.has(m.api) && Object.values(m.cost).every((cost) => cost === 0))
    .map((m) => ({ ...m, provider: PROVIDER_ID, baseUrl: BASE_URL }));
}

export const OPENCODE_USER_AGENT = "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 pi-opencode-direct/0.1.3";
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_PROJECT = "global";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62FromBytes(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i % bytes.length] % 62];
  return out;
}

/**
 * Map a Pi session id to a valid OpenCode session id.
 * Format from packages/opencode/src/id/id.ts: `ses_` + 12 hex chars
 * (6 timestamp bytes) + 14 random base62 chars. The upstream free-tier gate
 * rejects structurally invalid ids (e.g. 64-char sha256 hex or 24-char
 * base62 without a hex prefix), while freshly generated valid ids pass.
 * Hashing keeps affinity stable per Pi session and distinct between sessions.
 */
export function sessionHeader(sessionId: string): string {
  const hash = createHash("sha256").update(`${PROVIDER_ID}:${sessionId}`).digest();
  const hex = hash.subarray(0, 6).toString("hex");
  return `ses_${hex}${base62FromBytes(hash.subarray(6), 14)}`;
}

/** Random valid OpenCode request id (`msg_` + 12 hex + 14 base62). Not validated, but matches the real CLI. */
export function requestHeader(): string {
  return `msg_${randomBytes(6).toString("hex")}${base62FromBytes(randomBytes(14), 14)}`;
}

/**
 * Zen routes `x-opencode-session` to a sticky backend so `reasoning.encrypted_content`
 * replays normally. After idle expiry or long tasks Zen can move the session to a
 * different instance that no longer holds the encryption key, and the upstream
 * rejects the replay with 400 `reasoning `encrypted_content` was not issued to
 * this caller` (or `encrypted content could not be verified`).
 */
export function isEncryptedContentError(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  return /encrypted[_ ]content/i.test(bodyText);
}

/**
 * Drop stale Responses `reasoning` items so a retried request looks like a fresh
 * session (which Zen always accepts). Function-call item ids are also dropped
 * while `call_id` is kept: OpenAI validates that `fc_*` ids were paired with the
 * original `rs_*` reasoning items, so keeping orphaned ids would 400 again.
 * Returns null when there is nothing to strip.
 */
export function stripStaleReasoning(payload: unknown): unknown | null {
  if (!payload || typeof payload !== "object") return null;
  const input = (payload as { input?: unknown }).input;
  if (!Array.isArray(input)) return null;
  if (!input.some((item) => (item as { type?: unknown })?.type === "reasoning")) return null;
  const nextInput = input
    .filter((item) => (item as { type?: unknown })?.type !== "reasoning")
    .map((item) => {
      const typed = item as { type?: unknown; id?: unknown } | null;
      if ((typed?.type === "function_call" || typed?.type === "custom_tool_call") && typeof typed.id === "string") {
        const { id: _dropped, ...rest } = typed as Record<string, unknown>;
        return rest;
      }
      return item;
    });
  return { ...(payload as Record<string, unknown>), input: nextInput };
}

/** Wrap fetch with a single retry that drops stale reasoning on Zen rotation. */
export function withEncryptedContentFallback(inner?: FetchFunction): FetchFunction {
  const base: FetchFunction = inner ?? globalThis.fetch;
  return (async (url: unknown, init?: unknown) => {
    const first = await (base as (u: never, i: never) => Promise<Response>)(url as never, init as never);
    if (first.status !== 400) return first;
    let text = "";
    try {
      text = await first.clone().text();
    } catch {
      return first;
    }
    if (!isEncryptedContentError(first.status, text)) return first;
    let parsed: unknown;
    try {
      const raw = (init as { body?: unknown } | undefined)?.body;
      if (typeof raw !== "string") return first;
      parsed = JSON.parse(raw);
    } catch {
      return first;
    }
    const stripped = stripStaleReasoning(parsed);
    if (!stripped) return first;
    const nextInit = { ...((init as Record<string, unknown>) ?? {}), body: JSON.stringify(stripped) };
    return (base as (u: never, i: never) => Promise<Response>)(url as never, nextInit as never);
  }) as FetchFunction;
}

/** Reuse Pi's native serializers, streaming parsers, reasoning, and tool handling. */
export function zenProvider(getSessionId: () => string | undefined = () => undefined): Provider {
  const fallbackSession = randomUUID();
  const baseline = freeModels();
  let catalogue = baseline;
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "OpenCode Zen Free",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Anonymous free tier (no key needed)",
        async resolve() {
          return { auth: { apiKey: "public" }, source: "Anonymous free tier" };
        },
      },
    },
    models: baseline,
    api: {
      "openai-responses": openAIResponsesApi(),
      "openai-completions": openAICompletionsApi(),
    },
  });

  function requestOptions<T extends StreamOptions>(options: T = {} as T): T {
    const headers = Object.fromEntries(Object.entries(options?.headers ?? {})
      .filter(([name]) => !["authorization", "user-agent", "x-opencode-session", "x-opencode-client", "x-opencode-project", "x-opencode-request"].includes(name.toLowerCase())));
    const opencodeSession = sessionHeader(options?.sessionId ?? getSessionId() ?? fallbackSession);
    return {
      ...options,
      // Free-tier anonymous path requires the literal key "public".
      apiKey: "public",
      sessionId: opencodeSession,
      timeoutMs: options?.timeoutMs ?? 180_000,
      maxRetries: options?.maxRetries ?? 2,
      // Retry once without replayed reasoning when Zen rotates backends and the
      // old encrypted_content key is gone. Runs before streaming starts, so the
      // caller sees a single normal stream.
      fetch: withEncryptedContentFallback(options?.fetch as FetchFunction | undefined) as T["fetch"],
      headers: {
        ...headers,
        Authorization: "Bearer public",
        "x-opencode-session": opencodeSession,
        "x-opencode-client": OPENCODE_CLIENT,
        "x-opencode-project": OPENCODE_PROJECT,
        "x-opencode-request": requestHeader(),
        "User-Agent": OPENCODE_USER_AGENT,
      },
    };
  }

  return {
    ...provider,
    getModels: () => catalogue,
    async refreshModels(ctx) {
      const select = (ids: Set<unknown>) => baseline.filter((m) => ids.has(m.id));
      if (ctx.stored) {
        const restored = select(new Set(ctx.stored.models.map((m) => m.id)));
        if (!await ctx.publish({ update: () => { catalogue = restored; } })) return;
      }
      if (!ctx.allowNetwork || ctx.signal.aborted) return;
      const signal = ctx.signal;
      const response = await fetch(`${BASE_URL}/models`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        headers: { "User-Agent": "pi-opencode-direct/0.1.3" },
      });
      if (!response.ok) throw new Error(`Zen model catalogue: HTTP ${response.status}`);
      const body = await response.json() as { data?: { id?: unknown }[] };
      if (!Array.isArray(body.data)) throw new Error("Invalid Zen model catalogue");
      const available = new Set(body.data.map((m) => m.id));
      const next = select(available);
      await ctx.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => { catalogue = next; },
      });
    },
    stream(model, context, options) {
      return provider.stream(model, context, requestOptions(options));
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, {
        ...requestOptions(options),
        reasoning: options?.reasoning ?? (model.id.startsWith("muse-spark-") ? "xhigh" : undefined),
      });
    },
  };
}
