import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchCompatDirectTransport, patchGlobalFetchForZen, patchNodeHttpForZen, zenProvider } from "./provider.ts";
import { registerGoUsageSource } from "./usage.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  const remember = (_event: unknown, ctx: ExtensionContext) => { context = ctx; };
  pi.on("session_start", remember);
  // OpenCode Go subscription meter for gentle-shell (`/gentle:usage`).
  // Emitted at factory time and re-emitted on every session_start: the shell
  // subscribes when its own factory runs, so a single factory-time emit can
  // be lost to load order. Re-registration replaces per provider, so this
  // is idempotent, not an accumulation.
  registerGoUsageSource(pi.events);
  pi.on("session_start", () => registerGoUsageSource(pi.events));
  pi.on("before_agent_start", remember);
  const getSessionId = () => context?.sessionManager.getSessionId();
  pi.registerProvider(zenProvider(getSessionId));
  // Cover side-channels that bypass Models (e.g. pi-hermes-memory direct
  // transport via pi-ai/compat): same Zen identity, no per-user config.
  // Never let a side-channel patch failure break provider registration.
  try {
    patchCompatDirectTransport(getSessionId);
  } catch {
    // Main-path streaming still works; direct side-channels fall back to
    // static model/auth headers.
  }
  // Last resort: any other in-process fetch to Zen (present/future Pi flows
  // such as compaction if rerouted) still carries the identity.
  try {
    patchGlobalFetchForZen(getSessionId);
  } catch {
    // Wrappers above already cover the known paths.
  }
  // Same for non-fetch callers (axios / node-fetch style) in any extension
  // or in-process MCP tool.
  try {
    patchNodeHttpForZen(getSessionId);
  } catch {
    // Fetch-level coverage above is the common case.
  }
}
