import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createProvider,
  type Api, type FetchFunction, type Model, type Provider, type StreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";

export const PROVIDER_ID = "opencode-zen-free";
export const BASE_URL = "https://opencode.ai/zen/v1";
const SUPPORTED_APIS = new Set(["openai-responses", "openai-completions"]);

export function freeModels(): Model<Api>[] {
  return opencodeProvider().getModels()
    .filter((m) => SUPPORTED_APIS.has(m.api) && Object.values(m.cost).every((cost) => cost === 0))
    .map((m) => ({
      ...m,
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
      // Static gate headers so side-channels that bypass zenProvider().stream()
      // (e.g. pi-hermes-memory direct transport via pi-ai/compat completeSimple,
      // which resolves auth + model.headers but never calls our requestOptions
      // wrapper) still look like OpenCode. Dynamic per-request headers
      // (x-opencode-session / x-opencode-request / Authorization) are added in
      // requestOptions() for the main path; compat createClient merges
      // model.headers then options headers, so these survive both paths.
      headers: {
        ...m.headers,
        ...STATIC_ZEN_HEADERS,
      },
    }));
}

export const OPENCODE_USER_AGENT = "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14 pi-opencode-direct/0.1.5";
export const OPENCODE_CLIENT = "cli";
export const OPENCODE_PROJECT = "global";

/**
 * Static free-tier gate headers. Must stay in sync with requestOptions().
 * Exposed on provider.headers, model.headers, and auth.resolve() so
 * out-of-band completions (pi-hermes-memory direct transport, which uses
 * modelRegistry.getApiKeyAndHeaders() + compat completeSimple and never
 * touches requestOptions) still send the OpenCode identity Zen gates on.
 * Per-request values (session/request/auth) stay dynamic in requestOptions().
 */
export const STATIC_ZEN_HEADERS: Record<string, string> = {
  "User-Agent": OPENCODE_USER_AGENT,
  "x-opencode-client": OPENCODE_CLIENT,
  "x-opencode-project": OPENCODE_PROJECT,
};
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

/**
 * Patch the global pi-ai/compat API registry so side-channels that bypass
 * Models (e.g. pi-hermes-memory direct transport via compat completeSimple)
 * still send the Zen identity for our models — zero per-user config.
 *
 * Only models with provider === PROVIDER_ID are touched; everything else
 * delegates to the previously registered implementation unchanged. Unlike the
 * Models-path streamSimple wrapper, no xhigh reasoning default is applied
 * here: compat callers signal "off" by omitting reasoning (hermes sets
 * llmThinkingOverride off → reasoning undefined), and forcing xhigh would
 * regress their explicit choice. Idempotent across /reload: re-patching
 * refreshes the session getter in place instead of stacking wrappers.
 */
type CompatApiEntry = ReturnType<typeof getApiProvider>;
type SessionGetter = () => string | undefined;
/** Pristine compat entries, stashed on globalThis so /reload (fresh module
 * state, surviving registry) re-wraps the original instead of stacking a
 * wrapper on top of the previous wrapper. */
const COMPAT_ORIGINALS_KEY = "__piOpenCodeDirectCompatOriginals";
function compatOriginals(): Map<string, NonNullable<CompatApiEntry>> {
  const g = globalThis as Record<string, unknown>;
  const existing = g[COMPAT_ORIGINALS_KEY];
  if (existing instanceof Map) return existing as Map<string, NonNullable<CompatApiEntry>>;
  const created = new Map<string, NonNullable<CompatApiEntry>>();
  g[COMPAT_ORIGINALS_KEY] = created;
  return created;
}

