import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ReviewResult } from "../kanban/types";

export interface WorkflowRunState {
  reviewAgent?: string | null;
  runreview: boolean;
  running: boolean;
  status: WorkflowStatus;
  reviewCount: number;
  maxReviewRuns: number;
  createdAt: string | null;
  updatedAt: string | null;
  sessionId: string | null;
  promptHash: string | null;
  lastReviewedAt: string | null;
  lastReviewFingerprint: string | null;
  lastReviewStatus?: ReviewStatus;
  lastRecommendedPrompt?: string;
  lastGapCount?: number;
  version: number;
}

type WorkflowStatus = "pending" | "running" | "completed" | "blocked";
type ReviewStatus = "pass" | "gaps_found" | "blocked";

const REVIEW_COOLDOWN_MS = 30_000;

/**
 * Find the active workflow run for the current session.
 */
export async function findActiveRunForCurrentSession(
  ctx: ExtensionContext,
): Promise<{ runPath: string; state: WorkflowRunState } | null> {
  // TODO: Implement - query runs directory for session ID match
  // Pattern from OpenCode: read runs/*.md files and match sessionId
  return null;
}

/**
 * Check if review should run based on current state.
 */
export function shouldRunReview(
  state: WorkflowRunState,
  nowMs: number,
): { allowed: boolean; reason?: string } {
  if (!state.runreview) {
    return { allowed: false, reason: "runreview is false" };
  }

  if (state.running) {
    return { allowed: false, reason: "running is true" };
  }

  if (state.reviewCount >= state.maxReviewRuns) {
    return { allowed: false, reason: "max review runs reached" };
  }

  if (state.lastReviewedAt) {
    const elapsedMs = nowMs - new Date(state.lastReviewedAt).getTime();
    if (elapsedMs < REVIEW_COOLDOWN_MS) {
      return { allowed: false, reason: "cooldown not elapsed" };
    }
  }

  return { allowed: true };
}

/**
 * Compute a fingerprint for a review result.
 * Used to detect duplicate reviews.
 */
export function computeReviewFingerprint(result: ReviewResult): string {
  // Simple hash based on status, summary, gaps, and recommended prompt
  const normalized = JSON.stringify({
    status: result.status,
    summary: result.summary.toLowerCase().trim(),
    gaps: [...result.gaps].map((gap) => gap.toLowerCase().trim()).sort(),
    recommendedPrompt: result.recommendedPrompt.toLowerCase().trim(),
  });

  // Simple hash - in production use crypto.createHash
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Normalize a review result for consistent storage.
 */
export function normalizeReviewResult(result: ReviewResult): ReviewResult {
  return {
    status: result.status,
    summary: result.summary.trim(),
    gaps: result.gaps.map((gap) => gap.trim()).filter(Boolean),
    recommendedPrompt: result.recommendedPrompt.trim(),
  };
}
