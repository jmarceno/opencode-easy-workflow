import { Type } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import type { TaskStatus, KanbanTask } from "../kanban/types";
import { getKanbanDb } from "../kanban/runtime";

const kanbanListTool: ToolDefinition = {
  name: "kanban_list",
  label: "Kanban List",
  description: "List all tasks on the kanban board, optionally filtered by status.",
  parameters: Type.Object({
    status: Type.Optional(Type.String({ description: "Filter by task status" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of tasks to return", default: 50 })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<{ tasks: Partial<KanbanTask>[]; count: number }>> {
    const typed = params as { status?: TaskStatus; limit?: number };
    const tasks = getKanbanDb().getTasks(typed.status).slice(0, typed.limit ?? 50);
    return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }], details: { tasks, count: tasks.length } };
  },
};

const kanbanCreateTool: ToolDefinition = {
  name: "kanban_create",
  label: "Kanban Create",
  description: "Create a new task on the kanban board.",
  parameters: Type.Object({
    name: Type.String({ description: "Short name for the task" }),
    prompt: Type.String({ description: "Detailed instructions for the task" }),
    status: Type.Optional(Type.String({ description: "Task status" })),
    branch: Type.Optional(Type.String({ description: "Git branch name" })),
    requirements: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
    review: Type.Optional(Type.Boolean({ description: "Run review after completion", default: true })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<{ taskId: string; name: string }>> {
    const typed = params as { name: string; prompt: string; status?: TaskStatus; branch?: string; requirements?: string[]; review?: boolean };
    const task = getKanbanDb().createTask({
      id: `task_${Date.now()}`,
      name: typed.name,
      prompt: typed.prompt,
      status: typed.status ?? "backlog",
      branch: typed.branch ?? "",
      requirements: typed.requirements ?? [],
      review: typed.review ?? true,
    });
    return { content: [{ type: "text", text: `Created task: ${task.name}` }], details: { taskId: task.id, name: task.name } };
  },
};

const kanbanUpdateTool: ToolDefinition = {
  name: "kanban_update",
  label: "Kanban Update",
  description: "Update an existing task's properties or status.",
  parameters: Type.Object({
    id: Type.String({ description: "Task ID to update" }),
    name: Type.Optional(Type.String({ description: "New task name" })),
    prompt: Type.Optional(Type.String({ description: "New task prompt" })),
    status: Type.Optional(Type.String({ description: "New task status" })),
    requirements: Type.Optional(Type.Array(Type.String(), { description: "New dependencies" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<{ updated: boolean; taskId: string }>> {
    const typed = params as { id: string; name?: string; prompt?: string; status?: TaskStatus; requirements?: string[] };
    const updated = getKanbanDb().updateTask(typed.id, typed as Partial<KanbanTask>);
    return {
      content: [{ type: "text", text: updated ? `Updated task: ${typed.id}` : `Task not found: ${typed.id}` }],
      details: { updated: Boolean(updated), taskId: typed.id },
    };
  },
};

const kanbanDeleteTool: ToolDefinition = {
  name: "kanban_delete",
  label: "Kanban Delete",
  description: "Delete a task from the kanban board.",
  parameters: Type.Object({ id: Type.String({ description: "Task ID to delete" }) }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<{ deleted: boolean; taskId: string }>> {
    const typed = params as { id: string };
    const deleted = getKanbanDb().deleteTask(typed.id);
    return { content: [{ type: "text", text: deleted ? `Deleted task: ${typed.id}` : `Task not found: ${typed.id}` }], details: { deleted, taskId: typed.id } };
  },
};

export function registerKanbanTools(pi: ExtensionAPI): void {
  pi.registerTool(kanbanListTool);
  pi.registerTool(kanbanCreateTool);
  pi.registerTool(kanbanUpdateTool);
  pi.registerTool(kanbanDeleteTool);
}
