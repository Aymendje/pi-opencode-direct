import { createHash, randomUUID } from "node:crypto";
import {
  createProvider,
  type Api, type Model, type Provider, type StreamOptions,
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

export function sessionHeader(sessionId: string): string {
  return createHash("sha256").update(`${PROVIDER_ID}:${sessionId}`).digest("hex");
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
          return { auth: { apiKey: "anonymous" }, source: "Anonymous free tier" };
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
      .filter(([name]) => !["authorization", "x-opencode-session"].includes(name.toLowerCase())));
    return {
      ...options,
      // The SDK needs a nonempty placeholder; null suppresses its Authorization header.
      apiKey: "anonymous",
      timeoutMs: options?.timeoutMs ?? 180_000,
      maxRetries: options?.maxRetries ?? 2,
      headers: {
        ...headers,
        Authorization: null,
        "x-opencode-session": sessionHeader(options?.sessionId ?? getSessionId() ?? fallbackSession),
        "User-Agent": "pi-opencode-direct/0.1.0",
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
        headers: { "User-Agent": "pi-opencode-direct/0.1.0" },
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
