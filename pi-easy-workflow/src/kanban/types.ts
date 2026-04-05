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

export interface KanbanTask {
  id: string;
  name: string;
  idx: number;
  prompt: string;
  branch: string;
  planModel: string;
  executionModel: string;
  planmode: boolean;
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
  executionStrategy: ExecutionStrategy;
  bestOfNConfig: BestOfNConfig | null;
  bestOfNSubstage: BestOfNSubstage;
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
