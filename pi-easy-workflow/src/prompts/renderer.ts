import type {
  AggregatedReviewResult,
  Options,
  SelectionMode,
  Task,
  TaskCandidate,
} from "../types.ts"
import type {
  PromptRenderResult,
  PromptTemplate,
  PromptTemplateKey,
} from "../db/types.ts"

type PromptTemplateStore = {
  getPromptTemplate: (key: PromptTemplateKey | string) => PromptTemplate | null
}

function resolveVariablePath(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".")
  let current: unknown = source
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in (current as Record<string, unknown>))) {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function renderTemplate(template: Pick<PromptTemplate, "templateText">, variables: Record<string, unknown>): string {
  return template.templateText.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, token: string) => {
    const value = resolveVariablePath(variables, token)
    if (value === undefined || value === null) return ""
    if (typeof value === "string") return value
    return JSON.stringify(value)
  })
}

export function renderPrompt(
  db: PromptTemplateStore,
  key: PromptTemplateKey | string,
  variables: Record<string, unknown> = {},
): PromptRenderResult {
  const template = db.getPromptTemplate(key)
  if (!template) {
    throw new Error(`Prompt template not found or inactive: ${key}`)
  }
  return {
    template,
    renderedText: renderTemplate(template, variables),
  }
}

function asAdditionalContextBlock(extraPrompt?: string): string {
  const trimmed = extraPrompt?.trim()
  return trimmed ? `Additional context:\n${trimmed}` : ""
}

export function buildExecutionVariables(
  task: Task,
  options: Options,
  worktreeDir: string,
  planContext?: {
    approvedPlan?: string | null
    userGuidance?: string | null
    isPlanMode?: boolean
  },
): Record<string, unknown> {
  const approvedPlan = planContext?.approvedPlan?.trim()
  const userGuidance = planContext?.userGuidance?.trim()

  return {
    task,
    worktree_dir: worktreeDir,
    execution_intro: planContext?.isPlanMode
      ? "The user has approved the plan below. Implement it now."
      : "Implement the task directly from the task prompt.",
    approved_plan_block: approvedPlan ? `Approved plan:\n${approvedPlan}` : "",
    user_guidance_block: userGuidance ? `User guidance:\n${userGuidance}` : "",
    additional_context_block: asAdditionalContextBlock(options.extraPrompt),
  }
}

export function buildPlanningVariables(task: Task, options: Options): Record<string, unknown> {
  return {
    task,
    additional_context_block: asAdditionalContextBlock(options.extraPrompt),
  }
}

export function buildPlanRevisionVariables(
  task: Task,
  currentPlan: string,
  revisionFeedback: string,
  options?: Pick<Options, "extraPrompt">,
): Record<string, unknown> {
  return {
    task,
    current_plan: currentPlan,
    revision_feedback: revisionFeedback,
    additional_context_block: asAdditionalContextBlock(options?.extraPrompt),
  }
}

export function buildReviewVariables(task: Task, reviewFilePath: string): Record<string, unknown> {
  return {
    task,
    review_file_path: reviewFilePath,
  }
}

export function buildReviewFixVariables(
  task: Task,
  reviewSummary: string,
  reviewGaps: string[],
): Record<string, unknown> {
  return {
    task,
    review_summary: reviewSummary,
    review_gaps: reviewGaps.map((gap) => `- ${gap}`).join("\n"),
  }
}

export function buildRepairVariables(
  task: Task,
  worktreeStatus: string,
  sessionHistory: string,
  latestOutput: string,
): Record<string, unknown> {
  return {
    task,
    repair_context: [
      `Worktree git status:\n${worktreeStatus || "(empty)"}`,
      `Session history:\n${sessionHistory || "(none)"}`,
      `Latest captured output:\n${latestOutput || "(none)"}`,
    ].join("\n\n"),
  }
}

export function buildBestOfNWorkerVariables(
  task: Task,
  slotIndex: number,
  model: string,
  extraPrompt?: string,
  taskSuffix?: string,
): Record<string, unknown> {
  return {
    task,
    slot_index: slotIndex,
    model,
    task_suffix: taskSuffix?.trim() ?? "",
    additional_context_block: asAdditionalContextBlock(extraPrompt),
  }
}

export function buildBestOfNReviewerVariables(
  task: Task,
  candidates: TaskCandidate[],
  extraPrompt?: string,
  taskSuffix?: string,
): Record<string, unknown> {
  const candidateSummaries = candidates
    .map((candidate, index) => [
      `Candidate ${index + 1} (${candidate.id}):`,
      candidate.summary || "No summary available",
      `Changed files: ${candidate.changedFilesJson.join(", ") || "None"}`,
      `Verification: ${JSON.stringify(candidate.verificationJson)}`,
    ].join("\n"))
    .join("\n\n")

  return {
    task,
    candidate_summaries: candidateSummaries,
    task_suffix: taskSuffix?.trim() ?? "",
    additional_context_block: asAdditionalContextBlock(extraPrompt),
  }
}

export function buildBestOfNFinalApplierVariables(
  task: Task,
  candidates: TaskCandidate[],
  aggregatedReview: AggregatedReviewResult,
  selectionMode: SelectionMode,
  extraPrompt?: string,
  taskSuffix?: string,
): Record<string, unknown> {
  const topCandidateId = Object.entries(aggregatedReview.candidateVoteCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([candidateId]) => candidateId)[0]
  const topCandidate = topCandidateId ? candidates.find((candidate) => candidate.id === topCandidateId) : null

  const candidateGuidance = topCandidate
    ? [
      `Top voted candidate: ${topCandidate.id}`,
      topCandidate.summary || "No summary available",
      `Changed files: ${topCandidate.changedFilesJson.join(", ") || "None"}`,
    ].join("\n")
    : candidates.map((candidate) => `- ${candidate.id}: ${candidate.summary || "No summary"}`).join("\n")

  const recommendedPrompts = aggregatedReview.usableResults
    .map((item) => item.recommendedPrompt?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => `- ${value}`)
    .join("\n")

  return {
    task,
    selection_mode: selectionMode,
    candidate_guidance: candidateGuidance,
    recurring_gaps: aggregatedReview.recurringGaps.length
      ? aggregatedReview.recurringGaps.map((gap) => `- ${gap}`).join("\n")
      : "(none)",
    reviewer_recommended_prompts: recommendedPrompts || "(none)",
    consensus_reached: aggregatedReview.consensusReached ? "yes" : "no",
    task_suffix: taskSuffix?.trim() ?? "",
    additional_context_block: asAdditionalContextBlock(extraPrompt),
  }
}

export function buildCommitVariables(baseRef: string, deleteWorktree = true): Record<string, unknown> {
  return {
    base_ref: baseRef,
    keep_worktree_note: deleteWorktree
      ? ""
      : "Important: do NOT delete the worktree at the end; keep it for manual follow-up.",
  }
}
