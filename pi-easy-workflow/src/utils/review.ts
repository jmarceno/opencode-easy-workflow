import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewResult, ExtractedGoals } from "../kanban/types";

/**
 * Find the pending review for the current session, if any.
 */
export async function findPendingReview(
  ctx: ExtensionContext,
): Promise<{ runPath: string; state: any } | null> {
  const anyCtx = ctx as any;
  const state = anyCtx?.sessionState?.easyWorkflowReview ?? anyCtx?.easyWorkflowReview ?? null;
  if (!state || state.pending !== true) {
    return null;
  }

  return {
    runPath: state.runPath ?? `session:${ctx.sessionManager.getSessionFile?.() ?? "unknown"}`,
    state,
  };
}

/**
 * Run a review against the current session state.
 *
 * In pi, this is adapted from OpenCode's session.prompt approach.
 * Instead of creating a sub-session, we:
 * 1. Analyze the current session state
 * 2. Extract relevant context
 * 3. Generate review findings
 */
export async function runReview(
  runInfo: { runPath: string; state: any },
  ctx: ExtensionContext,
  reviewAgent: string,
): Promise<ReviewResult> {
  const state = runInfo.state ?? {};
  const latestText = [
    state.latestAssistantMessage,
    state.lastAssistantMessage,
    state.output,
    state.agentOutput,
    state.transcript,
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");

  if (!latestText.trim()) {
    return {
      status: "blocked",
      summary: `No reviewable output found for ${reviewAgent}`,
      gaps: ["No assistant output was available to review."],
      recommendedPrompt: "Produce an implementation summary, changed files, and validation results before retrying review.",
    };
  }

  const unmetGoals = Array.isArray(state.goals)
    ? state.goals.filter((goal: unknown) => {
        if (typeof goal !== "string") return false;
        const normalizedGoal = goal.toLowerCase();
        return !latestText.toLowerCase().includes(normalizedGoal.slice(0, Math.min(24, normalizedGoal.length)));
      })
    : [];

  if (unmetGoals.length > 0) {
    return {
      status: "gaps_found",
      summary: `Review by ${reviewAgent} found likely gaps against the stated goals.`,
      gaps: unmetGoals.map((goal: string) => `Goal may be incomplete: ${goal}`),
      recommendedPrompt: "Address the missing goals explicitly, then summarize what changed and how you validated it.",
    };
  }

  return {
    status: "pass",
    summary: `Review by ${reviewAgent} found no obvious gaps in the captured output.`,
    gaps: [],
    recommendedPrompt: "None",
  };
}

/**
 * Extract goals from a user prompt using AI.
 *
 * In pi, this could use a tool or be done inline.
 */
export async function extractGoals(
  cleanedPrompt: string,
  _ctx: ExtensionContext,
): Promise<ExtractedGoals> {
  const normalized = cleanedPrompt.trim();
  const bulletGoals = normalized
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);

  return {
    summary: normalized.slice(0, 160),
    goals: bulletGoals.length > 0 ? bulletGoals : [normalized],
  };
}

/**
 * Parse review response from agent text.
 */
export function parseReviewResponse(responseText: string): ReviewResult {
  const statusMatch = responseText.match(/STATUS:\s*(\w+)/i);
  const summaryMatch = responseText.match(/SUMMARY:\s*([\s\S]+?)(?=\nGAPS:|$)/i);
  const gapsMatch = responseText.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_PROMPT:|$)/i);
  const recommendedMatch = responseText.match(/RECOMMENDED_PROMPT:\s*([\s\S]+?)$/i);

  const status = (statusMatch?.[1]?.toLowerCase().trim() || "blocked") as
    | "pass"
    | "gaps_found"
    | "blocked";

  const summary = summaryMatch?.[1]?.trim() || "Review could not be completed";

  const gapsText = gapsMatch?.[1] || "";
  const gaps = gapsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((gap) => gap.length > 0 && gap.toLowerCase() !== "none");

  const recommendedPrompt = recommendedMatch?.[1]?.trim() || "";
  const normalizedRecommended =
    recommendedPrompt.toLowerCase() === "none" ? "" : recommendedPrompt;

  return {
    status: ["pass", "gaps_found", "blocked"].includes(status)
      ? status
      : "blocked",
    summary,
    gaps,
    recommendedPrompt: normalizedRecommended,
  };
}

/**
 * Format goals for display/storage.
 */
export function formatGoals(goals: ExtractedGoals): string {
  const items =
    goals.goals.length > 0
      ? goals.goals.map((goal, index) => `${index + 1}. ${goal}`).join("\n")
      : "1. Review the implementation against the user request.";

  return `## Task Summary\n\n${goals.summary}\n\n## Goals\n\n${items}`;
}
