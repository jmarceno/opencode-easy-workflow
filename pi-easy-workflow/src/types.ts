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

export type WorkflowRunKind = "all_tasks" | "single_task" | "workflow_review"

export type WorkflowRunStatus = "running" | "paused" | "stopping" | "completed" | "failed"

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
  skipPermissionAsking: boolean
  maxReviewRunsOverride: number | null
  smartRepairHints: string | null
  reviewActivity: "idle" | "running"
  isArchived: boolean
  archivedAt: number | null
}

export interface WorkflowRun {
  id: string
  kind: WorkflowRunKind
  status: WorkflowRunStatus
  displayName: string
  targetTaskId: string | null
  taskOrder: string[]
  currentTaskId: string | null
  currentTaskIndex: number
  pauseRequested: boolean
  stopRequested: boolean
  errorMessage: string | null
  createdAt: number
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  isArchived: boolean
  archivedAt: number | null
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
  extraPrompt: string
  branch: string
  planModel: string
  executionModel: string
  reviewModel: string
  repairModel: string
  command: string
  parallelTasks: number
  autoDeleteNormalSessions: boolean
  autoDeleteReviewSessions: boolean
  showExecutionGraph: boolean
  port: number
  thinkingLevel: ThinkingLevel
  telegramBotToken: string
  telegramChatId: string
  telegramNotificationsEnabled: boolean
  maxReviews: number
}

export const DEFAULT_COMMIT_PROMPT = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- **CRITICAL: Never push changes to remote repositories unless explicitly instructed to do so.**
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
  | "task_archived"
  | "task_reordered"
  | "options_updated"
  | "execution_started"
  | "execution_stopped"
  | "execution_complete"
  | "run_created"
  | "run_archived"
  | "run_updated"
  | "agent_output"
  | "error"
  | "task_run_created"
  | "task_run_updated"
  | "task_candidate_created"
  | "task_candidate_updated"
  | "plan_revision_requested"
  | "session_started"
  | "session_message_created"
  | "session_status_changed"
  | "session_completed"

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

// Session message logging types
export type MessageRole = "user" | "assistant" | "system" | "tool"
export type MessageType = 
  | "text" 
  | "tool_call" 
  | "tool_result" 
  | "error" 
  | "step_start"
  | "step_finish" 
  | "session_start" 
  | "session_end"
  | "session_status"
  | "thinking"
  | "user_prompt"
  | "assistant_response"
  | "tool_request"
  | "permission_asked"
  | "permission_replied"
  | "session_error"
  | "message_part"

export interface SessionMessage {
  id: number
  seq: number
  messageId: string | null
  sessionId: string
  taskId: string | null
  taskRunId: string | null
  timestamp: number
  role: MessageRole
  eventName: string | null
  messageType: MessageType
  contentJson: Record<string, any>
  modelProvider: string | null
  modelId: string | null
  agentName: string | null
  promptTokens: number | null
  completionTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  costJson: Record<string, any> | null
  costTotal: number | null
  toolCallId: string | null
  toolName: string | null
  toolArgsJson: Record<string, any> | null
  toolResultJson: Record<string, any> | null
  toolStatus: string | null
  editDiff: string | null
  editFilePath: string | null
  sessionStatus: string | null
  workflowPhase: string | null
  rawEventJson: Record<string, any> | null
}

export interface CreateSessionMessageInput {
  seq?: number
  messageId?: string | null
  sessionId: string
  taskId?: string | null
  taskRunId?: string | null
  timestamp?: number
  role: MessageRole
  eventName?: string | null
  messageType: MessageType
  contentJson: Record<string, any>
  modelProvider?: string | null
  modelId?: string | null
  agentName?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
  totalTokens?: number | null
  costJson?: Record<string, any> | null
  costTotal?: number | null
  toolCallId?: string | null
  toolName?: string | null
  toolArgsJson?: Record<string, any> | null
  toolResultJson?: Record<string, any> | null
  toolStatus?: string | null
  editDiff?: string | null
  editFilePath?: string | null
  sessionStatus?: string | null
  workflowPhase?: string | null
  rawEventJson?: Record<string, any> | null
}

export interface TimelineEntry {
  id: number
  timestamp: number
  relativeTime: number
  role: MessageRole
  messageType: MessageType
  summary: string
  hasToolCalls: boolean
  hasEdits: boolean
  modelProvider: string | null
  modelId: string | null
  agentName: string | null
}

export interface SessionUsageRollup {
  sessionId: string
  messageCount: number
  tokenizedMessageCount: number
  costedMessageCount: number
  firstTimestamp: number | null
  lastTimestamp: number | null
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  totalCost: number
}
