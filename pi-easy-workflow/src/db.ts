import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"
import {
  DEFAULT_COMMIT_PROMPT,
  type CreateSessionMessageInput,
  type ExecutionPhase,
  type ExecutionStrategy,
  type MessageType,
  type Options,
  type SessionMessage,
  type Task,
  type TaskStatus,
  type ThinkingLevel,
  type WorkflowRun,
  type WorkflowRunKind,
  type WorkflowRunStatus,
} from "./types.ts"
import { runMigrations, type Migration } from "./db/migrations.ts"
import type {
  AppendSessionIOInput,
  CreatePiWorkflowSessionInput,
  CreateTaskInput,
  CreateWorkflowRunInput,
  GetSessionIOOptions,
  PiSessionStatus,
  PiWorkflowSession,
  PromptRenderAndCaptureInput,
  PromptRenderResult,
  PromptTemplate,
  PromptTemplateKey,
  PromptTemplateVersion,
  SessionIORecord,
  SessionIORecordType,
  SessionIOStream,
  SessionMessageQueryOptions,
  UpdatePiWorkflowSessionInput,
  UpdateTaskInput,
  UpdateWorkflowRunInput,
  UpsertPromptTemplateInput,
} from "./db/types.ts"
import { renderTemplate } from "./prompts/renderer.ts"

const DEFAULT_OPTIONS: Options = {
  commitPrompt: DEFAULT_COMMIT_PROMPT,
  extraPrompt: "",
  branch: "",
  planModel: "default",
  executionModel: "default",
  reviewModel: "default",
  repairModel: "default",
  command: "",
  parallelTasks: 1,
  autoDeleteNormalSessions: false,
  autoDeleteReviewSessions: false,
  showExecutionGraph: true,
  port: 3789,
  thinkingLevel: "default",
  telegramBotToken: "",
  telegramChatId: "",
  telegramNotificationsEnabled: true,
  maxReviews: 2,
}

type PromptSeed = {
  key: PromptTemplateKey
  name: string
  description: string
  templateText: string
  variablesJson: string[]
}

const DEFAULT_PROMPT_TEMPLATES: PromptSeed[] = [
  {
    key: "execution",
    name: "Task Execution",
    description: "Core implementation prompt for standard and approved-plan execution.",
    templateText: [
      "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.",
      "",
      "{{execution_intro}}",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "{{approved_plan_block}}",
      "{{user_guidance_block}}",
      "{{additional_context_block}}",
      "",
      "Implementation requirements:",
      "- Make concrete code changes in this worktree.",
      "- Keep changes scoped to the task goals.",
      "- Validate your result with focused checks before finishing.",
      "- Report concise progress and outcomes.",
    ].join("\n"),
    variablesJson: [
      "task",
      "execution_intro",
      "approved_plan_block",
      "user_guidance_block",
      "additional_context_block",
    ],
  },
  {
    key: "planning",
    name: "Plan Generation",
    description: "Planning-only prompt used before implementation begins.",
    templateText: [
      "PREPARE PLAN ONLY. Do not ask follow-up questions. Make reasonable assumptions from the codebase. Output only the plan — do not proceed to implementation.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Plan requirements:",
      "- Break work into clear, ordered implementation steps.",
      "- Include validation and verification approach.",
      "- Keep scope aligned to task goals and constraints.",
    ].join("\n"),
    variablesJson: ["task", "additional_context_block"],
  },
  {
    key: "plan_revision",
    name: "Plan Revision",
    description: "Revises a captured plan using user feedback while staying in planning mode.",
    templateText: [
      "PREPARE PLAN ONLY. Do not ask follow-up questions. Make reasonable assumptions from the codebase. Output only the plan — do not proceed to implementation.",
      "",
      "The user has reviewed your plan and requested changes. Revise the plan based on feedback.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "Previous plan:",
      "{{current_plan}}",
      "",
      "User feedback:",
      "{{revision_feedback}}",
      "",
      "{{additional_context_block}}",
      "",
      "Provide a revised plan that directly addresses the feedback.",
    ].join("\n"),
    variablesJson: ["task", "current_plan", "revision_feedback", "additional_context_block"],
  },
  {
    key: "review",
    name: "Review",
    description: "Strict repository review prompt with JSON output contract.",
    templateText: [
      "You are the workflow review agent. You are strict and thorough.",
      "",
      "Review the current repository state against the task review file named in the user prompt.",
      "Use that review file as the source of truth for goals and review instructions.",
      "Inspect the codebase and branch state directly.",
      "Do not rely on prior session history.",
      "Do not make code changes.",
      "",
      "Review the task review file at: {{review_file_path}}",
      "",
      "Review Criteria:",
      "1) Goal completeness: every goal must map to verified working code.",
      "2) Errors and bugs: logic issues, null handling, boundary failures, race conditions, exceptions.",
      "3) Security flaws: injection, missing validation, hardcoded secrets, unsafe file/path operations.",
      "4) Best practices: error handling, type safety, cleanup, edge cases, project conventions.",
      "5) Test coverage: critical paths and new behavior should be testable and covered.",
      "",
      "Strictness directive: default to finding gaps. Only return pass when all goals are complete and no unresolved defects remain.",
      "",
      "Your response must be valid JSON:",
      '"status": "pass|gaps_found|blocked",',
      '"summary": "<brief summary of review findings>",',
      '"gaps": ["<first gap if any>", "<second gap if any>"],',
      '"recommendedPrompt": "<specific prompt to address gaps, or empty string if no gaps>"',
      "",
      "Context:",
      "Task ID: {{task.id}}",
      "Task Name: {{task.name}}",
    ].join("\n"),
    variablesJson: ["task", "review_file_path"],
  },
  {
    key: "review_fix",
    name: "Review Fix",
    description: "Follow-up prompt that fixes issues identified by review.",
    templateText: [
      "Address the issues found during review and update the implementation.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "Review summary:",
      "{{review_summary}}",
      "",
      "Gaps:",
      "{{review_gaps}}",
      "",
      "Requirements:",
      "- Fix all listed gaps completely.",
      "- Preserve existing correct behavior.",
      "- Keep the solution scoped and production-ready.",
    ].join("\n"),
    variablesJson: ["task", "review_summary", "review_gaps"],
  },
  {
    key: "repair",
    name: "Repair",
    description: "Deterministic workflow state repair analysis prompt.",
    templateText: [
      "You repair workflow task states.",
      "",
      "Analyze the task state, worktree git status, session history, and latest output. Choose what ACTUALLY happened and the right repair action.",
      "",
      "Choose exactly one action:",
      "- queue_implementation",
      "- restore_plan_approval",
      "- reset_backlog",
      "- mark_done",
      "- fail_task",
      "- continue_with_more_reviews",
      "",
      "Decision guidelines:",
      "- Prefer queue_implementation when a usable [plan] exists and worktree shows real code changes.",
      "- Prefer mark_done only when output and worktree both confirm completion.",
      "- Use restore_plan_approval when plan should return to human review.",
      "- Use reset_backlog when there are no meaningful changes and task should restart.",
      "- Use fail_task when state is invalid and should remain visible with actionable error.",
      "- Use continue_with_more_reviews when task is stuck only due to review limit and gaps seem fixable.",
      "",
      "Critical verification steps:",
      "1) Check worktree git status.",
      "2) Check session messages for where execution stopped.",
      "3) Check workflow session history patterns.",
      "4) Compare latest output claims with actual worktree changes.",
      "",
      "Context:",
      "{{repair_context}}",
      "",
      "Return strict JSON: {\"action\":\"...\",\"reason\":\"...\",\"errorMessage\":\"optional\"}",
    ].join("\n"),
    variablesJson: ["task", "repair_context"],
  },
  {
    key: "best_of_n_worker",
    name: "Best-of-N Worker",
    description: "Worker prompt for candidate implementation generation in best-of-n.",
    templateText: [
      "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.",
      "",
      "You are one candidate implementation worker in a best-of-n workflow.",
      "Produce the best complete solution you can in this worktree.",
      "",
      "Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Worker metadata:",
      "- Slot index: {{slot_index}}",
      "- Model: {{model}}",
      "- Worker instructions: {{task_suffix}}",
      "",
      "Deliver complete implementation and a concise summary of what changed.",
    ].join("\n"),
    variablesJson: ["task", "slot_index", "model", "task_suffix", "additional_context_block"],
  },
  {
    key: "best_of_n_reviewer",
    name: "Best-of-N Reviewer",
    description: "Reviewer prompt for evaluating best-of-n candidates with strict JSON output.",
    templateText: [
      "You are a reviewer in a best-of-n workflow.",
      "Your job is to evaluate the candidate implementations and provide structured guidance.",
      "",
      "Original Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Candidates:",
      "{{candidate_summaries}}",
      "",
      "Your response must be valid JSON with fields:",
      '"status": "pass|needs_manual_review",',
      '"summary": "<short evaluation summary>",',
      '"bestCandidateIds": ["<candidate-id-1>", "<candidate-id-2>"],',
      '"gaps": ["<issue 1>", "<issue 2>"],',
      '"recommendedFinalStrategy": "pick_best|synthesize|pick_or_synthesize",',
      '"recommendedPrompt": "<optional instructions for the final applier, or null>"',
      "",
      "Additional reviewer instructions:",
      "{{task_suffix}}",
    ].join("\n"),
    variablesJson: ["task", "candidate_summaries", "task_suffix", "additional_context_block"],
  },
  {
    key: "best_of_n_final_applier",
    name: "Best-of-N Final Applier",
    description: "Final applier prompt to produce final implementation from best-of-n results.",
    templateText: [
      "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase.",
      "",
      "You are the final applier in a best-of-n workflow.",
      "Produce the final implementation based on the original task and reviewer guidance.",
      "",
      "Original Task:",
      "{{task.prompt}}",
      "",
      "{{additional_context_block}}",
      "",
      "Selection mode:",
      "{{selection_mode}}",
      "",
      "Candidate guidance:",
      "{{candidate_guidance}}",
      "",
      "Recurring reviewer gaps:",
      "{{recurring_gaps}}",
      "",
      "Reviewer recommended prompts:",
      "{{reviewer_recommended_prompts}}",
      "",
      "Consensus reached: {{consensus_reached}}",
      "",
      "Additional final-applier instructions:",
      "{{task_suffix}}",
      "",
      "Produce the final implementation now.",
    ].join("\n"),
    variablesJson: [
      "task",
      "selection_mode",
      "candidate_guidance",
      "recurring_gaps",
      "reviewer_recommended_prompts",
      "consensus_reached",
      "task_suffix",
      "additional_context_block",
    ],
  },
  {
    key: "commit",
    name: "Commit",
    description: "Commit instructions executed after task completion.",
    templateText: `${DEFAULT_COMMIT_PROMPT}\n\n{{keep_worktree_note}}`,
    variablesJson: ["base_ref", "keep_worktree_note"],
  },
]

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function parseJSON<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function asThinkingLevel(value: unknown): ThinkingLevel {
  return value === "low" || value === "medium" || value === "high" || value === "default"
    ? value
    : "default"
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "true" || normalized === "1") return true
    if (normalized === "false" || normalized === "0") return false
  }
  return fallback
}

