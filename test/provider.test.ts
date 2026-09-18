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
  }, { fetch: c.fetch, sessionId: "session-a", apiKey: "must-not-send", headers: { authorization: "Bearer must-not-send" }, maxRetries: 0 }).result();
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
