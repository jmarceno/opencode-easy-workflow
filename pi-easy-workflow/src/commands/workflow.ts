import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";

/**
 * Register the /workflow command.
 *
 * Manages workflow runs (status, cancel, etc.)
 */
export function registerWorkflowCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflow", {
    description: "Manage workflow runs (status, cancel)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const action = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(" ");

      switch (action) {
        case "status":
          await showWorkflowStatus(ctx);
          break;

        case "cancel":
          await cancelWorkflow(rest, ctx);
          break;

        case "start":
          await startWorkflow(rest, ctx);
          break;

        case "":
        case undefined:
          ctx.ui.notify("Usage: /workflow [status|cancel|start]", "info");
          break;

        default:
          ctx.ui.notify(`Unknown action: ${action}`, "warning");
      }
    },
  });
}

/**
 * Show workflow status for current session.
 */
async function showWorkflowStatus(ctx: ExtensionContext): Promise<void> {
  // TODO: Implement - query active workflow run

  // For now, show placeholder
  ctx.ui.notify("No active workflow session", "info");
}

/**
 * Cancel a workflow by run ID.
 */
async function cancelWorkflow(runId: string, ctx: ExtensionContext): Promise<void> {
  if (!runId.trim()) {
    ctx.ui.notify("Usage: /workflow cancel <run-id>", "warning");
    return;
  }

  // TODO: Implement - cancel workflow run
  ctx.ui.notify(`Cancelling workflow ${runId}...`, "info");
}

/**
 * Start a new workflow.
 */
async function startWorkflow(prompt: string, ctx: ExtensionContext): Promise<void> {
  if (!prompt.trim()) {
    ctx.ui.notify("Usage: /workflow start <task prompt>", "warning");
    return;
  }

  // TODO: Implement - start new workflow
  // This could use the workflow_start tool internally
  ctx.ui.notify(`Starting workflow: ${prompt.slice(0, 50)}...`, "info");
}
