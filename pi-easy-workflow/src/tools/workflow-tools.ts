import { Type } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import { parseWorkflowPrompt } from "../utils/workflow-parser";
import { extractGoals } from "../utils/review";

/**
 * Tool: workflow_start
 *
 * Starts a new review-driven workflow session.
 */
const workflowStartTool: ToolDefinition = {
  name: "workflow_start",
  description:
    "Start a new review-driven workflow. The task will be broken down into goals and reviewed after completion.",
  parameters: Type.Object({
    prompt: Type.String({
      description:
        "The task to accomplish. Be specific about what needs to be built, fixed, or reviewed.",
    }),
    reviewAgent: Type.Optional(
      Type.String({
        description: "Override the review agent name",
        default: "workflow-review",
      }),
    ),
    maxReviewRuns: Type.Optional(
      Type.Number({
        description: "Maximum number of review iterations",
        default: 2,
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      prompt: string;
      reviewAgent?: string;
      maxReviewRuns?: number;
    },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ runId: string; status: string }>> {
    const config = configLoader.getConfig();
    const reviewAgent = params.reviewAgent ?? config.reviewAgent;
    const maxReviewRuns = params.maxReviewRuns ?? config.maxReviewRuns;

    // Validate prompt
    if (!params.prompt.trim()) {
      throw new Error("Workflow prompt cannot be empty");
    }

    // TODO: Implement workflow activation
    // - Create run state file
    // - Extract goals from prompt
    // - Set up review triggers
    // - Return run info

    return {
      content: [
        {
          type: "text",
          text: `Workflow started for: ${params.prompt.slice(0, 100)}...`,
        },
      ],
      details: {
        runId: "pending-implementation",
        status: "initialized",
      },
    };
  },

  renderCall(params: { prompt: string }, _theme: any): string {
    const preview = params.prompt.slice(0, 60);
    return `Workflow: start ${preview}${params.prompt.length > 60 ? "..." : ""}`;
  },

  renderResult(
    result: AgentToolResult<{ runId: string; status: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Starting workflow...");
    }

    const details = result.details;
    if (!details?.runId) {
      return theme.fg("error", "Failed to start workflow");
    }

    return [
      theme.fg("success", `Workflow started`),
      `Run ID: ${details.runId}`,
      `Status: ${details.status}`,
    ].join("\n");
  },
};

/**
 * Tool: workflow_status
 *
 * Check the status of the current workflow session.
 */
const workflowStatusTool: ToolDefinition = {
  name: "workflow_status",
  description: "Check the status of the current workflow, including review state and progress.",
  parameters: Type.Object({}),

  async execute(
    _toolCallId: string,
    _params: Record<string, never>,
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ active: boolean; reviewCount: number; status: string }>> {
    // TODO: Implement status check
    // - Find active run for current session
    // - Return current state

    return {
      content: [
        {
          type: "text",
          text: "No active workflow session",
        },
      ],
      details: {
        active: false,
        reviewCount: 0,
        status: "inactive",
      },
    };
  },

  renderCall(_params: Record<string, never>, _theme: any): string {
    return "Workflow: status";
  },

  renderResult(
    result: AgentToolResult<{ active: boolean; reviewCount: number; status: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Checking workflow status...");
    }

    const details = result.details;
    if (!details?.active) {
      return theme.fg("muted", "No active workflow");
    }

    return [
      theme.fg("info", "Active Workflow"),
      `Status: ${details.status}`,
      `Reviews: ${details.reviewCount}`,
    ].join("\n");
  },
};

/**
 * Tool: workflow_review
 *
 * Manually trigger a review of the current implementation.
 */
const workflowReviewTool: ToolDefinition = {
  name: "workflow_review",
  description:
    "Manually trigger a review of the current implementation against the workflow goals.",
  parameters: Type.Object({
    runId: Type.Optional(
      Type.String({
        description: "Specific run ID to review. Defaults to current session.",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { runId?: string },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ status: string; summary: string }>> {
    // TODO: Implement manual review trigger
    // - Find the specified run or current session's run
    // - Run review logic
    // - Return results

    return {
      content: [
        {
          type: "text",
          text: "Review triggered (implementation pending)",
        },
      ],
      details: {
        status: "pending",
        summary: "Manual review not yet implemented",
      },
    };
  },

  renderCall(params: { runId?: string }, _theme: any): string {
    return params.runId
      ? `Workflow: review ${params.runId}`
      : "Workflow: review";
  },

  renderResult(
    result: AgentToolResult<{ status: string; summary: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Running review...");
    }

    const details = result.details;
    return [
      `Review Status: ${details?.status ?? "unknown"}`,
      details?.summary ?? "",
    ].join("\n");
  },
};

/**
 * Tool: workflow_cancel
 *
 * Cancel the current workflow session.
 */
const workflowCancelTool: ToolDefinition = {
  name: "workflow_cancel",
  description: "Cancel the current workflow and stop review cycles.",
  parameters: Type.Object({
    runId: Type.String({
      description: "The run ID to cancel",
    }),
    reason: Type.Optional(
      Type.String({
        description: "Reason for cancellation",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { runId: string; reason?: string },
    _signal: AbortSignal | undefined,
    _onUpdate: undefined,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<{ cancelled: boolean; runId: string }>> {
    // TODO: Implement cancellation
    // - Update run state to blocked
    // - Clear pending review flags

    return {
      content: [
        {
          type: "text",
          text: `Workflow ${params.runId} cancelled`,
        },
      ],
      details: {
        cancelled: true,
        runId: params.runId,
      },
    };
  },

  renderCall(params: { runId: string }, _theme: any): string {
    return `Workflow: cancel ${params.runId}`;
  },

  renderResult(
    result: AgentToolResult<{ cancelled: boolean; runId: string }>,
    options: any,
    theme: any,
  ): string {
    if (options.isPartial) {
      return theme.fg("muted", "Cancelling workflow...");
    }

    const details = result.details;
    return details?.cancelled
      ? theme.fg("warning", `Workflow ${details.runId} cancelled`)
      : theme.fg("error", "Failed to cancel workflow");
  },
};

/**
 * Register all workflow tools with the extension.
 */
export function registerWorkflowTools(pi: ExtensionAPI): void {
  pi.registerTool(workflowStartTool);
  pi.registerTool(workflowStatusTool);
  pi.registerTool(workflowReviewTool);
  pi.registerTool(workflowCancelTool);
}
