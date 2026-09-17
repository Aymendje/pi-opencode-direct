# Changelog

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
