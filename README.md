# pi-opencode-direct

Free OpenCode Zen models in Pi through native HTTP requests. No OpenCode
installation, login, API key, server, container, or LiteLLM is required.

## Install

Requires Pi 0.85.1 or newer (tested with 0.85.1) and Node 22.19 or newer.

```sh
pi install npm:pi-opencode-direct
```

For development, run `npm ci --ignore-scripts` followed by `pi install .`
from a checkout of this repository. Install through npm or Pi so that peer
packages needed by the native transport imports are available.

Restart Pi or use `/reload`, then select **OpenCode Zen Free** in `/model`.

```sh
pi --provider opencode-zen-free --model muse-spark-1.3-contributor-free --thinking xhigh
```

Muse Spark supports native images, reasoning, and tool calls. Pi's thinking
selector exposes `minimal`, `low`, `medium`, `high`, and `xhigh`. An explicit Pi
thinking setting wins; requests without one default to `xhigh` for Muse Spark.
The provider also registers the other known free models supported by Pi's
Chat Completions transport. Their capabilities and limits come from Pi's
built-in OpenCode catalogue rather than guessed defaults.

## How it works

The extension adds a separate `opencode-zen-free` provider. It uses Pi's native
Responses transport for Muse Spark and native Chat Completions for the other
supported free models. Native Pi streaming handles text, thinking, tool-call
arguments, usage, aborts, and tool-result replay. Tools execute through Pi.

Every request is anonymous. A placeholder satisfies the SDK, but its bearer
header is removed before transmission; stored or environment API keys are
not used. A hash of Pi's session ID supplies `x-opencode-session`, keeping
routing affinity stable across turns and distinct between sessions. Auxiliary
calls use the active Pi session when no explicit session ID is available.

A bounded public-catalogue refresh intersects the currently listed IDs with
Pi's known zero-cost models. Unknown models and paid models are not registered.
Pi's model cache is used offline, with the bundled catalogue as the initial
fallback. Update Pi for newly added model metadata. Free-model availability
and limits can change upstream; there is no automatic paid fallback.

Requests use Pi's native retry handling (two retries by default) and a
180-second per-request timeout. Caller overrides and cancellation are honored.
Muse Spark currently accepts only `tool_choice: auto`; normal Pi tool use does
not require forced tool choice.

## Memory extensions (pi-hermes-memory)

Background-review direct transport (`pi-ai/compat completeSimple`) bypasses
the `stream()` wrapper, so this extension patches the global compat registry
at load: `opencode-zen-free` models get the full dynamic identity there too
(`Bearer public`, OpenCode `User-Agent` / `x-opencode-client` / `project` /
per-session `x-opencode-session` / per-request `x-opencode-request`, plus the
encrypted-content retry), while other providers pass through untouched. No
memory config needed for the default direct transport — and compat omission
stays `off`, preserving Hermes `llmThinkingOverride: off` (no forced `xhigh`
on this path).

As a last resort, a fetch guard scoped strictly to `https://opencode.ai/zen/v1`
adds the same identity at the network edge for any other in-process path
(Pi core flows such as compaction, present or future) — other hosts pass
through untouched, and a valid upstream session / existing Authorization are
preserved.

The `pi -p --no-session` subprocess transport is a separate process, so no
in-process patch can cover it: it loads `--no-extensions` + Hermes only and
cannot see `opencode-zen-free` on its own. That path only runs when direct
fails (or `reviewTransport` is forced to `subprocess`), so with direct fixed
no config is needed. If you force subprocess, expose this package to the
child with an absolute file path:

```json
{
  "childExtensionPaths": ["/path/to/pi-opencode-direct/src/index.ts"]
}
```

## Development

```sh
npm ci --ignore-scripts
npm run verify

# Optional: sends real requests to Zen
npm run test:live
```

`npm test` uses in-memory HTTP fixtures, with no network or model calls.
`test:live` is opt-in and sends two small free-tier requests to verify images,
xhigh reasoning, native streaming tool calls, and replay of a tool result.
Use the free tier lightly and follow the provider's data-use policies.

Validated with Pi 0.85.1: seven automated tests; live image recognition with a
native tool-call/result round trip; and a Pi CLI session that used `read` on a
PNG and correctly described it while OpenCode was absent from `PATH`.

`npm run verify` runs type checking, fixture tests, and an npm package dry run.
CI runs these checks on Node 22, 24, and 26. See [PUBLISHING.md](PUBLISHING.md)
for release steps and [CHANGELOG.md](CHANGELOG.md) for changes.

## License

MIT. This is an independent extension, not an official OpenCode or Pi package.
