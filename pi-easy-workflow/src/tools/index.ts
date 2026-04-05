import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWorkflowTools } from "./workflow-tools";
import { registerKanbanTools } from "./kanban-tools";

/**
 * Register all tools with the extension.
 */
export function registerTools(pi: ExtensionAPI): void {
  registerWorkflowTools(pi);
  registerKanbanTools(pi);
}