function asTaskStatus(value: unknown): TaskStatus {
  return value === "template" || value === "backlog" || value === "executing" || value === "review" || value === "done" || value === "failed" || value === "stuck"
    ? value
    : "backlog"
}

function asExecutionPhase(value: unknown): ExecutionPhase {
  return value === "not_started" || value === "plan_complete_waiting_approval" || value === "plan_revision_pending" || value === "implementation_pending" || value === "implementation_done"
    ? value
    : "not_started"
}

function asExecutionStrategy(value: unknown): ExecutionStrategy {
  return value === "best_of_n" || value === "standard" ? value : "standard"
}

function asWorkflowRunKind(value: unknown): WorkflowRunKind {
  return value === "all_tasks" || value === "single_task" || value === "workflow_review"
    ? value
    : "all_tasks"
}

function asWorkflowRunStatus(value: unknown): WorkflowRunStatus {
  return value === "running" || value === "paused" || value === "stopping" || value === "completed" || value === "failed"
    ? value
    : "running"
}

function asPiSessionStatus(value: unknown): PiSessionStatus {
  return value === "starting" || value === "active" || value === "paused" || value === "completed" || value === "failed" || value === "aborted"
    ? value
    : "active"
}

function asMessageType(value: unknown): MessageType {
  const valid: MessageType[] = [
    "text",
    "tool_call",
    "tool_result",
    "error",
    "step_start",
    "step_finish",
    "session_start",
    "session_end",
    "session_status",
    "thinking",
    "user_prompt",
    "assistant_response",
    "tool_request",
    "permission_asked",
    "permission_replied",
    "session_error",
    "message_part",
  ]
  return valid.includes(value as MessageType) ? (value as MessageType) : "text"
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    name: String(row.name),
    idx: Number(row.idx ?? 0),
    prompt: String(row.prompt ?? ""),
    branch: String(row.branch ?? ""),
    planModel: String(row.plan_model ?? "default"),
    executionModel: String(row.execution_model ?? "default"),
    planmode: Number(row.planmode ?? 0) === 1,
    autoApprovePlan: Number(row.auto_approve_plan ?? 0) === 1,
    review: Number(row.review ?? 1) === 1,
    autoCommit: Number(row.auto_commit ?? 1) === 1,
    deleteWorktree: Number(row.delete_worktree ?? 1) === 1,
    status: asTaskStatus(row.status),
    requirements: parseJSON<string[]>(row.requirements, []),
    agentOutput: String(row.agent_output ?? ""),
    reviewCount: Number(row.review_count ?? 0),
    sessionId: row.session_id ? String(row.session_id) : null,
    sessionUrl: row.session_url ? String(row.session_url) : null,
    worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    thinkingLevel: asThinkingLevel(row.thinking_level),
    executionPhase: asExecutionPhase(row.execution_phase),
    awaitingPlanApproval: Number(row.awaiting_plan_approval ?? 0) === 1,
    planRevisionCount: Number(row.plan_revision_count ?? 0),
    executionStrategy: asExecutionStrategy(row.execution_strategy),
    bestOfNConfig: parseJSON<Record<string, unknown> | null>(row.best_of_n_config, null) as Task["bestOfNConfig"],
    bestOfNSubstage: String(row.best_of_n_substage ?? "idle") as Task["bestOfNSubstage"],
    skipPermissionAsking: Number(row.skip_permission_asking ?? 1) === 1,
    maxReviewRunsOverride: row.max_review_runs_override === null || row.max_review_runs_override === undefined
      ? null
      : Number(row.max_review_runs_override),
    smartRepairHints: row.smart_repair_hints ? String(row.smart_repair_hints) : null,
    reviewActivity: row.review_activity === "running" ? "running" : "idle",
    isArchived: Number(row.is_archived ?? 0) === 1,
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
  }
}

function rowToWorkflowRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id),
    kind: asWorkflowRunKind(row.kind),
    status: asWorkflowRunStatus(row.status),
    displayName: String(row.display_name ?? ""),
    targetTaskId: row.target_task_id ? String(row.target_task_id) : null,
    taskOrder: parseJSON<string[]>(row.task_order_json, []),
    currentTaskId: row.current_task_id ? String(row.current_task_id) : null,
    currentTaskIndex: Number(row.current_task_index ?? 0),
    pauseRequested: Number(row.pause_requested ?? 0) === 1,
    stopRequested: Number(row.stop_requested ?? 0) === 1,
    errorMessage: row.error_message ? String(row.error_message) : null,
    createdAt: Number(row.created_at ?? 0),
    startedAt: Number(row.started_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  }
}

function rowToWorkflowSession(row: Record<string, unknown>): PiWorkflowSession {
  return {
    id: String(row.id),
    taskId: row.task_id ? String(row.task_id) : null,
    taskRunId: row.task_run_id ? String(row.task_run_id) : null,
    sessionKind: String(row.session_kind) as PiWorkflowSession["sessionKind"],
    status: asPiSessionStatus(row.status),
    cwd: String(row.cwd),
    worktreeDir: row.worktree_dir ? String(row.worktree_dir) : null,
    branch: row.branch ? String(row.branch) : null,
    piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
    piSessionFile: row.pi_session_file ? String(row.pi_session_file) : null,
    processPid: row.process_pid === null || row.process_pid === undefined ? null : Number(row.process_pid),
    model: String(row.model ?? "default"),
    thinkingLevel: asThinkingLevel(row.thinking_level),
    startedAt: Number(row.started_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    exitSignal: row.exit_signal ? String(row.exit_signal) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  }
}

function rowToSessionIORecord(row: Record<string, unknown>): SessionIORecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    seq: Number(row.seq),
    stream: String(row.stream) as SessionIOStream,
    recordType: String(row.record_type) as SessionIORecordType,
    payloadJson: parseJSON<Record<string, unknown> | null>(row.payload_json, null),
    payloadText: row.payload_text ? String(row.payload_text) : null,
    createdAt: Number(row.created_at ?? 0),
  }
}

function rowToSessionMessage(row: Record<string, unknown>): SessionMessage {
  return {
    id: Number(row.id),
    messageId: row.message_id ? String(row.message_id) : null,
    sessionId: String(row.session_id),
    taskId: row.task_id ? String(row.task_id) : null,
    taskRunId: row.task_run_id ? String(row.task_run_id) : null,
    timestamp: Number(row.timestamp),
    role: String(row.role) as SessionMessage["role"],
    messageType: asMessageType(row.message_type),
    contentJson: parseJSON<Record<string, unknown>>(row.content_json, {}),
    modelProvider: row.model_provider ? String(row.model_provider) : null,
    modelId: row.model_id ? String(row.model_id) : null,
    agentName: row.agent_name ? String(row.agent_name) : null,
    promptTokens: row.prompt_tokens === null || row.prompt_tokens === undefined ? null : Number(row.prompt_tokens),
    completionTokens: row.completion_tokens === null || row.completion_tokens === undefined ? null : Number(row.completion_tokens),
    totalTokens: row.total_tokens === null || row.total_tokens === undefined ? null : Number(row.total_tokens),
    toolName: row.tool_name ? String(row.tool_name) : null,
    toolArgsJson: parseJSON<Record<string, unknown> | null>(row.tool_args_json, null),
    toolResultJson: parseJSON<Record<string, unknown> | null>(row.tool_result_json, null),
    toolStatus: row.tool_status ? String(row.tool_status) : null,
    editDiff: row.edit_diff ? String(row.edit_diff) : null,
    editFilePath: row.edit_file_path ? String(row.edit_file_path) : null,
    sessionStatus: row.session_status ? String(row.session_status) : null,
    workflowPhase: row.workflow_phase ? String(row.workflow_phase) : null,
    rawEventJson: parseJSON<Record<string, unknown> | null>(row.raw_event_json, null),
  }
}

function rowToPromptTemplate(row: Record<string, unknown>): PromptTemplate {
  return {
    id: Number(row.id),
    key: String(row.key),
    name: String(row.name),
    description: String(row.description ?? ""),
    templateText: String(row.template_text),
    variablesJson: parseJSON<string[]>(row.variables_json, []),
    isActive: Number(row.is_active ?? 1) === 1,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  }
}

