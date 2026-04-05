import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import { findPendingReview, runReview } from "../utils/review";
import { normalizeReviewResult, computeReviewFingerprint } from "../utils/run-state";

/**
 * Hook for injecting review context before each agent turn.
 *
 * This hook:
 * 1. Checks if there's a pending review for this session
 * 2. Runs the review if conditions are met
 * 3. Injects review results into the system prompt
 */
export function registerBeforeAgentStartHook(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const config = configLoader.getConfig();

    // Check for pending review
    const pendingReview = await findPendingReview(ctx);

    if (!pendingReview) {
      return undefined;
    }

    pi.logger.info("Running pending review before agent start", {
      sessionId: ctx.sessionId,
      runPath: pendingReview.runPath,
    });

    try {
      // Run the review
      const result = await runReview(pendingReview, ctx, config.reviewAgent);
      const normalized = normalizeReviewResult(result);
      const fingerprint = computeReviewFingerprint(normalized);

      // TODO: Update run state with review results
      // updateRunFileState(pendingReview.runPath, { ... })

      // Build review context for injection
      const reviewContext = buildReviewContext(normalized);

      // Inject into system prompt
      return {
        systemPrompt: event.systemPrompt + "\n\n" + reviewContext,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pi.logger.error("Review failed", { error: message });

      // Still inject error context
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n## Review Error\n\n" +
          `Review could not be completed: ${message}\n\n` +
          "Please proceed with caution and address any known issues.",
      };
    }
  });
}

/**
 * Build review context string for injection into system prompt.
 */
function buildReviewContext(result: {
  status: string;
  summary: string;
  gaps: string[];
  recommendedPrompt: string;
}): string {
  const statusEmoji =
    result.status === "pass"
      ? "✅"
      : result.status === "gaps_found"
        ? "⚠️"
        : "❌";
  const statusText =
    result.status === "pass"
      ? "PASS"
      : result.status === "gaps_found"
        ? "GAPS FOUND"
        : "BLOCKED";

  let context = `## Previous Review Result ${statusEmoji} ${statusText}\n\n`;
  context += `Summary: ${result.summary}\n\n`;

  if (result.gaps.length > 0) {
    context += "### Gaps Identified\n";
    for (let i = 0; i < result.gaps.length; i++) {
      context += `${i + 1}. ${result.gaps[i]}\n`;
    }
    context += "\n";
  }

  if (result.recommendedPrompt && result.recommendedPrompt !== "None") {
    context += `### Recommended Next Step\n\n${result.recommendedPrompt}\n`;
  }

  return context;
}
