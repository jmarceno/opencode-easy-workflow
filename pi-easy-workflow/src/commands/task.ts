import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";

/**
 * Register the /task command.
 *
 * Manages kanban tasks (create, update, delete, list).
 */
export function registerTaskCommand(pi: ExtensionAPI): void {
  pi.registerCommand("task", {
    description: "Manage kanban tasks (create, update, delete, list)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const action = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(" ");

      switch (action) {
        case "create":
        case "add":
          await createTask(rest, ctx);
          break;

        case "update":
        case "edit":
          await updateTask(rest, ctx);
          break;

        case "delete":
        case "remove":
          await deleteTask(rest, ctx);
          break;

        case "list":
        case "ls":
          await listTasks(rest, ctx);
          break;

        case "start":
          await startTask(rest, ctx);
          break;

        case "approve":
          await approvePlan(rest, ctx);
          break;

        case "":
        case undefined:
          showTaskUsage(ctx);
          break;

        default:
          ctx.ui.notify(`Unknown action: ${action}`, "warning");
      }
    },
  });
}

/**
 * Show task command usage.
 */
function showTaskUsage(ctx: ExtensionContext): void {
  ctx.ui.notify(
    "Usage: /task [create|update|delete|list|start|approve]",
    "info",
  );
}

/**
 * Create a new task.
 */
async function createTask(args: string, ctx: ExtensionContext): Promise<void> {
  // Parse: "Task Name" "task prompt text"
  const match = args.match(/^"([^"]+)"\s*(.+)$/);

  if (!match) {
    ctx.ui.notify('Usage: /task create "Task Name" "prompt description"', "warning");
    return;
  }

  const [, name, prompt] = match;

  // TODO: Implement - create task via kanban API
  ctx.ui.notify(`Creating task: ${name}`, "info");
}

/**
 * Update an existing task.
 */
async function updateTask(args: string, ctx: ExtensionContext): Promise<void> {
  // Parse: <task-id> [field=value ...]
  const parts = args.trim().split(/\s+/);

  if (parts.length < 2) {
    ctx.ui.notify("Usage: /task update <task-id> field=value ...", "warning");
    return;
  }

  const taskId = parts[0];
  const updates = parts.slice(1).join(" ");

  // TODO: Implement - update task via kanban API
  ctx.ui.notify(`Updating task ${taskId}: ${updates}`, "info");
}

/**
 * Delete a task.
 */
async function deleteTask(taskId: string, ctx: ExtensionContext): Promise<void> {
  if (!taskId.trim()) {
    ctx.ui.notify("Usage: /task delete <task-id>", "warning");
    return;
  }

  // TODO: Implement - delete task via kanban API
  ctx.ui.notify(`Deleting task ${taskId}...`, "info");
}

/**
 * List tasks, optionally filtered.
 */
async function listTasks(args: string, ctx: ExtensionContext): Promise<void> {
  const statusFilter = args.trim() || undefined;

  // TODO: Implement - list tasks via kanban API
  ctx.ui.notify(`Listing tasks${statusFilter ? ` (${statusFilter})` : ""}...`, "info");
}

/**
 * Start a task (move to executing).
 */
async function startTask(taskId: string, ctx: ExtensionContext): Promise<void> {
  if (!taskId.trim()) {
    ctx.ui.notify("Usage: /task start <task-id>", "warning");
    return;
  }

  // TODO: Implement - start task execution
  ctx.ui.notify(`Starting task ${taskId}...`, "info");
}

/**
 * Approve a plan-mode task.
 */
async function approvePlan(taskId: string, ctx: ExtensionContext): Promise<void> {
  if (!taskId.trim()) {
    ctx.ui.notify("Usage: /task approve <task-id>", "warning");
    return;
  }

  // TODO: Implement - approve plan
  ctx.ui.notify(`Approving plan for task ${taskId}...`, "info");
}
