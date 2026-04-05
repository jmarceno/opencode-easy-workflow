import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import { findActiveRunForCurrentSession, shouldRunReview } from "../utils/run-state";

/**
 * Hook for managing review orchestration after tool calls.
 *
 * When a workflow is active and a task completes, this hook:
 * 1. Detects if review should run
 * 2. Schedules review for the next agent turn
 * 3. Manages workflow-owned session permissions
 */
export function registerToolCallHook(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    // Check if there's an active workflow run for this session
    const activeRun = await findActiveRunForCurrentSession(ctx);

    if (!activeRun) {
      return undefined;
    }

    // Check if review should run
    const gate = shouldRunReview(activeRun.state, Date.now());

    if (!gate.allowed) {
      pi.logger.debug("Review skipped", {
        reason: gate.reason,
        sessionId: ctx.sessionId,
      });
      return undefined;
    }

    // Tools that typically indicate task completion
    const completionTools = ["bash", "edit", "write"];
    if (!completionTools.includes(event.toolName)) {
      return undefined;
    }

    // TODO: Implement review scheduling
    // - Store pending review state
    // - Set flag for before_agent_start hook
    // - Notify user that review is pending

    pi.logger.info("Review will run after current task", {
      toolName: event.toolName,
      sessionId: ctx.sessionId,
    });

    return undefined;
  });
}

/**
 * Hook for handling workflow-owned session permissions.
 *
 * For sessions created by the workflow orchestrator:
 * - Auto-reply to permission requests if configured
 * - Block dangerous commands based on session type
 */
export function registerPermissionHook(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    // Get workflow session owner for this session
    const sessionOwner = await getWorkflowSessionOwner(ctx);

    if (!sessionOwner) {
      return undefined;
    }

    // Check if this tool is allowed for this session type
    if (!isAllowedTool(event.toolName, sessionOwner.sessionKind)) {
      return {
        block: true,
        reason: `Tool '${event.toolName}' is not allowed for ${sessionOwner.sessionKind} sessions`,
      };
    }

    return undefined;
  });
}

/**
 * Check if a tool is allowed for a given session kind.
 */
function isAllowedTool(toolName: string, sessionKind: string): boolean {
  // Define allowed tools per session type
  const allowedByKind: Record<string, string[]> = {
    review: ["read", "bash"],
    plan: ["read", "bash"],
    build: ["read", "bash", "edit", "write"],
    repair: ["read", "bash", "edit", "write"],
  };

  const allowed = allowedByKind[sessionKind] ?? [];
  return allowed.includes(toolName);
}

/**
 * Get the workflow session owner metadata for the current session.
 */
async function getWorkflowSessionOwner(
  ctx: ExtensionContext,
): Promise<{ taskId: string; sessionKind: string; skipPermissionAsking: boolean } | null> {
  // TODO: Implement - query the kanban DB for session metadata
  // This requires access to the database which should be initialized
  // when the kanban server starts
  return null;
}
