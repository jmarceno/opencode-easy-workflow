import type { PiKanbanDB } from "../db.ts"
import type { Task, ThinkingLevel, ReviewResult } from "../types.ts"
import { buildReviewVariables } from "../prompts/index.ts"
import { PiSessionManager } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"

function asReviewResult(parsed: Record<string, unknown>): ReviewResult {
  const status = parsed.status
  if (status !== "pass" && status !== "gaps_found" && status !== "blocked") {
    throw new Error("Review response JSON must include status: pass|gaps_found|blocked")
  }

  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim()
    : "No summary provided"

  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.map((item) => String(item).trim()).filter(Boolean)
    : []

  const recommendedPrompt = typeof parsed.recommendedPrompt === "string"
    ? parsed.recommendedPrompt.trim()
    : ""

  return {
    status,
    summary,
    gaps,
    recommendedPrompt,
  }
}

export interface RunReviewScratchInput {
  task: Task
  cwd: string
  worktreeDir: string
  branch: string
  reviewFilePath: string
  model: string
  thinkingLevel: ThinkingLevel
  onOutput?: (chunk: string) => void
}

export interface RunReviewScratchResult {
  reviewResult: ReviewResult
  responseText: string
  sessionId: string
}

export class PiReviewSessionRunner {
  private readonly sessions: PiSessionManager

  constructor(private readonly db: PiKanbanDB) {
    this.sessions = new PiSessionManager(db)
  }

  async run(input: RunReviewScratchInput): Promise<RunReviewScratchResult> {
    const rendered = this.db.renderPrompt("review", buildReviewVariables(input.task, input.reviewFilePath))
    const response = await this.sessions.executePrompt({
      taskId: input.task.id,
      sessionKind: "review_scratch",
      cwd: input.cwd,
      worktreeDir: input.worktreeDir,
      branch: input.branch,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      promptText: rendered.renderedText,
      onOutput: input.onOutput,
    })

    const parsed = parseStrictJsonObject(response.responseText, "Review response")
    return {
      reviewResult: asReviewResult(parsed),
      responseText: response.responseText,
      sessionId: response.session.id,
    }
  }
}
