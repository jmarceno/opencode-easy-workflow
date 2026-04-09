import type {
  CreateSessionMessageInput,
  MessageType,
  Options,
  SessionMessage,
  Task,
  TaskStatus,
  ThinkingLevel,
  WorkflowRun,
  WorkflowRunKind,
  WorkflowRunStatus,
} from "../types.ts"

export type { CreateSessionMessageInput, MessageType, Options, SessionMessage, Task, TaskStatus, ThinkingLevel, WorkflowRun, WorkflowRunKind, WorkflowRunStatus }

export type PiSessionKind =
  | "task"
  | "task_run_worker"
  | "task_run_reviewer"
  | "task_run_final_applier"
  | "review_scratch"
  | "repair"
  | "plan"
  | "plan_revision"

export type PiSessionStatus = "starting" | "active" | "paused" | "completed" | "failed" | "aborted"

export interface PiWorkflowSession {
  id: string
  taskId: string | null
  taskRunId: string | null
  sessionKind: PiSessionKind
  status: PiSessionStatus
  cwd: string
  worktreeDir: string | null
  branch: string | null
  piSessionId: string | null
  piSessionFile: string | null
  processPid: number | null
  model: string
  thinkingLevel: ThinkingLevel
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  exitCode: number | null
  exitSignal: string | null
  errorMessage: string | null
}

export interface CreatePiWorkflowSessionInput {
  id: string
  taskId?: string | null
  taskRunId?: string | null
  sessionKind: PiSessionKind
  status?: PiSessionStatus
  cwd: string
  worktreeDir?: string | null
  branch?: string | null
  piSessionId?: string | null
  piSessionFile?: string | null
  processPid?: number | null
  model?: string
  thinkingLevel?: ThinkingLevel
  startedAt?: number
  finishedAt?: number | null
  exitCode?: number | null
  exitSignal?: string | null
  errorMessage?: string | null
}

export interface UpdatePiWorkflowSessionInput {
  taskId?: string | null
  taskRunId?: string | null
  status?: PiSessionStatus
  cwd?: string
  worktreeDir?: string | null
  branch?: string | null
  piSessionId?: string | null
  piSessionFile?: string | null
  processPid?: number | null
  model?: string
  thinkingLevel?: ThinkingLevel
  finishedAt?: number | null
  exitCode?: number | null
  exitSignal?: string | null
  errorMessage?: string | null
}

export type SessionIOStream = "stdin" | "stdout" | "stderr" | "server"

export type SessionIORecordType =
  | "rpc_command"
  | "rpc_response"
  | "rpc_event"
  | "stderr_chunk"
  | "lifecycle"
  | "snapshot"
  | "prompt_rendered"

export interface SessionIORecord {
  id: number
  sessionId: string
  seq: number
  stream: SessionIOStream
  recordType: SessionIORecordType
  payloadJson: Record<string, unknown> | null
  payloadText: string | null
  createdAt: number
}

export interface AppendSessionIOInput {
  sessionId: string
  seq?: number
  stream: SessionIOStream
  recordType: SessionIORecordType
  payloadJson?: Record<string, unknown> | null
  payloadText?: string | null
  createdAt?: number
}

export interface GetSessionIOOptions {
  offset?: number
  limit?: number
  recordType?: SessionIORecordType
}

export type PromptTemplateKey =
  | "execution"
  | "planning"
  | "plan_revision"
  | "review"
  | "review_fix"
  | "repair"
  | "best_of_n_worker"
  | "best_of_n_reviewer"
  | "best_of_n_final_applier"
  | "commit"

export interface PromptTemplate {
  id: number
  key: PromptTemplateKey | string
  name: string
  description: string
  templateText: string
  variablesJson: string[]
  isActive: boolean
  createdAt: number
  updatedAt: number
}

export interface PromptTemplateVersion {
  id: number
  promptTemplateId: number
  version: number
  templateText: string
  variablesJson: string[]
  createdAt: number
}

export interface UpsertPromptTemplateInput {
  key: PromptTemplateKey | string
  name: string
  description?: string
  templateText: string
  variablesJson?: string[]
  isActive?: boolean
}

export interface CreateWorkflowRunInput {
  id: string
  kind: WorkflowRunKind
  status?: WorkflowRunStatus
  displayName?: string
  targetTaskId?: string | null
  taskOrder?: string[]
  currentTaskId?: string | null
  currentTaskIndex?: number
  pauseRequested?: boolean
  stopRequested?: boolean
  errorMessage?: string | null
  createdAt?: number
  startedAt?: number
  finishedAt?: number | null
}

export interface UpdateWorkflowRunInput {
  status?: WorkflowRunStatus
  displayName?: string
  targetTaskId?: string | null
  taskOrder?: string[]
  currentTaskId?: string | null
  currentTaskIndex?: number
  pauseRequested?: boolean
  stopRequested?: boolean
  errorMessage?: string | null
  finishedAt?: number | null
}

export interface CreateTaskInput {
  id: string
  name: string
  prompt: string
  status?: TaskStatus
  idx?: number
  branch?: string
  planModel?: string
  executionModel?: string
  planmode?: boolean
  autoApprovePlan?: boolean
  review?: boolean
  autoCommit?: boolean
  deleteWorktree?: boolean
  requirements?: string[]
  thinkingLevel?: ThinkingLevel
}

export interface UpdateTaskInput {
  name?: string
  prompt?: string
  status?: TaskStatus
  idx?: number
  branch?: string
  planModel?: string
  executionModel?: string
  planmode?: boolean
  autoApprovePlan?: boolean
  review?: boolean
  autoCommit?: boolean
  deleteWorktree?: boolean
  requirements?: string[]
  agentOutput?: string
  sessionId?: string | null
  sessionUrl?: string | null
  worktreeDir?: string | null
  errorMessage?: string | null
  reviewCount?: number
  completedAt?: number | null
  thinkingLevel?: ThinkingLevel
}

export interface PromptRenderResult {
  template: PromptTemplate
  renderedText: string
}

export interface PromptRenderAndCaptureInput {
  key: PromptTemplateKey | string
  variables?: Record<string, unknown>
  sessionId?: string
  stream?: SessionIOStream
}

export interface SessionMessageQueryOptions {
  offset?: number
  limit?: number
  messageType?: MessageType
}
