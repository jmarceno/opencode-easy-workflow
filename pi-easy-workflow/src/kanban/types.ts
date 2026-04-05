// Kanban task types - adapted from OpenCode plugin

export type TaskStatus =
  | "template"
  | "backlog"
  | "executing"
  | "review"
  | "done"
  | "failed"
  | "stuck";

export type ExecutionPhase =
  | "not_started"
  | "plan_complete_waiting_approval"
  | "plan_revision_pending"
  | "implementation_pending"
  | "implementation_done";

export type ExecutionStrategy = "standard" | "best_of_n";

export type BestOfNSubstage =
  | "idle"
  | "workers_running"
  | "reviewers_running"
  | "final_apply_running"
  | "blocked_for_manual_review"
  | "completed";

export type ThinkingLevel = "default" | "low" | "medium" | "high";

export type RunPhase = "worker" | "reviewer" | "final_applier";

export type RunStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type WorkflowSessionKind =
  | "task"
  | "task_run_worker"
  | "review"
  | "plan"
  | "build"
  | "repair";

export interface KanbanTask {
  id: string;
  name: string;
  idx: number;
  prompt: string;
  branch: string;
  planModel: string;
  executionModel: string;
  planmode: boolean;
  autoApprovePlan: boolean;
  review: boolean;
  autoCommit: boolean;
  deleteWorktree: boolean;
  status: TaskStatus;
  requirements: string[];
  agentOutput: string;
  reviewCount: number;
  sessionId: string | null;
  sessionUrl: string | null;
  worktreeDir: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  thinkingLevel: ThinkingLevel;
  executionPhase: ExecutionPhase;
  awaitingPlanApproval: boolean;
  planRevisionCount: number;
  executionStrategy: ExecutionStrategy;
  bestOfNConfig: BestOfNConfig | null;
  bestOfNSubstage: BestOfNSubstage;
  skipPermissionAsking: boolean;
}

export type Task = KanbanTask;

export interface Options {
  commitPrompt: string;
  branch: string;
  planModel: string;
  executionModel: string;
  reviewModel: string;
  command: string;
  parallelTasks: number;
  autoDeleteNormalSessions: boolean;
  autoDeleteReviewSessions: boolean;
  showExecutionGraph: boolean;
  port: number;
  thinkingLevel: ThinkingLevel;
  telegramBotToken: string;
  telegramChatId: string;
}

export interface BestOfNWorker {
  model: string;
  count: number;
  taskSuffix?: string;
}

export interface BestOfNReviewer {
  model: string;
  count: number;
}

export interface BestOfNFinalApplier {
  model: string;
  taskSuffix?: string;
}

export interface BestOfNConfig {
  workers: BestOfNWorker[];
  reviewers: BestOfNReviewer[];
  finalApplier: BestOfNFinalApplier;
  minSuccessfulWorkers: number;
  selectionMode: "pick" | "pick_or_synthesize" | "synthesize";
  verificationCommand?: string;
}

export interface TaskRun {
  id: string;
  taskId: string;
  phase: "worker" | "reviewer" | "final_applier";
  slotIndex: number;
  attemptIndex: number;
  model: string;
  taskSuffix: string | null;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  sessionId: string | null;
  sessionUrl: string | null;
  worktreeDir: string | null;
  summary: string | null;
  errorMessage: string | null;
  candidateId: string | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface TaskCandidate {
  id: string;
  taskId: string;
  workerRunId: string;
  status: "available" | "selected" | "rejected";
  changedFilesJson: string;
  diffStatsJson: string;
  verificationJson: string | null;
  summary: string;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

// Workflow run types (for #workflow sessions)
export type WorkflowStatus = "pending" | "running" | "completed" | "blocked";
export type ReviewStatus = "pass" | "gaps_found" | "blocked";

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

export interface ExtractedGoals {
  summary: string;
  goals: string[];
}

export interface ReviewResult {
  status: ReviewStatus;
  summary: string;
  gaps: string[];
  recommendedPrompt: string;
}
