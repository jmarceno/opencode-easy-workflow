import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewResult, ExtractedGoals } from "../kanban/types";

/**
 * Find the pending review for the current session, if any.
 */
export async function findPendingReview(
  ctx: ExtensionContext,
): Promise<{ runPath: string; state: any } | null> {
  // TODO: Implement - check for pending review in session state or DB
  // This should track pending reviews per session
  return null;
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
  // TODO: Implement review execution
  // In OpenCode: creates a scratch session and prompts the review agent
  // In pi: Need to adapt to use tools or prompt injection

  // For now, return a placeholder
  return {
    status: "blocked",
    summary: "Review not yet implemented",
    gaps: ["Review system needs to be adapted for pi extension"],
    recommendedPrompt: "Complete the review integration",
  };
}

/**
 * Extract goals from a user prompt using AI.
 *
 * In pi, this could use a tool or be done inline.
 */
export async function extractGoals(
  cleanedPrompt: string,
  ctx: ExtensionContext,
): Promise<ExtractedGoals> {
  // TODO: Implement goal extraction
  // In OpenCode: creates a scratch session to extract goals
  // In pi: Could use structured prompting or a dedicated tool

  // Placeholder implementation
  return {
    summary: cleanedPrompt.slice(0, 100),
    goals: [cleanedPrompt],
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
