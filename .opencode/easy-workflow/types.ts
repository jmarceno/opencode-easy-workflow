export type TaskStatus = "template" | "backlog" | "executing" | "review" | "done" | "failed" | "stuck"

export type ThinkingLevel = "default" | "low" | "medium" | "high"

export type ExecutionPhase = "not_started" | "plan_complete_waiting_approval" | "plan_revision_pending" | "implementation_pending" | "implementation_done"

export type ExecutionStrategy = "standard" | "best_of_n"

export type BestOfNSubstage =
  | "idle"
  | "workers_running"
  | "reviewers_running"
  | "final_apply_running"
  | "blocked_for_manual_review"
  | "completed"

export type RunPhase = "worker" | "reviewer" | "final_applier"

export type RunStatus = "pending" | "running" | "done" | "failed" | "skipped"

export type SelectionMode = "pick_best" | "synthesize" | "pick_or_synthesize"

export interface BestOfNSlot {
  model: string
  count: number
  taskSuffix?: string
}

export interface BestOfNFinalApplier {
  model: string
  taskSuffix?: string
}

export interface BestOfNConfig {
  workers: BestOfNSlot[]
  reviewers: BestOfNSlot[]
  finalApplier: BestOfNFinalApplier
  minSuccessfulWorkers: number
  selectionMode: SelectionMode
  verificationCommand?: string
}

export interface Task {
  id: string
  name: string
  idx: number
  prompt: string
  branch: string
  planModel: string
  executionModel: string
  planmode: boolean
  autoApprovePlan: boolean
  review: boolean
  autoCommit: boolean
  deleteWorktree: boolean
  status: TaskStatus
  requirements: string[]
  agentOutput: string
  reviewCount: number
  sessionId: string | null
  sessionUrl: string | null
  worktreeDir: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  thinkingLevel: ThinkingLevel
  executionPhase: ExecutionPhase
  awaitingPlanApproval: boolean
  planRevisionCount: number
  executionStrategy: ExecutionStrategy
  bestOfNConfig: BestOfNConfig | null
  bestOfNSubstage: BestOfNSubstage
}

export interface TaskRun {
  id: string
  taskId: string
  phase: RunPhase
  slotIndex: number
  attemptIndex: number
  model: string
  taskSuffix: string | null
  status: RunStatus
  sessionId: string | null
  sessionUrl: string | null
  worktreeDir: string | null
  summary: string | null
  errorMessage: string | null
  candidateId: string | null
  metadataJson: Record<string, any>
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskCandidate {
  id: string
  taskId: string
  workerRunId: string
  status: "available" | "selected" | "rejected"
  changedFilesJson: string[]
  diffStatsJson: Record<string, number>
  verificationJson: Record<string, any>
  summary: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface ReviewerOutput {
  status: "pass" | "needs_manual_review"
  summary: string
  bestCandidateIds: string[]
  gaps: string[]
  recommendedFinalStrategy: SelectionMode
  recommendedPrompt: string | null
}

export interface AggregatedReviewResult {
  candidateVoteCounts: Record<string, number>
  recurringRisks: string[]
  recurringGaps: string[]
  consensusReached: boolean
  recommendedFinalStrategy: SelectionMode
  usableResults: ReviewerOutput[]
}

export interface Options {
  commitPrompt: string
  branch: string
  planModel: string
  executionModel: string
  reviewModel: string
  command: string
  parallelTasks: number
  autoDeleteNormalSessions: boolean
  autoDeleteReviewSessions: boolean
  showExecutionGraph: boolean
  port: number
  thinkingLevel: ThinkingLevel
}

export const DEFAULT_COMMIT_PROMPT = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "pre-cherry-pick"
5. Cherry-pick the task commit into P.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If a stash was created, restore it with: git -C P stash pop
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Delete the worktree
10. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;

export type WSMessageType =
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "task_reordered"
  | "options_updated"
  | "execution_started"
  | "execution_stopped"
  | "execution_complete"
  | "agent_output"
  | "error"
  | "task_run_created"
  | "task_run_updated"
  | "task_candidate_created"
  | "task_candidate_updated"
  | "plan_revision_requested"

export interface WSMessage {
  type: WSMessageType
  payload: any
}

export interface ReviewResult {
  status: "pass" | "gaps_found" | "blocked"
  summary: string
  gaps: string[]
  recommendedPrompt: string
}