function rowToPromptTemplateVersion(row: Record<string, unknown>): PromptTemplateVersion {
  return {
    id: Number(row.id),
    promptTemplateId: Number(row.prompt_template_id),
    version: Number(row.version),
    templateText: String(row.template_text),
    variablesJson: parseJSON<string[]>(row.variables_json, []),
    createdAt: Number(row.created_at ?? 0),
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial Pi workflow storage schema",
    statements: [
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        idx INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        plan_model TEXT NOT NULL DEFAULT 'default',
        execution_model TEXT NOT NULL DEFAULT 'default',
        planmode INTEGER NOT NULL DEFAULT 0,
        auto_approve_plan INTEGER NOT NULL DEFAULT 0,
        review INTEGER NOT NULL DEFAULT 1,
        auto_commit INTEGER NOT NULL DEFAULT 1,
        delete_worktree INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'backlog',
        requirements TEXT NOT NULL DEFAULT '[]',
        agent_output TEXT NOT NULL DEFAULT '',
        review_count INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        session_url TEXT,
        worktree_dir TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        thinking_level TEXT NOT NULL DEFAULT 'default',
        execution_phase TEXT NOT NULL DEFAULT 'not_started',
        awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
        plan_revision_count INTEGER NOT NULL DEFAULT 0,
        execution_strategy TEXT NOT NULL DEFAULT 'standard',
        best_of_n_config TEXT,
        best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
        skip_permission_asking INTEGER NOT NULL DEFAULT 1,
        max_review_runs_override INTEGER,
        smart_repair_hints TEXT,
        review_activity TEXT NOT NULL DEFAULT 'idle',
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status_idx ON tasks(status, idx);`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_execution_strategy ON tasks(execution_strategy);`,
      `
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        display_name TEXT NOT NULL DEFAULT '',
        target_task_id TEXT,
        task_order_json TEXT NOT NULL DEFAULT '[]',
        current_task_id TEXT,
        current_task_index INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        stop_requested INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_runs_current_task_id ON workflow_runs(current_task_id);`,
      `
      CREATE TABLE IF NOT EXISTS workflow_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        task_run_id TEXT,
        session_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        cwd TEXT NOT NULL,
        worktree_dir TEXT,
        branch TEXT,
        pi_session_id TEXT,
        pi_session_file TEXT,
        process_pid INTEGER,
        model TEXT NOT NULL DEFAULT 'default',
        thinking_level TEXT NOT NULL DEFAULT 'default',
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER,
        exit_code INTEGER,
        exit_signal TEXT,
        error_message TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_id ON workflow_sessions(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_status ON workflow_sessions(status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_status ON workflow_sessions(task_id, status);`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_sessions_pi_session ON workflow_sessions(pi_session_id);`,
      `
      CREATE TABLE IF NOT EXISTS session_io (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        stream TEXT NOT NULL,
        record_type TEXT NOT NULL,
        payload_json TEXT,
        payload_text TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, seq)
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_session_io_session_id ON session_io(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_io_session_seq ON session_io(session_id, seq);`,
      `CREATE INDEX IF NOT EXISTS idx_session_io_record_type ON session_io(record_type);`,
      `CREATE INDEX IF NOT EXISTS idx_session_io_created_at ON session_io(created_at);`,
      `CREATE INDEX IF NOT EXISTS idx_session_io_payload_type ON session_io(record_type, created_at);`,
      `
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        task_run_id TEXT,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content_json TEXT NOT NULL,
        model_provider TEXT,
        model_id TEXT,
        agent_name TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_name TEXT,
        tool_args_json TEXT,
        tool_result_json TEXT,
        tool_status TEXT,
        edit_diff TEXT,
        edit_file_path TEXT,
        session_status TEXT,
        workflow_phase TEXT,
        raw_event_json TEXT,
        FOREIGN KEY(session_id) REFERENCES workflow_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_task_id ON session_messages(task_id);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);`,
      `
      CREATE TABLE IF NOT EXISTS options (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      `,
      `
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        template_text TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_key ON prompt_templates(key);`,
      `CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(is_active);`,
      `
      CREATE TABLE IF NOT EXISTS prompt_template_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_template_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        template_text TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(prompt_template_id) REFERENCES prompt_templates(id) ON DELETE CASCADE,
        UNIQUE(prompt_template_id, version)
      );
      `,
      `CREATE INDEX IF NOT EXISTS idx_prompt_template_versions_template_id ON prompt_template_versions(prompt_template_id);`,
    ],
  },
]

export class PiKanbanDB {
  private readonly db: Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = DELETE")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA foreign_keys = ON")

    runMigrations(this.db, MIGRATIONS)
    this.seedDefaultOptions()
    this.seedPromptTemplates()
  }

  close(): void {
    this.db.close(false)
  }

  // ---- tasks ----

  getTasks(): Task[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE is_archived = 0 ORDER BY idx ASC").all() as Record<string, unknown>[]
    return rows.map(rowToTask)
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND is_archived = 0").get(id) as Record<string, unknown> | null
    return row ? rowToTask(row) : null
  }

  createTask(input: CreateTaskInput): Task {
    const now = nowUnix()
    const idx = input.idx ?? this.getNextTaskIndex()

    this.db
      .prepare(`
        INSERT INTO tasks (
          id, name, idx, prompt, branch, plan_model, execution_model, planmode,
          auto_approve_plan, review, auto_commit, delete_worktree, status,
          requirements, agent_output, review_count, created_at, updated_at,
          thinking_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)
      `)
      .run(
        input.id,
        input.name,
        idx,
        input.prompt,
        input.branch ?? "",
        input.planModel ?? DEFAULT_OPTIONS.planModel,
        input.executionModel ?? DEFAULT_OPTIONS.executionModel,
        input.planmode ? 1 : 0,
        input.autoApprovePlan ? 1 : 0,
        input.review !== false ? 1 : 0,
        input.autoCommit !== false ? 1 : 0,
        input.deleteWorktree !== false ? 1 : 0,
        input.status ?? "backlog",
        JSON.stringify(input.requirements ?? []),
        now,
        now,
        input.thinkingLevel ?? "default",
      )

    return this.getTask(input.id) as Task
  }

  updateTask(id: string, input: UpdateTaskInput): Task | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.name !== undefined) {
      sets.push("name = ?")
      values.push(input.name)
    }
    if (input.prompt !== undefined) {
      sets.push("prompt = ?")
      values.push(input.prompt)
    }
    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.idx !== undefined) {
      sets.push("idx = ?")
      values.push(input.idx)
    }
    if (input.branch !== undefined) {
      sets.push("branch = ?")
      values.push(input.branch)
    }
    if (input.planModel !== undefined) {
      sets.push("plan_model = ?")
      values.push(input.planModel)
    }
    if (input.executionModel !== undefined) {
      sets.push("execution_model = ?")
      values.push(input.executionModel)
    }
    if (input.planmode !== undefined) {
      sets.push("planmode = ?")
      values.push(input.planmode ? 1 : 0)
    }
    if (input.autoApprovePlan !== undefined) {
      sets.push("auto_approve_plan = ?")
      values.push(input.autoApprovePlan ? 1 : 0)
    }
    if (input.review !== undefined) {
      sets.push("review = ?")
      values.push(input.review ? 1 : 0)
    }
    if (input.autoCommit !== undefined) {
      sets.push("auto_commit = ?")
      values.push(input.autoCommit ? 1 : 0)
    }
    if (input.deleteWorktree !== undefined) {
      sets.push("delete_worktree = ?")
      values.push(input.deleteWorktree ? 1 : 0)
    }
    if (input.requirements !== undefined) {
      sets.push("requirements = ?")
      values.push(JSON.stringify(input.requirements))
    }
    if (input.agentOutput !== undefined) {
      sets.push("agent_output = ?")
      values.push(input.agentOutput)
    }
    if (input.sessionId !== undefined) {
      sets.push("session_id = ?")
      values.push(input.sessionId)
    }
    if (input.sessionUrl !== undefined) {
      sets.push("session_url = ?")
      values.push(input.sessionUrl)
    }
    if (input.worktreeDir !== undefined) {
      sets.push("worktree_dir = ?")
      values.push(input.worktreeDir)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }
    if (input.reviewCount !== undefined) {
      sets.push("review_count = ?")
      values.push(input.reviewCount)
    }
    if (input.completedAt !== undefined) {
      sets.push("completed_at = ?")
      values.push(input.completedAt)
    }
    if (input.thinkingLevel !== undefined) {
      sets.push("thinking_level = ?")
      values.push(input.thinkingLevel)
    }

    if (sets.length === 0) return this.getTask(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getTask(id)
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    return result.changes > 0
  }

  // ---- workflow runs ----

  createWorkflowRun(input: CreateWorkflowRunInput): WorkflowRun {
    const now = nowUnix()
    const createdAt = input.createdAt ?? now
    const startedAt = input.startedAt ?? now

    this.db
      .prepare(`
        INSERT INTO workflow_runs (
          id, kind, status, display_name, target_task_id, task_order_json,
          current_task_id, current_task_index, pause_requested, stop_requested,
          error_message, created_at, started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.kind,
        input.status ?? "running",
        input.displayName ?? "",
        input.targetTaskId ?? null,
        JSON.stringify(input.taskOrder ?? []),
        input.currentTaskId ?? null,
        input.currentTaskIndex ?? 0,
        input.pauseRequested ? 1 : 0,
        input.stopRequested ? 1 : 0,
        input.errorMessage ?? null,
        createdAt,
        startedAt,
        now,
        input.finishedAt ?? null,
      )

    return this.getWorkflowRun(input.id) as WorkflowRun
  }

  getWorkflowRun(id: string): WorkflowRun | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToWorkflowRun(row) : null
  }

  getWorkflowRuns(): WorkflowRun[] {
    const rows = this.db.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC, created_at DESC").all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowRun)
  }

  updateWorkflowRun(id: string, input: UpdateWorkflowRunInput): WorkflowRun | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.displayName !== undefined) {
      sets.push("display_name = ?")
      values.push(input.displayName)
    }
    if (input.targetTaskId !== undefined) {
      sets.push("target_task_id = ?")
      values.push(input.targetTaskId)
    }
    if (input.taskOrder !== undefined) {
      sets.push("task_order_json = ?")
      values.push(JSON.stringify(input.taskOrder))
    }
    if (input.currentTaskId !== undefined) {
      sets.push("current_task_id = ?")
      values.push(input.currentTaskId)
    }
    if (input.currentTaskIndex !== undefined) {
      sets.push("current_task_index = ?")
      values.push(input.currentTaskIndex)
    }
    if (input.pauseRequested !== undefined) {
      sets.push("pause_requested = ?")
      values.push(input.pauseRequested ? 1 : 0)
    }
    if (input.stopRequested !== undefined) {
      sets.push("stop_requested = ?")
      values.push(input.stopRequested ? 1 : 0)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }
    if (input.finishedAt !== undefined) {
      sets.push("finished_at = ?")
      values.push(input.finishedAt)
    }

    if (sets.length === 0) return this.getWorkflowRun(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getWorkflowRun(id)
  }

  // ---- workflow sessions ----

  createWorkflowSession(input: CreatePiWorkflowSessionInput): PiWorkflowSession {
    const now = nowUnix()
    const startedAt = input.startedAt ?? now

    this.db
      .prepare(`
        INSERT INTO workflow_sessions (
          id, task_id, task_run_id, session_kind, status, cwd, worktree_dir, branch,
          pi_session_id, pi_session_file, process_pid, model, thinking_level,
          started_at, updated_at, finished_at, exit_code, exit_signal, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.taskId ?? null,
        input.taskRunId ?? null,
        input.sessionKind,
        input.status ?? "starting",
        input.cwd,
        input.worktreeDir ?? null,
        input.branch ?? null,
        input.piSessionId ?? null,
        input.piSessionFile ?? null,
        input.processPid ?? null,
        input.model ?? "default",
        input.thinkingLevel ?? "default",
        startedAt,
        now,
        input.finishedAt ?? null,
        input.exitCode ?? null,
        input.exitSignal ?? null,
        input.errorMessage ?? null,
      )

    return this.getWorkflowSession(input.id) as PiWorkflowSession
  }

  getWorkflowSession(id: string): PiWorkflowSession | null {
    const row = this.db.prepare("SELECT * FROM workflow_sessions WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToWorkflowSession(row) : null
  }

  getWorkflowSessionsByTask(taskId: string): PiWorkflowSession[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_sessions WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  getActiveWorkflowSessions(): PiWorkflowSession[] {
    const rows = this.db
      .prepare("SELECT * FROM workflow_sessions WHERE status IN ('starting', 'active', 'paused') ORDER BY started_at ASC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToWorkflowSession)
  }

  updateWorkflowSession(id: string, input: UpdatePiWorkflowSessionInput): PiWorkflowSession | null {
    const sets: string[] = []
    const values: any[] = []

    if (input.taskId !== undefined) {
      sets.push("task_id = ?")
      values.push(input.taskId)
    }
    if (input.taskRunId !== undefined) {
      sets.push("task_run_id = ?")
      values.push(input.taskRunId)
    }
    if (input.status !== undefined) {
      sets.push("status = ?")
      values.push(input.status)
    }
    if (input.cwd !== undefined) {
      sets.push("cwd = ?")
      values.push(input.cwd)
    }
    if (input.worktreeDir !== undefined) {
      sets.push("worktree_dir = ?")
      values.push(input.worktreeDir)
    }
    if (input.branch !== undefined) {
      sets.push("branch = ?")
      values.push(input.branch)
    }
    if (input.piSessionId !== undefined) {
      sets.push("pi_session_id = ?")
      values.push(input.piSessionId)
    }
    if (input.piSessionFile !== undefined) {
      sets.push("pi_session_file = ?")
      values.push(input.piSessionFile)
    }
    if (input.processPid !== undefined) {
      sets.push("process_pid = ?")
      values.push(input.processPid)
    }
    if (input.model !== undefined) {
      sets.push("model = ?")
      values.push(input.model)
    }
    if (input.thinkingLevel !== undefined) {
      sets.push("thinking_level = ?")
      values.push(input.thinkingLevel)
    }
    if (input.finishedAt !== undefined) {
      sets.push("finished_at = ?")
      values.push(input.finishedAt)
    }
    if (input.exitCode !== undefined) {
      sets.push("exit_code = ?")
      values.push(input.exitCode)
    }
    if (input.exitSignal !== undefined) {
      sets.push("exit_signal = ?")
      values.push(input.exitSignal)
    }
    if (input.errorMessage !== undefined) {
      sets.push("error_message = ?")
      values.push(input.errorMessage)
    }

    if (sets.length === 0) return this.getWorkflowSession(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE workflow_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getWorkflowSession(id)
  }

  // ---- raw session capture ----

  appendSessionIO(input: AppendSessionIOInput): SessionIORecord {
    const nextSeq = input.seq ?? this.getLatestSessionSeq(input.sessionId) + 1
    const createdAt = input.createdAt ?? nowUnix()

    const result = this.db
      .prepare(`
        INSERT INTO session_io (
          session_id, seq, stream, record_type, payload_json, payload_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.sessionId,
        nextSeq,
        input.stream,
        input.recordType,
        input.payloadJson ? JSON.stringify(input.payloadJson) : null,
        input.payloadText ?? null,
        createdAt,
      )

    const row = this.db.prepare("SELECT * FROM session_io WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
    return rowToSessionIORecord(row)
  }

  getSessionIO(sessionId: string, options: GetSessionIOOptions = {}): SessionIORecord[] {
    const limit = options.limit ?? 500
    const offset = options.offset ?? 0

    if (options.recordType) {
      const rows = this.db
        .prepare(
          `
          SELECT * FROM session_io
          WHERE session_id = ? AND record_type = ?
          ORDER BY seq ASC
          LIMIT ? OFFSET ?
          `,
        )
        .all(sessionId, options.recordType, limit, offset) as Record<string, unknown>[]
      return rows.map(rowToSessionIORecord)
    }

    const rows = this.db
      .prepare(
        `
        SELECT * FROM session_io
        WHERE session_id = ?
        ORDER BY seq ASC
        LIMIT ? OFFSET ?
        `,
      )
      .all(sessionId, limit, offset) as Record<string, unknown>[]
    return rows.map(rowToSessionIORecord)
  }

  getSessionIOByType(sessionId: string, recordType: SessionIORecordType): SessionIORecord[] {
    return this.getSessionIO(sessionId, { recordType })
  }

  getLatestSessionSeq(sessionId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM session_io WHERE session_id = ?").get(sessionId) as { max_seq: number }
    return row.max_seq ?? 0
  }

  getSessionSnapshot(sessionId: string): SessionIORecord | null {
    const row = this.db
      .prepare(
        `
        SELECT * FROM session_io
        WHERE session_id = ? AND record_type = 'snapshot'
        ORDER BY seq DESC
        LIMIT 1
        `,
      )
      .get(sessionId) as Record<string, unknown> | null
    return row ? rowToSessionIORecord(row) : null
  }

  // ---- normalized session messages ----

  createSessionMessage(input: CreateSessionMessageInput): SessionMessage {
    const timestamp = input.timestamp ?? nowUnix()
    const result = this.db
      .prepare(`
        INSERT INTO session_messages (
          message_id, session_id, task_id, task_run_id, timestamp, role, message_type,
          content_json, model_provider, model_id, agent_name, prompt_tokens,
          completion_tokens, total_tokens, tool_name, tool_args_json, tool_result_json,
          tool_status, edit_diff, edit_file_path, session_status, workflow_phase, raw_event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.messageId ?? null,
        input.sessionId,
        input.taskId ?? null,
        input.taskRunId ?? null,
        timestamp,
        input.role,
        input.messageType,
        JSON.stringify(input.contentJson),
        input.modelProvider ?? null,
        input.modelId ?? null,
        input.agentName ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.totalTokens ?? null,
        input.toolName ?? null,
        input.toolArgsJson ? JSON.stringify(input.toolArgsJson) : null,
        input.toolResultJson ? JSON.stringify(input.toolResultJson) : null,
        input.toolStatus ?? null,
        input.editDiff ?? null,
        input.editFilePath ?? null,
        input.sessionStatus ?? null,
        input.workflowPhase ?? null,
        input.rawEventJson ? JSON.stringify(input.rawEventJson) : null,
      )

    const row = this.db.prepare("SELECT * FROM session_messages WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
    return rowToSessionMessage(row)
  }

  getSessionMessages(sessionId: string, options: SessionMessageQueryOptions = {}): SessionMessage[] {
    const limit = options.limit ?? 500
    const offset = options.offset ?? 0

    if (options.messageType) {
      const rows = this.db
        .prepare(
          `
          SELECT * FROM session_messages
          WHERE session_id = ? AND message_type = ?
          ORDER BY timestamp ASC, id ASC
          LIMIT ? OFFSET ?
          `,
        )
        .all(sessionId, options.messageType, limit, offset) as Record<string, unknown>[]
      return rows.map(rowToSessionMessage)
    }

    const rows = this.db
      .prepare(
        `
        SELECT * FROM session_messages
        WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ? OFFSET ?
        `,
      )
      .all(sessionId, limit, offset) as Record<string, unknown>[]
    return rows.map(rowToSessionMessage)
  }

  getSessionTimeline(sessionId: string): SessionMessage[] {
    return this.getSessionMessages(sessionId)
  }

  getSessionMessagesByType(sessionId: string, messageType: MessageType): SessionMessage[] {
    return this.getSessionMessages(sessionId, { messageType })
  }

  updateSessionMessage(id: number, updates: Partial<CreateSessionMessageInput>): SessionMessage | null {
    const sets: string[] = []
    const values: any[] = []

    if (updates.messageId !== undefined) {
      sets.push("message_id = ?")
      values.push(updates.messageId)
    }
    if (updates.taskId !== undefined) {
      sets.push("task_id = ?")
      values.push(updates.taskId)
    }
    if (updates.taskRunId !== undefined) {
      sets.push("task_run_id = ?")
      values.push(updates.taskRunId)
    }
    if (updates.timestamp !== undefined) {
      sets.push("timestamp = ?")
      values.push(updates.timestamp)
    }
    if (updates.role !== undefined) {
      sets.push("role = ?")
      values.push(updates.role)
    }
    if (updates.messageType !== undefined) {
      sets.push("message_type = ?")
      values.push(updates.messageType)
    }
    if (updates.contentJson !== undefined) {
      sets.push("content_json = ?")
      values.push(JSON.stringify(updates.contentJson))
    }
    if (updates.modelProvider !== undefined) {
      sets.push("model_provider = ?")
      values.push(updates.modelProvider)
    }
    if (updates.modelId !== undefined) {
      sets.push("model_id = ?")
      values.push(updates.modelId)
    }
    if (updates.agentName !== undefined) {
      sets.push("agent_name = ?")
      values.push(updates.agentName)
    }
    if (updates.promptTokens !== undefined) {
      sets.push("prompt_tokens = ?")
      values.push(updates.promptTokens)
    }
    if (updates.completionTokens !== undefined) {
      sets.push("completion_tokens = ?")
      values.push(updates.completionTokens)
    }
    if (updates.totalTokens !== undefined) {
      sets.push("total_tokens = ?")
      values.push(updates.totalTokens)
    }
    if (updates.toolName !== undefined) {
      sets.push("tool_name = ?")
      values.push(updates.toolName)
    }
    if (updates.toolArgsJson !== undefined) {
      sets.push("tool_args_json = ?")
      values.push(updates.toolArgsJson ? JSON.stringify(updates.toolArgsJson) : null)
    }
    if (updates.toolResultJson !== undefined) {
      sets.push("tool_result_json = ?")
      values.push(updates.toolResultJson ? JSON.stringify(updates.toolResultJson) : null)
    }
    if (updates.toolStatus !== undefined) {
      sets.push("tool_status = ?")
      values.push(updates.toolStatus)
    }
    if (updates.editDiff !== undefined) {
      sets.push("edit_diff = ?")
      values.push(updates.editDiff)
    }
    if (updates.editFilePath !== undefined) {
      sets.push("edit_file_path = ?")
      values.push(updates.editFilePath)
    }
    if (updates.sessionStatus !== undefined) {
      sets.push("session_status = ?")
      values.push(updates.sessionStatus)
    }
    if (updates.workflowPhase !== undefined) {
      sets.push("workflow_phase = ?")
      values.push(updates.workflowPhase)
    }
    if (updates.rawEventJson !== undefined) {
      sets.push("raw_event_json = ?")
      values.push(updates.rawEventJson ? JSON.stringify(updates.rawEventJson) : null)
    }

    if (sets.length === 0) {
      const row = this.db.prepare("SELECT * FROM session_messages WHERE id = ?").get(id) as Record<string, unknown> | null
      return row ? rowToSessionMessage(row) : null
    }

    values.push(id)
    this.db.prepare(`UPDATE session_messages SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    const row = this.db.prepare("SELECT * FROM session_messages WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? rowToSessionMessage(row) : null
  }

  // ---- options ----

  getOptions(): Options {
    const rows = this.db.prepare("SELECT key, value FROM options").all() as Array<{ key: string; value: string }>
    const values = new Map<string, string>()
    for (const row of rows) values.set(row.key, row.value)

    return {
      commitPrompt: values.get("commit_prompt") ?? DEFAULT_OPTIONS.commitPrompt,
      extraPrompt: values.get("extra_prompt") ?? DEFAULT_OPTIONS.extraPrompt,
      branch: values.get("branch") ?? DEFAULT_OPTIONS.branch,
      planModel: values.get("plan_model") ?? DEFAULT_OPTIONS.planModel,
      executionModel: values.get("execution_model") ?? DEFAULT_OPTIONS.executionModel,
      reviewModel: values.get("review_model") ?? DEFAULT_OPTIONS.reviewModel,
      repairModel: values.get("repair_model") ?? DEFAULT_OPTIONS.repairModel,
      command: values.get("command") ?? DEFAULT_OPTIONS.command,
      parallelTasks: Number(values.get("parallel_tasks") ?? DEFAULT_OPTIONS.parallelTasks),
      autoDeleteNormalSessions: normalizeBoolean(values.get("auto_delete_normal_sessions"), DEFAULT_OPTIONS.autoDeleteNormalSessions),
      autoDeleteReviewSessions: normalizeBoolean(values.get("auto_delete_review_sessions"), DEFAULT_OPTIONS.autoDeleteReviewSessions),
      showExecutionGraph: normalizeBoolean(values.get("show_execution_graph"), DEFAULT_OPTIONS.showExecutionGraph),
      port: Number(values.get("port") ?? DEFAULT_OPTIONS.port),
      thinkingLevel: asThinkingLevel(values.get("thinking_level")),
      telegramBotToken: values.get("telegram_bot_token") ?? DEFAULT_OPTIONS.telegramBotToken,
      telegramChatId: values.get("telegram_chat_id") ?? DEFAULT_OPTIONS.telegramChatId,
      telegramNotificationsEnabled: normalizeBoolean(values.get("telegram_notifications_enabled"), DEFAULT_OPTIONS.telegramNotificationsEnabled),
      maxReviews: Number(values.get("max_reviews") ?? DEFAULT_OPTIONS.maxReviews),
    }
  }

  updateOptions(partial: Partial<Options>): Options {
    const upsert = this.db.prepare(
      "INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )

    if (partial.commitPrompt !== undefined) upsert.run("commit_prompt", partial.commitPrompt)
    if (partial.extraPrompt !== undefined) upsert.run("extra_prompt", partial.extraPrompt)
    if (partial.branch !== undefined) upsert.run("branch", partial.branch)
    if (partial.planModel !== undefined) upsert.run("plan_model", partial.planModel)
    if (partial.executionModel !== undefined) upsert.run("execution_model", partial.executionModel)
    if (partial.reviewModel !== undefined) upsert.run("review_model", partial.reviewModel)
    if (partial.repairModel !== undefined) upsert.run("repair_model", partial.repairModel)
    if (partial.command !== undefined) upsert.run("command", partial.command)
    if (partial.parallelTasks !== undefined) upsert.run("parallel_tasks", String(partial.parallelTasks))
    if (partial.autoDeleteNormalSessions !== undefined) upsert.run("auto_delete_normal_sessions", String(partial.autoDeleteNormalSessions))
    if (partial.autoDeleteReviewSessions !== undefined) upsert.run("auto_delete_review_sessions", String(partial.autoDeleteReviewSessions))
    if (partial.showExecutionGraph !== undefined) upsert.run("show_execution_graph", String(partial.showExecutionGraph))
    if (partial.port !== undefined) upsert.run("port", String(partial.port))
    if (partial.thinkingLevel !== undefined) upsert.run("thinking_level", partial.thinkingLevel)
    if (partial.telegramBotToken !== undefined) upsert.run("telegram_bot_token", partial.telegramBotToken)
    if (partial.telegramChatId !== undefined) upsert.run("telegram_chat_id", partial.telegramChatId)
    if (partial.telegramNotificationsEnabled !== undefined) upsert.run("telegram_notifications_enabled", String(partial.telegramNotificationsEnabled))
    if (partial.maxReviews !== undefined) upsert.run("max_reviews", String(partial.maxReviews))

    return this.getOptions()
  }

  // ---- prompt templates ----

  getPromptTemplate(key: PromptTemplateKey | string): PromptTemplate | null {
    const row = this.db
      .prepare("SELECT * FROM prompt_templates WHERE key = ? AND is_active = 1 LIMIT 1")
      .get(key) as Record<string, unknown> | null
    return row ? rowToPromptTemplate(row) : null
  }

  getAllPromptTemplates(): PromptTemplate[] {
    const rows = this.db
      .prepare("SELECT * FROM prompt_templates ORDER BY key ASC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToPromptTemplate)
  }

  getPromptTemplateVersions(key: PromptTemplateKey | string): PromptTemplateVersion[] {
    const rows = this.db
      .prepare(
        `
        SELECT v.*
        FROM prompt_template_versions v
        INNER JOIN prompt_templates t ON t.id = v.prompt_template_id
        WHERE t.key = ?
        ORDER BY v.version ASC
        `,
      )
      .all(key) as Record<string, unknown>[]
    return rows.map(rowToPromptTemplateVersion)
  }

  upsertPromptTemplate(input: UpsertPromptTemplateInput): PromptTemplate {
    const existing = this.db
      .prepare("SELECT * FROM prompt_templates WHERE key = ? LIMIT 1")
      .get(input.key) as Record<string, unknown> | null

    const variablesJson = JSON.stringify(input.variablesJson ?? [])

    if (!existing) {
      const result = this.db
        .prepare(
          `
          INSERT INTO prompt_templates (
            key, name, description, template_text, variables_json, is_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
          `,
        )
        .run(
          input.key,
          input.name,
          input.description ?? "",
          input.templateText,
          variablesJson,
          input.isActive === false ? 0 : 1,
        )

      const createdRow = this.db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(result.lastInsertRowid) as Record<string, unknown>
      this.insertPromptTemplateVersion(Number(createdRow.id), input.templateText, variablesJson)
      return rowToPromptTemplate(createdRow)
    }

    const existingTemplate = rowToPromptTemplate(existing)
    const templateChanged = existingTemplate.templateText !== input.templateText
    const varsChanged = JSON.stringify(existingTemplate.variablesJson) !== variablesJson

    this.db
      .prepare(
        `
        UPDATE prompt_templates
        SET name = ?, description = ?, template_text = ?, variables_json = ?, is_active = ?, updated_at = unixepoch()
        WHERE key = ?
        `,
      )
      .run(
        input.name,
        input.description ?? existingTemplate.description,
        input.templateText,
        variablesJson,
        input.isActive === undefined ? (existingTemplate.isActive ? 1 : 0) : input.isActive ? 1 : 0,
        input.key,
      )

    if (templateChanged || varsChanged) {
      this.insertPromptTemplateVersion(existingTemplate.id, input.templateText, variablesJson)
    }

    const updatedRow = this.db.prepare("SELECT * FROM prompt_templates WHERE key = ?").get(input.key) as Record<string, unknown>
    return rowToPromptTemplate(updatedRow)
  }

  renderPrompt(key: PromptTemplateKey | string, variables: Record<string, unknown> = {}): PromptRenderResult {
    const template = this.getPromptTemplate(key)
    if (!template) {
      throw new Error(`Prompt template not found or inactive: ${key}`)
    }

    const renderedText = renderTemplate(template, variables)

    return { template, renderedText }
  }

  renderPromptAndCapture(input: PromptRenderAndCaptureInput): PromptRenderResult {
    const rendered = this.renderPrompt(input.key, input.variables ?? {})
    if (input.sessionId) {
      this.appendSessionIO({
        sessionId: input.sessionId,
        stream: input.stream ?? "server",
        recordType: "prompt_rendered",
        payloadJson: {
          templateKey: rendered.template.key,
          templateId: rendered.template.id,
          renderedLength: rendered.renderedText.length,
          variables: input.variables ?? {},
        },
        payloadText: rendered.renderedText,
      })
    }
    return rendered
  }

  // ---- low-level helpers ----

  getRawHandle(): Database {
    return this.db
  }

  private getNextTaskIndex(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(idx), -1) AS max_idx FROM tasks").get() as { max_idx: number }
    return Number(row.max_idx ?? -1) + 1
  }

  private seedDefaultOptions(): void {
    const upsert = this.db.prepare(
      "INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
    )

    upsert.run("commit_prompt", DEFAULT_OPTIONS.commitPrompt)
    upsert.run("extra_prompt", DEFAULT_OPTIONS.extraPrompt)
    upsert.run("branch", DEFAULT_OPTIONS.branch)
    upsert.run("plan_model", DEFAULT_OPTIONS.planModel)
    upsert.run("execution_model", DEFAULT_OPTIONS.executionModel)
    upsert.run("review_model", DEFAULT_OPTIONS.reviewModel)
    upsert.run("repair_model", DEFAULT_OPTIONS.repairModel)
    upsert.run("command", DEFAULT_OPTIONS.command)
    upsert.run("parallel_tasks", String(DEFAULT_OPTIONS.parallelTasks))
    upsert.run("auto_delete_normal_sessions", String(DEFAULT_OPTIONS.autoDeleteNormalSessions))
    upsert.run("auto_delete_review_sessions", String(DEFAULT_OPTIONS.autoDeleteReviewSessions))
    upsert.run("show_execution_graph", String(DEFAULT_OPTIONS.showExecutionGraph))
    upsert.run("port", String(DEFAULT_OPTIONS.port))
    upsert.run("thinking_level", DEFAULT_OPTIONS.thinkingLevel)
    upsert.run("telegram_bot_token", DEFAULT_OPTIONS.telegramBotToken)
    upsert.run("telegram_chat_id", DEFAULT_OPTIONS.telegramChatId)
    upsert.run("telegram_notifications_enabled", String(DEFAULT_OPTIONS.telegramNotificationsEnabled))
    upsert.run("max_reviews", String(DEFAULT_OPTIONS.maxReviews))
  }

  private seedPromptTemplates(): void {
    for (const template of DEFAULT_PROMPT_TEMPLATES) {
      this.upsertPromptTemplate(template)
    }
  }

  private insertPromptTemplateVersion(templateId: number, templateText: string, variablesJsonText: string): void {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS max_version FROM prompt_template_versions WHERE prompt_template_id = ?")
      .get(templateId) as { max_version: number }
    const nextVersion = Number(row.max_version ?? 0) + 1

    this.db
      .prepare(
        `
        INSERT INTO prompt_template_versions (
          prompt_template_id, version, template_text, variables_json, created_at
        ) VALUES (?, ?, ?, ?, unixepoch())
        `,
      )
      .run(templateId, nextVersion, templateText, variablesJsonText)
  }

}
