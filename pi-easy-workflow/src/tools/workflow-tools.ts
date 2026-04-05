import { Type } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import { getKanbanDb, getOrchestrator } from "../kanban/runtime";
import { parseWorkflowPrompt } from "../utils/workflow-parser";
import { extractGoals, runReview } from "../utils/review";

const workflowStartTool: ToolDefinition = {
  name: "workflow_start",
  label: "Workflow Start",
  description: "Start a new review-driven workflow.",
  parameters: Type.Object({
    prompt: Type.String({ description: "The task to accomplish." }),
    reviewAgent: Type.Optional(Type.String({ description: "Override the review agent name", default: "workflow-review" })),
    maxReviewRuns: Type.Optional(Type.Number({ description: "Maximum review iterations", default: 2 })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<{ runId: string; status: string }>> {
    const typed = params as { prompt: string; reviewAgent?: string; maxReviewRuns?: number };
    const config = configLoader.getConfig();
    if (!typed.prompt.trim()) throw new Error("Workflow prompt cannot be empty");

    const parsed = parseWorkflowPrompt(typed.prompt);
    const goals = await extractGoals(parsed.cleanedPrompt, ctx);
    const task = getKanbanDb().createTask({
      id: `wf_${Date.now()}`,
      name: goals.summary || parsed.cleanedPrompt.slice(0, 80),
      prompt: parsed.cleanedPrompt,
      planmode: false,
      review: true,
      autoCommit: config.autoCommit,
      deleteWorktree: config.deleteWorktree,
      branch: config.defaultBranch,
      planModel: config.planModel,
      executionModel: config.executionModel,
      requirements: goals.goals,
      status: "backlog",
    });
    const started = await getOrchestrator().startTask(task.id);
    return {
      content: [{ type: "text", text: `Workflow started for task ${task.id}: ${task.name}` }],
      details: { runId: task.id, status: started.status },
    };
  },
};

const workflowStatusTool: ToolDefinition = {
  name: "workflow_status",
  label: "Workflow Status",
  description: "Check the status of the current workflow.",
  parameters: Type.Object({}),
  async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<{ active: boolean; reviewCount: number; status: string }>> {
    const tasks = getKanbanDb().getTasks().filter((task) => ["backlog", "executing", "review"].includes(task.status));
    const active = tasks[0];
    return {
      content: [{ type: "text", text: active ? `Active workflow task: ${active.id}` : "No active workflow session" }],
      details: { active: Boolean(active), reviewCount: active?.reviewCount ?? 0, status: active?.status ?? "inactive" },
    };
  },
};

const workflowReviewTool: ToolDefinition = {
  name: "workflow_review",
  label: "Workflow Review",
  description: "Manually trigger a review of the current implementation.",
  parameters: Type.Object({
    runId: Type.Optional(Type.String({ description: "Specific run ID to review." })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<{ status: string; summary: string }>> {
    const typed = params as { runId?: string };
    const task = typed.runId ? getKanbanDb().getTask(typed.runId) : getKanbanDb().getTasks().find((candidate) => candidate.status === "review");
    if (!task) {
      return { content: [{ type: "text", text: "No reviewable workflow task found" }], details: { status: "inactive", summary: "No task in review state" } };
    }

    const review = await runReview({ runPath: `task:${task.id}`, state: { pending: true, goals: task.requirements, agentOutput: task.agentOutput } }, ctx, configLoader.getConfig().reviewAgent);
    if (review.status === "pass") await getOrchestrator().markReviewPass(task.id, review.summary);
    else if (review.status === "gaps_found") await getOrchestrator().markReviewFail(task.id, review.gaps);

    return { content: [{ type: "text", text: `Review ${review.status}: ${review.summary}` }], details: { status: review.status, summary: review.summary } };
  },
};

const workflowCancelTool: ToolDefinition = {
  name: "workflow_cancel",
  label: "Workflow Cancel",
  description: "Cancel the current workflow and stop review cycles.",
  parameters: Type.Object({
    runId: Type.String({ description: "The run ID to cancel" }),
    reason: Type.Optional(Type.String({ description: "Reason for cancellation" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext): Promise<AgentToolResult<{ cancelled: boolean; runId: string }>> {
    const typed = params as { runId: string; reason?: string };
    await getOrchestrator().cancelTask(typed.runId, typed.reason);
    return { content: [{ type: "text", text: `Workflow ${typed.runId} cancelled` }], details: { cancelled: true, runId: typed.runId } };
  },
};

export function registerWorkflowTools(pi: ExtensionAPI): void {
  pi.registerTool(workflowStartTool);
  pi.registerTool(workflowStatusTool);
  pi.registerTool(workflowReviewTool);
  pi.registerTool(workflowCancelTool);
}