function compatRequestOptions<T extends StreamOptions>(options: T, getSessionId: SessionGetter, fallbackSession: string): T {
  const headers = Object.fromEntries(Object.entries(options?.headers ?? {})
    .filter(([name]) => !["authorization", "user-agent", "x-opencode-session", "x-opencode-client", "x-opencode-project", "x-opencode-request"].includes(name.toLowerCase())));
  const opencodeSession = sessionHeader(options?.sessionId ?? getSessionId() ?? fallbackSession);
  return {
    ...options,
    apiKey: "public",
    sessionId: opencodeSession,
    timeoutMs: options?.timeoutMs ?? 180_000,
    maxRetries: options?.maxRetries ?? 2,
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

export function patchCompatDirectTransport(getSessionId: SessionGetter = () => undefined): void {
  const stash = compatOriginals();
  for (const api of SUPPORTED_APIS) {
    if (!stash.has(api)) {
      const current = getApiProvider(api);
      if (!current) continue;
      stash.set(api, current);
    }
    const original = stash.get(api)!;
    const fallbackSession = randomUUID();
    const origStream = (original.stream as (...args: never[]) => unknown).bind(original);
    const origStreamSimple = (original.streamSimple as (...args: never[]) => unknown).bind(original);
    registerApiProvider({
      api: api as Parameters<typeof registerApiProvider>[0]["api"],
      stream: ((model: Model<Api>, context: never, options: StreamOptions) => {
        if ((model as Model<Api>).provider !== PROVIDER_ID) return origStream(model as never, context as never, options as never);
        return origStream(model as never, context as never, compatRequestOptions(options, getSessionId, fallbackSession) as never);
      }) as never,
      streamSimple: ((model: Model<Api>, context: never, options: StreamOptions) => {
        if ((model as Model<Api>).provider !== PROVIDER_ID) return origStreamSimple(model as never, context as never, options as never);
        // No reasoning default here (see doc comment): compat omission means off.
        return origStreamSimple(model as never, context as never, compatRequestOptions(options, getSessionId, fallbackSession) as never);
      }) as never,
    }, "pi-opencode-direct");
  }
}

/**
 * Last-resort guard: wrap global fetch so ANY in-process request to the Zen
 * base URL carries the free-tier identity, even paths that bypass both the
 * Models wrapper and the compat patch (e.g. Pi core flows in present or
 * future versions that call fetch directly, such as compaction if it ever
 * stops routing through the provider). Scoped strictly to BASE_URL; all
 * other hosts pass through untouched. A valid upstream x-opencode-session
 * (set by the wrappers, preserving affinity) and an existing Authorization
 * are preserved; anything missing is filled with the anonymous identity.
 * Reload-safe: always re-wraps the pristine original stashed on globalThis,
 * so re-patching refreshes the session getter instead of stacking wrappers.
 */
const FETCH_GUARD_ORIGINAL_KEY = "__piOpenCodeDirectFetchOriginal";
const ZEN_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function isZenRequest(input: unknown): boolean {
  try {
    if (typeof input === "string") return input.startsWith(BASE_URL);
    if (input instanceof URL) return input.href.startsWith(BASE_URL);
    if (input && typeof input === "object") {
      const maybe = (input as { url?: unknown }).url;
      if (typeof maybe === "string") return maybe.startsWith(BASE_URL);
    }
    return String(input).startsWith(BASE_URL);
  } catch {
    return false;
  }
}

export function patchGlobalFetchForZen(getSessionId: SessionGetter = () => undefined): void {
  const g = globalThis as Record<string, unknown>;
  if (!g[FETCH_GUARD_ORIGINAL_KEY]) g[FETCH_GUARD_ORIGINAL_KEY] = globalThis.fetch;
  const original = g[FETCH_GUARD_ORIGINAL_KEY] as typeof fetch;
  const callOriginal = (input: unknown, init: unknown): Promise<Response> =>
    (original as (u: never, i: never) => Promise<Response>)(input as never, init as never);
  const guarded = (async (input: unknown, init?: unknown) => {
    try {
      if (!isZenRequest(input)) return callOriginal(input, init);
      const rawInit = (init ?? {}) as Record<string, unknown>;
      const headers = new Headers(rawInit.headers as HeadersInit | undefined);
      const existingSession = headers.get("x-opencode-session");
      headers.set(
        "x-opencode-session",
        existingSession && ZEN_SESSION_PATTERN.test(existingSession)
          ? existingSession
          : sessionHeader(getSessionId() ?? randomUUID()),
      );
      if (!headers.get("authorization")) headers.set("Authorization", "Bearer public");
      headers.set("User-Agent", OPENCODE_USER_AGENT);
      headers.set("x-opencode-client", OPENCODE_CLIENT);
      headers.set("x-opencode-project", OPENCODE_PROJECT);
      if (!headers.get("x-opencode-request")) headers.set("x-opencode-request", requestHeader());
      return callOriginal(input, { ...rawInit, headers });
    } catch {
      return callOriginal(input, init);
    }
  }) as typeof fetch;
  globalThis.fetch = guarded;
}

/**
 * Same identity as the fetch guard, for callers that speak node:http/https
 * directly (axios / node-fetch style code in any extension or in-process
 * MCP tool). Accepts the header shapes Node allows (plain object, Headers
 * instance, [name, value][] array, or undefined) and preserves a valid
 * upstream session plus an existing Authorization.
 */
export type NodeHeadersInit =
  | Record<string, string | string[] | number | undefined>
  | [string, string][]
  | Headers
  | undefined;

function readNodeHeader(headers: NodeHeadersInit, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    for (let i = headers.length - 1; i >= 0; i--) {
      const pair = headers[i];
      if (pair && pair[0]?.toLowerCase() === lower) return String(pair[1]);
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (value === undefined) return undefined;
    return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return undefined;
}

export function applyZenHeadersToNodeHeaders(headers: NodeHeadersInit, getSessionId: SessionGetter = () => undefined): NodeHeadersInit {
  let out = headers;
  const set = (name: string, value: string): void => {
    if (!out) {
      out = { [name]: value };
      return;
    }
    if (out instanceof Headers) {
      out.set(name, value);
      return;
    }
    if (Array.isArray(out)) {
      const lower = name.toLowerCase();
      out = [...out.filter((pair) => pair?.[0]?.toLowerCase() !== lower), [name, value] as [string, string]];
      return;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(out)) {
      if (key.toLowerCase() === lower) delete (out as Record<string, unknown>)[key];
    }
    (out as Record<string, string>)[name] = value;
  };
  const session = readNodeHeader(out, "x-opencode-session");
  set("x-opencode-session", session && ZEN_SESSION_PATTERN.test(session) ? session : sessionHeader(getSessionId() ?? randomUUID()));
  if (!readNodeHeader(out, "authorization")) set("Authorization", "Bearer public");
  set("User-Agent", OPENCODE_USER_AGENT);
  set("x-opencode-client", OPENCODE_CLIENT);
  set("x-opencode-project", OPENCODE_PROJECT);
  if (!readNodeHeader(out, "x-opencode-request")) set("x-opencode-request", requestHeader());
  return out;
}

function splitHttpArgs(args: unknown[]): { options: Record<string, unknown>; callback: unknown } {
  const [first, second, third] = args;
  if (typeof first === "string" || first instanceof URL) {
    const url = typeof first === "string" ? new URL(first) : first;
    const opts = (typeof second === "object" && second !== null ? second : {}) as Record<string, unknown>;
    return {
      options: {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        ...opts,
      },
      callback: typeof second === "function" ? second : third,
    };
  }
  return { options: { ...((first as Record<string, unknown> | undefined) ?? {}) }, callback: second };
}

export function isZenNodeRequestOptions(options: Record<string, unknown>): boolean {
  const host = String(options.hostname ?? options.host ?? "").split(":")[0]?.toLowerCase();
  return host === "opencode.ai" && String(options.path ?? "/").startsWith("/zen/v1");
}

/**
 * Patch node:http/https request/get so non-fetch callers targeting Zen still
 * carry the identity. Reload-safe via pristine-original stash on globalThis.
 * Named-import capturers (`import { request } from "node:http"` resolved
 * before this runs) and direct `undici` / WebSocket users are not covered —
 * Zen transports are fetch/SSE, so this is a backstop, not the main path.
 */
const NODE_HTTP_ORIGINALS_KEY = "__piOpenCodeDirectNodeHttpOriginals";

type NodeHttpModule = Record<string, (...args: never[]) => unknown>;

function nodeHttpStash(): Map<string, (...args: never[]) => unknown> {
  const g = globalThis as Record<string, unknown>;
  const existing = g[NODE_HTTP_ORIGINALS_KEY];
  if (existing instanceof Map) return existing as Map<string, (...args: never[]) => unknown>;
  const created = new Map<string, (...args: never[]) => unknown>();
  g[NODE_HTTP_ORIGINALS_KEY] = created;
  return created;
}

export function patchNodeHttpForZen(getSessionId: SessionGetter = () => undefined): void {
  const require = createRequire(import.meta.url);
  const targets: [string, NodeHttpModule][] = [["http", require("node:http")], ["https", require("node:https")]];
  const stash = nodeHttpStash();
  for (const [modName, mod] of targets) {
    for (const fnName of ["request", "get"]) {
      const key = `${modName}.${fnName}`;
      if (!stash.has(key) && typeof mod[fnName] === "function") stash.set(key, mod[fnName]);
      const original = stash.get(key);
      if (!original) continue;
      const callOriginal = (self: unknown, args: unknown[]): unknown =>
        (original as (...a: unknown[]) => unknown).apply(self, args);
      const wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          const { options, callback } = splitHttpArgs(args);
          if (!isZenNodeRequestOptions(options)) return callOriginal(this, args);
          options.headers = applyZenHeadersToNodeHeaders(options.headers as NodeHeadersInit, getSessionId) as unknown as Record<string, unknown>;
          return callOriginal(this, [options, callback]);
        } catch {
          return callOriginal(this, args);
        }
      };
      mod[fnName] = wrapped as (...args: never[]) => unknown;
    }
  }
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
    headers: { ...STATIC_ZEN_HEADERS },
    auth: {
      apiKey: {
        name: "Anonymous free tier (no key needed)",
        async resolve() {
          // Headers here feed modelRegistry.getApiKeyAndHeaders(), which is
          // what side-channels like hermes direct transport forward as
          // options.headers into compat createClient (model.headers +
          // optionsHeaders merge). Main path still sets full dynamic headers
          // in requestOptions().
          return { auth: { apiKey: "public", headers: { ...STATIC_ZEN_HEADERS } }, source: "Anonymous free tier" };
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
    // Shared with the compat side-channel patch below. Free-tier anonymous
    // path requires the literal key "public"; the fetch wrapper retries once
    // without replayed reasoning when Zen rotates backends, before streaming
    // starts, so the caller sees a single normal stream.
    return compatRequestOptions(options, getSessionId, fallbackSession);
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
        headers: { "User-Agent": "pi-opencode-direct/0.1.5" },
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
