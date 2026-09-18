# Changelog

## 0.1.5

- Last-resort fetch guard: any other in-process `fetch` to `https://opencode.ai/zen/v1` (present or future Pi flows, e.g. compaction if rerouted off the provider) gets the same identity at the network edge. Strictly scoped to the Zen base URL, preserves a valid upstream session and an existing Authorization, reload-safe via pristine-original stash.
- Same coverage for non-fetch callers: `node:http`/`https` `request`/`get` targeting `opencode.ai/zen/v1` (axios / node-fetch style code in any extension or in-process MCP tool) get the identity injected across all header shapes (object, `Headers`, pair array). Other hosts pass through untouched. Not covered: separate processes (Hermes children, MCP stdio servers calling Zen themselves), direct `undici` imports, named-import capturers bound before load, WebSocket (unused by Zen transports).

## 0.1.4

- Fix `pi-hermes-memory` background-review direct transport (`Memory auto-review failed ... FreeTierError ... can only be used from within OpenCode`): the OpenCode `User-Agent` / `x-opencode-client` / `x-opencode-project` identity now lives on `provider.headers`, `model.headers`, and `auth.resolve()` headers, not only in the `stream()`/`streamSimple()` wrapper. Side-channels that use `modelRegistry.getApiKeyAndHeaders()` + `pi-ai/compat completeSimple` (which never call the wrapper) now pass the gate. Dynamic `x-opencode-session` / `x-opencode-request` / `Authorization` stay per-request in the wrapper.
- Zero-config memory side-channels: the extension also patches the global `pi-ai/compat` API registry at load so `completeSimple`/`streamSimple` calls that bypass Models send the full dynamic Zen identity (`Bearer public`, OpenCode `User-Agent` / `x-opencode-client` / `x-opencode-project`, per-session `x-opencode-session`, per-request `x-opencode-request`, encrypted-content fetch retry) for `opencode-zen-free` models only. No `llmModelOverride` / `childExtensionPaths` needed for the default direct transport. Deliberately no `xhigh` default on this path: compat omission stays `off`, preserving `llmThinkingOverride: off`. Reload-safe via pristine-original stash (no wrapper stacking).
- Note: the Hermes `pi -p` subprocess transport still spawns with `--no-extensions` + only Hermes loaded, so `opencode-zen-free/... not found` there needs `"childExtensionPaths": ["/path/to/pi-opencode-direct/src/index.ts"]` in `hermes-memory-config.json` — only relevant when direct fails or `reviewTransport` is forced to `subprocess`.

## 0.1.3

- Recover from OpenCode's free-tier `from within OpenCode` gate: send `Authorization: Bearer public`, the exact OpenCode `User-Agent` / `x-opencode-client` / `x-opencode-project` / `x-opencode-request` headers, and a structurally valid `ses_` session id (`12` hex + `14` base62) with a matching `prompt_cache_key`.

## 0.1.2

- Declare `@earendil-works/pi-ai` as a real dependency (pinned to the validated Pi) instead of peer-only. Pi installs with `--legacy-peer-deps`, which never auto-installs peers, so on machines where no sibling extension provides `pi-ai` the extension failed to load with `Cannot find module ... openai-completions.lazy`.

## 0.1.1

- Recover long sessions when Zen rotates backends: retry once without replayed `reasoning.encrypted_content` on `was not issued to this caller` / `could not be verified` 400s, dropping orphaned function-call ids to avoid pairing validation.

## 0.1.0

- Connect Pi directly to OpenCode Zen's anonymous free tier.
- Support Muse Spark images, configurable thinking, streaming, and native tool calls.
- Register other known free models through Pi's native Chat Completions transport.
- Refresh available models against Zen's public catalogue while retaining Pi's model metadata.
- Keep session routing stable without sending API credentials.
