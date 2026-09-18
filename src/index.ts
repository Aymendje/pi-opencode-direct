import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchCompatDirectTransport, zenProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  const remember = (_event: unknown, ctx: ExtensionContext) => { context = ctx; };
  pi.on("session_start", remember);
  pi.on("before_agent_start", remember);
  const getSessionId = () => context?.sessionManager.getSessionId();
  pi.registerProvider(zenProvider(getSessionId));
  // Cover side-channels that bypass Models (e.g. pi-hermes-memory direct
  // transport via pi-ai/compat): same Zen identity, no per-user config.
  // Never let a compat-registry failure break provider registration.
  try {
    patchCompatDirectTransport(getSessionId);
  } catch {
    // Main-path streaming still works; direct side-channels fall back to
    // static model/auth headers from 0.1.4 (compat patch below covers the rest).
  }
}
