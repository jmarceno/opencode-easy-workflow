import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import type { KanbanTask, TaskStatus } from "../kanban/types";

/**
 * Format tasks for plain text output (Print mode).
 */
function formatTasksPlain(tasks: Partial<KanbanTask>[]): string {
  if (!tasks.length) {
    return "No tasks found.";
  }

  const lines: string[] = [];
  lines.push("=== Kanban Board ===\n");

  // Group by status
  const byStatus = new Map<TaskStatus, Partial<KanbanTask>[]>();
  for (const task of tasks) {
    const status = task.status ?? "backlog";
    if (!byStatus.has(status)) {
      byStatus.set(status, []);
    }
    byStatus.get(status)!.push(task);
  }

  // Output each status column
  const statusOrder: TaskStatus[] = ["backlog", "executing", "review", "done", "failed", "stuck", "template"];

  for (const status of statusOrder) {
    const statusTasks = byStatus.get(status) ?? [];
    if (statusTasks.length === 0) continue;

    lines.push(`[${status.toUpperCase()}]`);
    for (const task of statusTasks) {
      lines.push(`  ${task.id}: ${task.name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Register the /board command.
 *
 * Shows the kanban board with all tasks.
 */
export function registerBoardCommand(pi: ExtensionAPI): void {
  pi.registerCommand("board", {
    description: "Show the workflow kanban board",
    handler: async (args, ctx) => {
      // Parse optional status filter
      const statusFilter = args.trim() || undefined;

      // TODO: Fetch tasks from kanban
      const tasks: Partial<KanbanTask>[] = [];

      // Print mode - no UI
      if (!ctx.hasUI) {
        console.log(formatTasksPlain(tasks));
        return;
      }

      // Interactive/RPC mode - use three-tier pattern
      // For now, use notify as a simple fallback
      if (tasks.length === 0) {
        ctx.ui.notify("No tasks on board. Use /task create to add tasks.", "info");
        return;
      }

      // TODO: Implement full TUI component for kanban board
      // For now, send a notification with summary
      const byStatus = new Map<TaskStatus, number>();
      for (const task of tasks) {
        const status = task.status ?? "backlog";
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      }

      const summary = Array.from(byStatus.entries())
        .map(([s, c]) => `${s}:${c}`)
        .join(" ");

      ctx.ui.notify(`Board: ${summary}`, "info");
    },
  });
}
