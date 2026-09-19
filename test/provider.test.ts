import assert from "node:assert/strict";
import test from "node:test";
import { createModels, Type, type Model, type Api, type FetchFunction } from "@earendil-works/pi-ai";
import { freeModels, zenProvider, PROVIDER_ID, sessionHeader, requestHeader, OPENCODE_USER_AGENT, STATIC_ZEN_HEADERS, isEncryptedContentError, stripStaleReasoning } from "../src/provider.ts";

const muse = (p = zenProvider()) => p.getModels().find(m => m.id === "muse-spark-1.3-contributor-free")!;
const context = { messages: [{ role: "user" as const, content: "Test", timestamp: 1 }] };
const usage = { input_tokens: 12, output_tokens: 8, total_tokens: 20, output_tokens_details: { reasoning_tokens: 3 } };
const text = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking.", annotations: [] }] };
const call = { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"key":"weather"}', status: "completed" };
const thinking = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Reasoning." }], encrypted_content: "opaque-signature" };

function response(items: unknown[] = [text]) {
  const events: unknown[] = [];
  for (const [i, item] of items.entries()) {
    events.push({ type: "response.output_item.added", output_index: i, item });
    events.push({ type: "response.output_item.done", output_index: i, item });
  }
  events.push({ type: "response.completed", response: { id: "resp_1", status: "completed", output: items, usage } });
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function capture(items?: unknown[]) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const fetch: FetchFunction = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return response(items);
  };
  return { fetch, calls };
}

test("free catalogue uses Pi capabilities and excludes paid models", () => {
  const models = freeModels();
  assert.ok(models.length > 0);
  assert.ok(models.every(m => m.provider === PROVIDER_ID && Object.values(m.cost).every(v => v === 0)));
  assert.ok(!models.some(m => m.id === "muse-spark-1.3"));
  assert.deepEqual(muse().input, ["text", "image"]);
  assert.equal(muse().thinkingLevelMap?.xhigh, "xhigh");
});

test("live refresh intersects known free models and preserves catalogue on failure", async () => {
  const p = zenProvider(); const models = createModels(); models.setProvider(p);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ data: [{ id: muse().id }, { id: "gpt-6-astra" }, { id: "unknown-free" }] });
    assert.equal((await models.refresh()).errors.size, 0);
    assert.deepEqual(p.getModels().map(m => m.id), [muse().id]);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal((await models.refresh()).errors.size, 1);
    assert.deepEqual(p.getModels().map(m => m.id), [muse().id]);
  } finally { globalThis.fetch = original; }
});

test("anonymous Responses requests preserve xhigh, images, and text-before-tool calls", async () => {
  const p = zenProvider(); const c = capture([thinking, text, call]);
  const result = await p.streamSimple(muse(p), {
    messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "Look" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }],
    tools: [{ name: "lookup", description: "Look up a key", parameters: Type.Object({ key: Type.String() }) }],
  }, { fetch: c.fetch, sessionId: "session-a", maxRetries: 0 }).result();
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.ok(result.content.some(b => b.type === "text" && b.text === "Checking."));
  assert.ok(result.content.some(b => b.type === "toolCall" && b.name === "lookup" && b.arguments.key === "weather"));
  assert.ok(result.content.some(b => b.type === "thinking" && b.thinkingSignature?.includes("opaque-signature")));
  const request = c.calls[0];
  assert.equal(request.url, "https://opencode.ai/zen/v1/responses");
  assert.equal(request.headers.get("authorization"), "Bearer public");
  assert.equal(request.headers.get("x-opencode-session"), sessionHeader("session-a"));
  assert.equal(request.body.reasoning.effort, "xhigh");
  assert.equal(request.body.tools[0].name, "lookup");
  assert.ok(request.body.input.some((m: any) => m.content?.some((b: any) => b.type === "input_image")));
});

