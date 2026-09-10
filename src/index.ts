import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { zenProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  const remember = (_event: unknown, ctx: ExtensionContext) => { context = ctx; };
  pi.on("session_start", remember);
  pi.on("before_agent_start", remember);
  pi.registerProvider(zenProvider(() => context?.sessionManager.getSessionId()));
}
