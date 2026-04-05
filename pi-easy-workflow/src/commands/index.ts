import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBoardCommand } from "./board";
import { registerWorkflowCommand } from "./workflow";
import { registerTaskCommand } from "./task";

/**
 * Register all commands with the extension.
 */
export function registerCommands(pi: ExtensionAPI): void {
  registerBoardCommand(pi);
  registerWorkflowCommand(pi);
  registerTaskCommand(pi);
}