test("explicitly resolved keys are honored instead of anonymous", async () => {
  const p = zenProvider(); const c = capture([text]);
  const result = await p.streamSimple(muse(p), context, {
    fetch: c.fetch, sessionId: "session-a", apiKey: "sk-zen-real", headers: { authorization: "Bearer stale" }, maxRetries: 0,
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  // Authorization is rebuilt from the effective key so it can never mismatch.
  assert.equal(c.calls[0].headers.get("authorization"), "Bearer sk-zen-real");
  assert.equal(c.calls[0].headers.get("x-opencode-session"), sessionHeader("session-a"));
});

test("key priority is stored credential, then env, then anonymous", async () => {
  const { resolveZenApiKey } = await import("../src/provider.ts");
  const ctx = (env: Record<string, string | undefined>) => ({
    env: async (name: string) => env[name],
  });
  assert.deepEqual(await resolveZenApiKey({ ctx: ctx({}), credential: undefined }), { apiKey: "public", source: "Anonymous free tier" });
  assert.deepEqual(
    await resolveZenApiKey({ ctx: ctx({ OPENCODE_API_KEY: "sk-env" }), credential: undefined }),
    { apiKey: "sk-env", source: "OPENCODE_API_KEY" },
  );
  assert.deepEqual(
    await resolveZenApiKey({ ctx: ctx({ OPENCODE_API_KEY: "sk-env" }), credential: { key: "sk-stored", env: { A: "b" } } }),
    { apiKey: "sk-stored", env: { A: "b" }, source: "stored credential" },
  );

  const p = zenProvider();
  const apiKey = (p as unknown as { auth: { apiKey: {
    resolve: (args: unknown) => Promise<{ auth: { apiKey: string; headers: unknown }; env: unknown; source: string }>;
    login: (interaction: unknown) => Promise<{ type: string; key: string }>;
  } } }).auth.apiKey;
  const resolved = await apiKey.resolve({ ctx: ctx({ OPENCODE_API_KEY: "sk-env" }), credential: undefined, signal: undefined });
  assert.equal(resolved.auth.apiKey, "sk-env");
  assert.equal(resolved.source, "OPENCODE_API_KEY");
  assert.equal((resolved.auth.headers as Record<string, string>)["User-Agent"], OPENCODE_USER_AGENT);
  assert.deepEqual(await apiKey.login({ prompt: async () => "sk typed " }), { type: "api_key", key: "sk typed" });
  await assert.rejects(apiKey.login({ prompt: async () => "  " }), /anonymous free tier/);
});

test("session affinity is stable per session and explicit thinking is respected", async () => {
  let session = "first"; const p = zenProvider(() => session); const c = capture();
  await p.streamSimple(muse(p), context, { fetch: c.fetch, reasoning: "low" }).result();
  await p.streamSimple(muse(p), context, { fetch: c.fetch }).result();
  session = "second";
  await p.streamSimple(muse(p), context, { fetch: c.fetch }).result();
  assert.equal(c.calls[0].body.reasoning.effort, "low");
  assert.equal(c.calls[0].headers.get("x-opencode-session"), c.calls[1].headers.get("x-opencode-session"));
  assert.notEqual(c.calls[0].headers.get("x-opencode-session"), c.calls[2].headers.get("x-opencode-session"));
});

test("opencode session ids use ses_ hex+base62 structure and stay stable", () => {
  for (const s of ["session-a", "first", "second"]) {
    const id = sessionHeader(s);
    assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  }
  assert.equal(sessionHeader("first"), sessionHeader("first"));
  assert.notEqual(sessionHeader("first"), sessionHeader("second"));
  assert.match(requestHeader(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("responses requests send opencode headers and matching cache key", async () => {
  const p = zenProvider(); const c = capture();
  await p.streamSimple(muse(p), context, { fetch: c.fetch, sessionId: "session-a" }).result();
  const request = c.calls[0];
  assert.equal(request.headers.get("x-opencode-client"), "cli");
  assert.equal(request.headers.get("x-opencode-project"), "global");
  assert.match(request.headers.get("x-opencode-request") ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(request.headers.get("user-agent"), OPENCODE_USER_AGENT);
  assert.equal(request.body.prompt_cache_key, request.headers.get("x-opencode-session"));
});

test("tool result replay keeps matching call IDs and reasoning signatures", async () => {
  const p = zenProvider(); const c = capture([thinking, text, call]);
  const assistant = await p.streamSimple(muse(p), context, { fetch: c.fetch }).result();
  const tool = assistant.content.find(b => b.type === "toolCall")!;
  const next = capture();
  await p.streamSimple(muse(p), { messages: [...context.messages, assistant, { role: "toolResult", timestamp: 2, toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: "Sunny" }], isError: false }] }, { fetch: next.fetch }).result();
  const input = next.calls[0].body.input;
  assert.ok(input.some((m: any) => m.type === "reasoning" && m.encrypted_content === "opaque-signature"));
  const sentCall = input.find((m: any) => m.type === "function_call");
  const sentResult = input.find((m: any) => m.type === "function_call_output");
  assert.equal(sentCall.call_id, sentResult.call_id);
});

test("Chat Completions models use their native endpoint anonymously", async () => {
  const p = zenProvider(); let url = ""; let headers = new Headers();
  const fetch: FetchFunction = async (u, init) => {
    url = String(u); headers = new Headers(init?.headers);
    return new Response('data: {"id":"chat_1","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"chat_1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  };
  const model = p.getModels().find(m => m.id === "big-pickle")!;
  const result = await p.streamSimple(model, context, { fetch, sessionId: "chat-a" }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(url, "https://opencode.ai/zen/v1/chat/completions");
  assert.equal(headers.get("authorization"), "Bearer public");
  assert.equal(headers.get("x-opencode-session"), sessionHeader("chat-a"));
});

test("cancellation aborts native requests and errors do not become successful answers", async () => {
  const p = zenProvider(); const controller = new AbortController(); controller.abort();
  const aborted = await p.streamSimple(muse(p), context, { signal: controller.signal, fetch: async () => { throw new DOMException("Aborted", "AbortError"); }, maxRetries: 0 }).result();
  assert.equal(aborted.stopReason, "aborted");
  const failed = await p.streamSimple(muse(p), context, { fetch: async () => Response.json({ error: { message: "Rate limit", type: "rate_limit_error" } }, { status: 429 }), maxRetries: 0 }).result();
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage!, /Rate limit/);
});

test("encrypted_content rotation is detected", () => {
  assert.equal(isEncryptedContentError(400, "reasoning `encrypted_content` was not issued to this caller"), true);
  assert.equal(isEncryptedContentError(400, "The encrypted content gAAA= could not be verified."), true);
  assert.equal(isEncryptedContentError(400, "Rate limit"), false);
  assert.equal(isEncryptedContentError(429, "encrypted_content was not issued"), false);
});

test("stripStaleReasoning drops reasoning and orphaned call ids", () => {
  const payload = { model: "m", input: [thinking, { ...call }, text] };
  const stripped = stripStaleReasoning(payload) as { input: any[] };
  assert.ok(stripped);
  assert.ok(!stripped.input.some((m: any) => m.type === "reasoning"));
  assert.ok(stripped.input.some((m: any) => m.type === "function_call" && m.call_id === "call_1" && !("id" in m)));
  assert.equal(stripStaleReasoning({ input: [text] }), null);
  assert.equal(stripStaleReasoning({ messages: [] }), null);
});

test("Zen rotation retries once without replayed reasoning", async () => {
  const p = zenProvider();
  const model = muse(p);
  const withHistory = {
    messages: [
      ...context.messages,
      {
        role: "assistant" as const,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: 1,
        content: [{ type: "thinking" as const, thinking: "", thinkingSignature: JSON.stringify(thinking) }],
      },
    ],
  };
  let secondCalls = 0;
  const bodies2: any[] = [];
  const fetch2: FetchFunction = async (_url, init) => {
    secondCalls++;
    bodies2.push(JSON.parse(String((init as { body?: unknown })?.body)));
    if (secondCalls === 1) return Response.json({ error: { message: "Error from provider (Console): Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller", type: "invalid_request_error", param: null } }, { status: 400 });
    return response([text]);
  };
  const retried = await p.streamSimple(model, withHistory, { fetch: fetch2, maxRetries: 0 }).result();
  assert.equal(retried.stopReason, "stop", retried.errorMessage);
  assert.equal(secondCalls, 2);
  assert.ok(bodies2[0].input.some((m: any) => m.type === "reasoning" && m.encrypted_content === "opaque-signature"));
  assert.ok(!bodies2[1].input.some((m: any) => m.type === "reasoning"));
  // Non-encrypted 400s are not retried.
  let plainCalls = 0;
  const plain = await p.streamSimple(model, context, { fetch: (async () => { plainCalls++; return Response.json({ error: { message: "Bad request" } }, { status: 400 }); }) as FetchFunction, maxRetries: 0 }).result();
  assert.equal(plain.stopReason, "error");
  assert.equal(plainCalls, 1);
});

test("static gate headers survive side-channels that bypass requestOptions()", async () => {
  // pi-hermes-memory direct transport resolves auth via
  // modelRegistry.getApiKeyAndHeaders(model) and calls compat completeSimple,
  // which merges model.headers then options headers in createClient. It never
  // calls zenProvider().stream() wrapper, so the OpenCode identity must live
  // on the model + provider + auth, not only in requestOptions().
  const p = zenProvider();
  for (const m of p.getModels()) {
    assert.equal(m.headers?.["User-Agent"], OPENCODE_USER_AGENT);
    assert.equal(m.headers?.["x-opencode-client"], "cli");
    assert.equal(m.headers?.["x-opencode-project"], "global");
  }
  const providerEntry = (p as unknown as { headers?: Record<string, string> }).headers
    ?? (p as unknown as { id: string }).id === PROVIDER_ID ? STATIC_ZEN_HEADERS : undefined;
  assert.deepEqual(providerEntry, STATIC_ZEN_HEADERS);

  const models = createModels();
  models.setProvider(p);
  const model = muse(p);
  const resolved = await models.getAuth(model);
  assert.equal(resolved?.auth.apiKey, "public");
  assert.equal(resolved?.auth.headers?.["User-Agent"], OPENCODE_USER_AGENT);
  assert.equal(resolved?.auth.headers?.["x-opencode-client"], "cli");
  assert.equal(resolved?.auth.headers?.["x-opencode-project"], "global");

  // Simulate compat createClient merge: { UA: pi-default, ...model.headers } + optionsHeaders
  const merged: Record<string, string> = {
    "User-Agent": "pi/0.0.0",
    ...(model.headers ?? {}),
    ...(resolved?.auth.headers ?? {}),
  };
  assert.equal(merged["User-Agent"], OPENCODE_USER_AGENT);
  assert.equal(merged["x-opencode-client"], "cli");
  assert.equal(merged["x-opencode-project"], "global");
});

test("compat side-channel patch injects Zen identity for our models only", async () => {
  const compat = await import("@earendil-works/pi-ai/compat");
  const { patchCompatDirectTransport, sessionHeader: sesh } = await import("../src/provider.ts");
  try {
    patchCompatDirectTransport(() => "compat-session");
    const api = compat.getApiProvider("openai-responses");
    assert.ok(api);

    // Zen model via compat: headers injected, no forced xhigh (omission = off).
    const seen: { headers: Headers; body: any }[] = [];
    const spy: FetchFunction = async (_url, init) => {
      seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String((init as { body?: unknown })?.body)) });
      const events = [
        { type: "response.output_item.added", output_index: 0, item: text },
        { type: "response.output_item.done", output_index: 0, item: text },
        { type: "response.completed", response: { id: "resp_c", status: "completed", output: [text], usage } },
      ];
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    };
    const zm = muse();
    const out = await (api.streamSimple as any)(zm, context, { fetch: spy }).result();
    assert.equal(out.stopReason, "stop", out.errorMessage);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.get("authorization"), "Bearer public");
    assert.equal(seen[0].headers.get("user-agent"), OPENCODE_USER_AGENT);
    assert.equal(seen[0].headers.get("x-opencode-client"), "cli");
    assert.equal(seen[0].headers.get("x-opencode-project"), "global");
    assert.equal(seen[0].headers.get("x-opencode-session"), sesh("compat-session"));
    assert.match(seen[0].headers.get("x-opencode-request") ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(seen[0].body.reasoning, undefined);

    // Non-Zen model passes through untouched (no Zen headers).
    const other: Model<Api> = {
      id: "other-model", name: "Other", api: "openai-responses", provider: "other-provider",
      baseUrl: "https://example.com/v1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8000, maxTokens: 8000,
    };
    const seenOther: Headers[] = [];
    const spyOther: FetchFunction = async (_url, init) => {
      seenOther.push(new Headers(init?.headers));
      const events = [
        { type: "response.output_item.added", output_index: 0, item: text },
        { type: "response.output_item.done", output_index: 0, item: text },
        { type: "response.completed", response: { id: "resp_o", status: "completed", output: [text], usage } },
      ];
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    };
    await (api.streamSimple as any)(other, context, { fetch: spyOther, apiKey: "other-key" }).result();
    assert.equal(seenOther[0].get("x-opencode-session"), null);
    assert.equal(seenOther[0].get("x-opencode-client"), null);

    // Re-patching re-wraps the pristine original (no stacking) with the fresh getter.
    patchCompatDirectTransport(() => "compat-session-2");
    const seen2: { headers: Headers; body: any }[] = [];
    const spy2: FetchFunction = async (_url, init) => {
      seen2.push({ headers: new Headers(init?.headers), body: JSON.parse(String((init as { body?: unknown })?.body)) });
      const events = [
        { type: "response.output_item.added", output_index: 0, item: text },
        { type: "response.output_item.done", output_index: 0, item: text },
        { type: "response.completed", response: { id: "resp_c2", status: "completed", output: [text], usage } },
      ];
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    };
    await (compat.getApiProvider("openai-responses")!.streamSimple as any)(zm, context, { fetch: spy2 }).result();
    assert.equal(seen2[0].headers.get("x-opencode-session"), sesh("compat-session-2"));
  } finally {
    compat.resetApiProviders();
  }
});

test("global fetch guard covers raw Zen requests and ignores other hosts", async () => {
  const { patchGlobalFetchForZen, sessionHeader: sesh2 } = await import("../src/provider.ts");
  const realFetch = globalThis.fetch;
  try {
    const calls: { url: string; headers: Headers }[] = [];
    (globalThis as any).__piOpenCodeDirectFetchOriginal = (async (input: any, init?: any) => {
      calls.push({ url: String(typeof input === "string" ? input : input?.url ?? input), headers: new Headers(init?.headers) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    patchGlobalFetchForZen(() => "guard-session");
    // Other hosts pass through untouched.
    await globalThis.fetch("https://example.com/api", { headers: { "User-Agent": "keep-me" } });
    assert.equal(calls[0].headers.get("user-agent"), "keep-me");
    assert.equal(calls[0].headers.get("x-opencode-session"), null);

    // Raw Zen request gets the full identity with a valid session.
    await globalThis.fetch("https://opencode.ai/zen/v1/responses", { method: "POST" });
    const zen = calls[1].headers;
    assert.equal(zen.get("authorization"), "Bearer public");
    assert.equal(zen.get("user-agent"), OPENCODE_USER_AGENT);
    assert.equal(zen.get("x-opencode-client"), "cli");
    assert.equal(zen.get("x-opencode-project"), "global");
    assert.equal(zen.get("x-opencode-session"), sesh2("guard-session"));
    assert.match(zen.get("x-opencode-request") ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

    // Upstream-set identity is preserved (affinity + explicit auth).
    await globalThis.fetch("https://opencode.ai/zen/v1/chat/completions", {
      headers: { Authorization: "Bearer real-key", "x-opencode-session": sesh2("upstream-session") },
    });
    const kept = calls[2].headers;
    assert.equal(kept.get("authorization"), "Bearer real-key");
    assert.equal(kept.get("x-opencode-session"), sesh2("upstream-session"));

    // Re-patching refreshes the getter without stacking (one underlying call).
    patchGlobalFetchForZen(() => "guard-session-2");
    await globalThis.fetch("https://opencode.ai/zen/v1/models");
    assert.equal(calls[3].headers.get("x-opencode-session"), sesh2("guard-session-2"));
  } finally {
    globalThis.fetch = realFetch;
    delete (globalThis as any).__piOpenCodeDirectFetchOriginal;
  }
});

test("node:http guard injects Zen identity for Zen hosts only", async () => {
  const mod = await import("../src/provider.ts");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const httpMod = require("node:http") as Record<string, (...args: any[]) => unknown>;
  const httpsMod = require("node:https") as Record<string, (...args: any[]) => unknown>;
  const savedHttpRequest = httpMod.request;
  const savedHttpGet = httpMod.get;
  const savedHttpsRequest = httpsMod.request;
  const savedHttpsGet = httpsMod.get;
  const stashKey = "__piOpenCodeDirectNodeHttpOriginals";
  const savedStash = (globalThis as any)[stashKey];
  try {
    // Pure helper: all shapes.
    const fromUndef = mod.applyZenHeadersToNodeHeaders(undefined, () => "helper-session") as Record<string, string>;
    assert.equal(fromUndef["Authorization"], "Bearer public");
    assert.equal(fromUndef["User-Agent"], OPENCODE_USER_AGENT);
    assert.equal(fromUndef["x-opencode-session"], mod.sessionHeader("helper-session"));
    const fromArray = mod.applyZenHeadersToNodeHeaders([["X-Opencode-Session", mod.sessionHeader("keep-me")], ["Accept", "x"]] as any, () => "other") as [string, string][];
    assert.ok(fromArray.some(([k, v]) => k.toLowerCase() === "x-opencode-session" && v === mod.sessionHeader("keep-me")));
    assert.ok(fromArray.some(([k]) => k === "x-opencode-client"));
    const fromHeaders = mod.applyZenHeadersToNodeHeaders(new Headers({ Authorization: "Bearer real" }), () => "s") as Headers;
    assert.equal(fromHeaders.get("authorization"), "Bearer real");

    assert.equal(mod.isZenNodeRequestOptions({ hostname: "opencode.ai", path: "/zen/v1/responses" }), true);
    assert.equal(mod.isZenNodeRequestOptions({ host: "opencode.ai:443", path: "/zen/v1/models" }), true);
    assert.equal(mod.isZenNodeRequestOptions({ hostname: "example.com", path: "/zen/v1/responses" }), false);
    assert.equal(mod.isZenNodeRequestOptions({ hostname: "opencode.ai", path: "/other" }), false);

    // Wrapper delegation with stubbed originals (no network).
    const received: { options: any }[] = [];
    const stubOriginal = function (options: any) {
      received.push({ options });
      return { stubbed: true };
    };
    (globalThis as any)[stashKey] = new Map(Object.entries({
      "http.request": stubOriginal, "http.get": stubOriginal,
      "https.request": stubOriginal, "https.get": stubOriginal,
    }));
    mod.patchNodeHttpForZen(() => "node-session");
    const out = httpMod.request({ hostname: "opencode.ai", path: "/zen/v1/responses", headers: {} }) as any;
    assert.equal(out.stubbed, true);
    assert.equal(received[0].options.headers["x-opencode-session"], mod.sessionHeader("node-session"));
    assert.equal(received[0].options.headers["Authorization"], "Bearer public");
    const before = received.length;
    (httpMod.request as any)({ hostname: "example.com", path: "/" });
    assert.equal(received[before].options.headers, undefined);
    assert.equal(received[before].options.hostname, "example.com");
  } finally {
    httpMod.request = savedHttpRequest as any;
    httpMod.get = savedHttpGet as any;
    httpsMod.request = savedHttpsRequest as any;
    httpsMod.get = savedHttpsGet as any;
    if (savedStash === undefined) delete (globalThis as any)[stashKey];
    else (globalThis as any)[stashKey] = savedStash;
  }
});

test("x-client-request-id survives cacheRetention none (compaction)", async () => {
  // Pi core compaction forces cacheRetention "none", for which pi-ai drops its
  // own x-client-request-id downstream. The extension sets it explicitly so
  // the drop cannot remove it.
  const p = zenProvider(() => "compact-session");
  const c = capture([text]);
  const models = createModels();
  models.setProvider(p);
  const model = muse(p);
  const out = await models.completeSimple(model, context, {
    fetch: c.fetch, cacheRetention: "none", sessionId: "s-unset", maxRetries: 0,
  } as any);
  assert.equal(out.stopReason, "stop", (out as any).errorMessage);
  const h = c.calls[0].headers;
  assert.equal(h.get("x-client-request-id"), h.get("x-opencode-session"));
  assert.match(h.get("x-client-request-id") ?? "", /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

  // Fetch and node guards backfill it too.
  const { patchGlobalFetchForZen } = await import("../src/provider.ts");
  const realFetch = globalThis.fetch;
  try {
    (globalThis as any).__piOpenCodeDirectFetchOriginal = (async (_u: any, init?: any) => {
      const hh = new Headers(init?.headers);
      assert.ok(hh.get("x-client-request-id"));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    patchGlobalFetchForZen(() => "guard-session");
    await globalThis.fetch("https://opencode.ai/zen/v1/models");
  } finally {
    globalThis.fetch = realFetch;
    delete (globalThis as any).__piOpenCodeDirectFetchOriginal;
  }
  const mod = await import("../src/provider.ts");
  const viaNode = mod.applyZenHeadersToNodeHeaders({}, () => "node-session") as Record<string, string>;
  assert.match(viaNode["x-client-request-id"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("anonymous compaction uses OpenCode byte-identical prompt", async () => {
  const mod = await import("../src/provider.ts");
  const piPrompt = "You are a context summarization assistant. Your task is to read a conversation.";
  // Unit: swap applies anonymously, preserves everything else.
  const swapped: any = mod.swapCompactionPrompt({ systemPrompt: piPrompt, messages: [] }, undefined);
  assert.equal(swapped.systemPrompt, mod.OPENCODE_SUMMARIZATION_PROMPT);
  assert.deepEqual(swapped.messages, []);
  // Unit: keyed requests keep Pi's prompt.
  const keyed: any = mod.swapCompactionPrompt({ systemPrompt: piPrompt }, "sk-zen");
  assert.equal(keyed.systemPrompt, piPrompt);
  // Unit: anything else untouched.
  assert.equal((mod.swapCompactionPrompt({ systemPrompt: "chat normally" }, undefined) as any).systemPrompt, "chat normally");
  const longCtx: any = { systemPrompt: `${piPrompt} ${"x".repeat(3000)}` };
  assert.equal((mod.swapCompactionPrompt(longCtx, undefined) as any).systemPrompt, longCtx.systemPrompt);

  // Integration: serialized developer content on the wire is byte-identical.
  const p = mod.zenProvider();
  const calls: { body: any }[] = [];
  const fetchSpy = (async (_u: unknown, init: any) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return Response.json({ error: { message: "dump", type: "dump" } }, { status: 400 });
  }) as any;
  const model: any = p.getModels().find((m: any) => m.id === "muse-spark-1.3-contributor-free")!;
  await (p as any).streamSimple(model, {
    systemPrompt: piPrompt,
    messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "Summarize this." }] }],
  }, { fetch: fetchSpy, maxRetries: 0 }).result().catch(() => {});
  const dev = calls[0].body.input.find((m: any) => m.role === "developer");
  assert.equal(dev.content, mod.OPENCODE_SUMMARIZATION_PROMPT);
});
