import { Type } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import type { TaskStatus, KanbanTask } from "../kanban/types";

/**
 * Tool: kanban_list
 *
 * List all tasks on the kanban board.
 */
const kanbanListTool: ToolDefinition = {
  name: "kanban_list",
  description: "List all tasks on the kanban board, optionally filtered by status.",
  parameters: Type.Object({
    status: Type.Optional(
      Type.StringEnum(["template", "backlog", "executing", "review", "done", "failed", "stuck"], {
        description: "Filter by task status",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Maximum number of tasks to return",
        default: 50,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { status?: TaskStatus; limit?: number },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ tasks: Partial<KanbanTask>[]; count: number }>> {
    // TODO: Implement - query kanban DB
    // This requires the kanban server to be running

    const mockTasks: Partial<KanbanTask>[] = [
      { id: "task1", name: "Example task", status: "backlog", idx: 1 },
    ];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(mockTasks, null, 2),
        },
      ],
      details: {
        tasks: mockTasks,
        count: mockTasks.length,
      },
    };
  },

  renderCall(params: { status?: string }, _theme: any): string {
    return params.status
      ? `Kanban: list status=${params.status}`
      : "Kanban: list";
  },

  renderResult(
    result: AgentToolResult<{ tasks: Partial<KanbanTask>[]; count: number }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Fetching tasks...");
    }

    const details = result.details;
    if (!details?.tasks?.length) {
      return theme.fg("muted", "No tasks found");
    }

    const lines = [theme.fg("info", `Tasks (${details.count}):`)];

    for (const task of details.tasks.slice(0, 10)) {
      const statusColor =
        task.status === "done"
          ? "success"
          : task.status === "executing"
            ? "info"
            : task.status === "failed" || task.status === "stuck"
              ? "error"
              : "muted";

      lines.push(`  [${task.status}] ${task.name}`);
    }

    if (details.count > 10) {
      lines.push(theme.fg("muted", `  ... and ${details.count - 10} more`));
    }

    return lines.join("\n");
  },
};

/**
 * Tool: kanban_create
 *
 * Create a new task on the kanban board.
 */
const kanbanCreateTool: ToolDefinition = {
  name: "kanban_create",
  description: "Create a new task on the kanban board.",
  parameters: Type.Object({
    name: Type.String({
      description: "Short name for the task (shown on board)",
    }),
    prompt: Type.String({
      description: "Detailed instructions for the task",
    }),
    status: Type.Optional(
      Type.StringEnum(["template", "backlog"], {
        description: "Task status (template or backlog)",
        default: "backlog",
      }),
    ),
    branch: Type.Optional(
      Type.String({
        description: "Git branch name",
      }),
    ),
    requirements: Type.Optional(
      Type.Array(Type.String(), {
        description: "Task IDs this task depends on",
      }),
    ),
    review: Type.Optional(
      Type.Boolean({
        description: "Run review after completion",
        default: true,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      name: string;
      prompt: string;
      status?: "template" | "backlog";
      branch?: string;
      requirements?: string[];
      review?: boolean;
    },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ taskId: string; name: string }>> {
    // TODO: Implement - create task via kanban API or DB

    const taskId = `task_${Date.now()}`;

    return {
      content: [
        {
          type: "text",
          text: `Created task: ${params.name}`,
        },
      ],
      details: {
        taskId,
        name: params.name,
      },
    };
  },

  renderCall(params: { name: string }, _theme: any): string {
    const preview = params.name.slice(0, 40);
    return `Kanban: create ${preview}${params.name.length > 40 ? "..." : ""}`;
  },

  renderResult(
    result: AgentToolResult<{ taskId: string; name: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Creating task...");
    }

    const details = result.details;
    return details?.taskId
      ? theme.fg("success", `Task created: ${details.name} (${details.taskId})`)
      : theme.fg("error", "Failed to create task");
  },
};

/**
 * Tool: kanban_update
 *
 * Update an existing task.
 */
const kanbanUpdateTool: ToolDefinition = {
  name: "kanban_update",
  description: "Update an existing task's properties or status.",
  parameters: Type.Object({
    id: Type.String({
      description: "Task ID to update",
    }),
    name: Type.Optional(
      Type.String({
        description: "New task name",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description: "New task prompt",
      }),
    ),
    status: Type.Optional(
      Type.StringEnum(["template", "backlog", "executing", "review", "done", "failed", "stuck"], {
        description: "New task status",
      }),
    ),
    requirements: Type.Optional(
      Type.Array(Type.String(), {
        description: "New dependencies",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      id: string;
      name?: string;
      prompt?: string;
      status?: TaskStatus;
      requirements?: string[];
    },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ updated: boolean; taskId: string }>> {
    // TODO: Implement - update task via kanban API

    return {
      content: [
        {
          type: "text",
          text: `Updated task: ${params.id}`,
        },
      ],
      details: {
        updated: true,
        taskId: params.id,
      },
    };
  },

  renderCall(params: { id: string; status?: string }, _theme: any): string {
    return params.status
      ? `Kanban: update ${params.id} status=${params.status}`
      : `Kanban: update ${params.id}`;
  },

  renderResult(
    result: AgentToolResult<{ updated: boolean; taskId: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Updating task...");
    }

    const details = result.details;
    return details?.updated
      ? theme.fg("success", `Task updated: ${details.taskId}`)
      : theme.fg("error", "Failed to update task");
  },
};

/**
 * Tool: kanban_delete
 *
 * Delete a task from the kanban board.
 */
const kanbanDeleteTool: ToolDefinition = {
  name: "kanban_delete",
  description: "Delete a task from the kanban board.",
  parameters: Type.Object({
    id: Type.String({
      description: "Task ID to delete",
    }),
  }),

  async execute(
    _toolCallId: string,
    params: { id: string },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ deleted: boolean; taskId: string }>> {
    // TODO: Implement - delete task via kanban API

    return {
      content: [
        {
          type: "text",
          text: `Deleted task: ${params.id}`,
        },
      ],
      details: {
        deleted: true,
        taskId: params.id,
      },
    };
  },

  renderCall(params: { id: string }, _theme: any): string {
    return `Kanban: delete ${params.id}`;
  },

  renderResult(
    result: AgentToolResult<{ deleted: boolean; taskId: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Deleting task...");
    }

    const details = result.details;
    return details?.deleted
      ? theme.fg("warning", `Task deleted: ${details.taskId}`)
      : theme.fg("error", "Failed to delete task");
  },
};

/**
 * Register all kanban tools with the extension.
 */
export function registerKanbanTools(pi: ExtensionAPI): void {
  pi.registerTool(kanbanListTool);
  pi.registerTool(kanbanCreateTool);
  pi.registerTool(kanbanUpdateTool);
  pi.registerTool(kanbanDeleteTool);
}
