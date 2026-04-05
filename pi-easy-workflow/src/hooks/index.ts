import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerInputHook, registerInputTransformer } from "./input";
import { registerToolCallHook, registerPermissionHook } from "./tool-call";
import { registerBeforeAgentStartHook } from "./before-agent-start";
import {
  registerSessionStartHook,
  registerSessionShutdownHook,
  registerSessionSwitchHook,
  registerSessionForkHook,
} from "./session";

/**
 * Register all hooks for the Easy Workflow extension.
 */
export function registerHooks(pi: ExtensionAPI): void {
  // Input hooks
  registerInputHook(pi);
  registerInputTransformer(pi);

  // Tool call hooks
  registerToolCallHook(pi);
  registerPermissionHook(pi);

  // Agent hooks
  registerBeforeAgentStartHook(pi);

  // Session hooks
  registerSessionStartHook(pi);
  registerSessionShutdownHook(pi);
  registerSessionSwitchHook(pi);
  registerSessionForkHook(pi);
}
