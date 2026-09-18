import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchCompatDirectTransport, patchGlobalFetchForZen, patchNodeHttpForZen, zenProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  const remember = (_event: unknown, ctx: ExtensionContext) => { context = ctx; };
  pi.on("session_start", remember);
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
