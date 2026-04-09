import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"
import type { Task, TaskStatus, Options, ThinkingLevel, ExecutionPhase, ExecutionStrategy, BestOfNConfig, BestOfNSubstage, TaskRun, TaskCandidate, RunPhase, RunStatus, SessionMessage, CreateSessionMessageInput, WorkflowRun, WorkflowRunKind, WorkflowRunStatus } from "./types"
import { DEFAULT_COMMIT_PROMPT } from "./types"
import { hasCapturedPlanOutput, hasCapturedRevisionRequest } from "./task-state"

// Color palette for workflow runs - distinct colors that work well with dark theme
const RUN_COLORS = [
  "#ff6b6b", // Red
  "#4ecdc4", // Teal
  "#45b7d1", // Blue
  "#96ceb4", // Green
  "#feca57", // Yellow
  "#ff9ff3", // Pink
  "#54a0ff", // Light Blue
  "#48dbfb", // Cyan
  "#1dd1a1", // Mint
  "#ffc048", // Orange
  "#5f27cd", // Purple
  "#00d2d3", // Turquoise
]

function pickRunColor(usedColors: string[]): string {
  const available = RUN_COLORS.filter(c => !usedColors.includes(c))
  if (available.length === 0) return RUN_COLORS[Math.floor(Math.random() * RUN_COLORS.length)]
  return available[0]
}

const DEFAULT_OPTIONS: Options = {
  commitPrompt: DEFAULT_COMMIT_PROMPT,
  extraPrompt: "",
  branch: "",
  planModel: "default",
  executionModel: "default",
  reviewModel: "minimax/MiniMax-M2.7",
  repairModel: "minimax/MiniMax-M2.7",
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

function normalizeOptionBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (normalized === "1" || normalized === "true") return true
    if (normalized === "0" || normalized === "false") return false
  }
  return fallback
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return value === "low" || value === "medium" || value === "high" || value === "default"
    ? value
    : "default"
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    name: row.name,
    idx: row.idx,
    prompt: row.prompt,
    branch: row.branch || "",
    planModel: row.plan_model,
    executionModel: row.execution_model,
    planmode: row.planmode === 1,
    autoApprovePlan: row.auto_approve_plan === 1,
    review: row.review === 1,
    autoCommit: row.auto_commit === 1,
    deleteWorktree: row.delete_worktree !== 0,
    status: row.status as TaskStatus,
    requirements: JSON.parse(row.requirements || "[]"),
    agentOutput: row.agent_output || "",
    reviewCount: row.review_count,
    sessionId: row.session_id,
    sessionUrl: row.session_url,
    worktreeDir: row.worktree_dir,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    thinkingLevel: normalizeThinkingLevel(row.thinking_level),
    executionPhase: normalizeExecutionPhase(row.execution_phase),
    awaitingPlanApproval: row.awaiting_plan_approval === 1,
    planRevisionCount: row.plan_revision_count ?? 0,
    executionStrategy: normalizeExecutionStrategy(row.execution_strategy),
    bestOfNConfig: row.best_of_n_config ? JSON.parse(row.best_of_n_config) : null,
    bestOfNSubstage: normalizeBestOfNSubstage(row.best_of_n_substage),
    skipPermissionAsking: row.skip_permission_asking !== 0,
    maxReviewRunsOverride: row.max_review_runs_override ?? null,
    smartRepairHints: row.smart_repair_hints ?? null,
    reviewActivity: normalizeReviewActivity(row.review_activity),
    isArchived: row.is_archived === 1,
    archivedAt: row.archived_at ?? null,
  }
}

function rowToWorkflowRun(row: any): WorkflowRun {
  return {
    id: row.id,
    kind: row.kind as WorkflowRunKind,
    status: row.status as WorkflowRunStatus,
    displayName: row.display_name,
    targetTaskId: row.target_task_id ?? null,
    taskOrder: JSON.parse(row.task_order_json || "[]"),
    currentTaskId: row.current_task_id ?? null,
    currentTaskIndex: row.current_task_index ?? 0,
    pauseRequested: row.pause_requested === 1,
    stopRequested: row.stop_requested === 1,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? null,
    isArchived: row.is_archived === 1,
    archivedAt: row.archived_at ?? null,
    color: row.color ?? "#888888",
  }
}

function normalizeReviewActivity(value: unknown): "idle" | "running" {
  return value === "running" ? "running" : "idle"
}

function normalizeExecutionStrategy(value: unknown): ExecutionStrategy {
  return value === "standard" || value === "best_of_n" ? value : "standard"
}

function normalizeBestOfNSubstage(value: unknown): BestOfNSubstage {
  const validSubstages: BestOfNSubstage[] = ["idle", "workers_running", "reviewers_running", "final_apply_running", "blocked_for_manual_review", "completed"]
  if (validSubstages.includes(value as BestOfNSubstage)) {
    return value as BestOfNSubstage
  }
  return "idle"
}

function normalizeExecutionPhase(value: unknown): ExecutionPhase {
  const validPhases: ExecutionPhase[] = ["not_started", "plan_complete_waiting_approval", "plan_revision_pending", "implementation_pending", "implementation_done"]
  if (validPhases.includes(value as ExecutionPhase)) {
    return value as ExecutionPhase
  }
  return "not_started"
}

export type WorkflowSessionKind =
  | "task"
  | "task_run_worker"
  | "task_run_reviewer"
  | "task_run_final_applier"
  | "review_scratch"
  | "repair"
  | "plan"
  | "plan_revision"

export type WorkflowSessionStatus = "active" | "completed" | "deleted" | "stale"

export interface WorkflowSession {
  sessionId: string
  taskId: string
  taskRunId: string | null
  sessionKind: WorkflowSessionKind
  ownerDirectory: string
  skipPermissionAsking: boolean
  permissionMode: string
  status: WorkflowSessionStatus
  createdAt: number
  updatedAt: number
}

function rowToWorkflowSession(row: any): WorkflowSession {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    sessionKind: row.session_kind as WorkflowSessionKind,
    ownerDirectory: row.owner_directory,
    skipPermissionAsking: row.skip_permission_asking !== 0,
    permissionMode: row.permission_mode,
    status: row.status as WorkflowSessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type TaskStatusChangeListener = (taskId: string, oldStatus: TaskStatus, newStatus: TaskStatus) => void

export class KanbanDB {
  private db: Database
  private _taskStatusChangeListener: TaskStatusChangeListener | null = null

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = DELETE")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
    this.repairInvalidTaskStates()
  }

  private migrate() {
    this.db.exec(`
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
        agent_output TEXT DEFAULT '',
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
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        slot_index INTEGER NOT NULL DEFAULT 0,
        attempt_index INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        task_suffix TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT,
        session_url TEXT,
        worktree_dir TEXT,
        summary TEXT,
        error_message TEXT,
        candidate_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        completed_at INTEGER,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        diff_stats_json TEXT NOT NULL DEFAULT '{}',
        verification_json TEXT NOT NULL DEFAULT '{}',
        summary TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(worker_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS options (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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
        finished_at INTEGER,
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        color TEXT NOT NULL DEFAULT '#888888'
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_phase ON task_runs(phase);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_task_candidates_task_id ON task_candidates(task_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_current_task_id ON workflow_runs(current_task_id);

      CREATE TABLE IF NOT EXISTS workflow_sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT,
        task_run_id TEXT,
        session_kind TEXT NOT NULL,
        owner_directory TEXT NOT NULL,
        skip_permission_asking INTEGER NOT NULL,
        permission_mode TEXT NOT NULL DEFAULT 'always',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_sessions_task_id ON workflow_sessions(task_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_sessions_status ON workflow_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_sessions_session_kind ON workflow_sessions(session_kind);
    `)

    // Migration: add session_url column if missing
    const tableInfo = this.db.prepare("PRAGMA table_info(tasks)").all() as any[]
    const hasSessionUrl = tableInfo.some((col: any) => col.name === "session_url")
    if (!hasSessionUrl) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN session_url TEXT")
    }

    const hasBranch = tableInfo.some((col: any) => col.name === "branch")
    if (!hasBranch) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT ''")
    }

    const hasDeleteWorktree = tableInfo.some((col: any) => col.name === "delete_worktree")
    if (!hasDeleteWorktree) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN delete_worktree INTEGER NOT NULL DEFAULT 1")
    }

    const hasAutoApprovePlan = tableInfo.some((col: any) => col.name === "auto_approve_plan")
    if (!hasAutoApprovePlan) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN auto_approve_plan INTEGER NOT NULL DEFAULT 0")
    }

    const hasThinkingLevel = tableInfo.some((col: any) => col.name === "thinking_level")
    if (!hasThinkingLevel) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'default'")
    }

    const hasExecutionPhase = tableInfo.some((col: any) => col.name === "execution_phase")
    if (!hasExecutionPhase) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'not_started'")
    }

    const hasAwaitingPlanApproval = tableInfo.some((col: any) => col.name === "awaiting_plan_approval")
    if (!hasAwaitingPlanApproval) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN awaiting_plan_approval INTEGER NOT NULL DEFAULT 0")
    }

    const hasExecutionStrategy = tableInfo.some((col: any) => col.name === "execution_strategy")
    if (!hasExecutionStrategy) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN execution_strategy TEXT NOT NULL DEFAULT 'standard'")
    }

    const hasBestOfNConfig = tableInfo.some((col: any) => col.name === "best_of_n_config")
    if (!hasBestOfNConfig) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN best_of_n_config TEXT")
    }

    const hasBestOfNSubstage = tableInfo.some((col: any) => col.name === "best_of_n_substage")
    if (!hasBestOfNSubstage) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN best_of_n_substage TEXT NOT NULL DEFAULT 'idle'")
    }

    const hasPlanRevisionCount = tableInfo.some((col: any) => col.name === "plan_revision_count")
    if (!hasPlanRevisionCount) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN plan_revision_count INTEGER NOT NULL DEFAULT 0")
    }

    const hasSkipPermissionAsking = tableInfo.some((col: any) => col.name === "skip_permission_asking")
    if (!hasSkipPermissionAsking) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN skip_permission_asking INTEGER NOT NULL DEFAULT 1")
    }

    const hasMaxReviewRunsOverride = tableInfo.some((col: any) => col.name === "max_review_runs_override")
    if (!hasMaxReviewRunsOverride) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN max_review_runs_override INTEGER")
    }

    const hasSmartRepairHints = tableInfo.some((col: any) => col.name === "smart_repair_hints")
    if (!hasSmartRepairHints) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN smart_repair_hints TEXT")
    }

    const hasReviewActivity = tableInfo.some((col: any) => col.name === "review_activity")
    if (!hasReviewActivity) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN review_activity TEXT NOT NULL DEFAULT 'idle'")
    }

    const hasIsArchived = tableInfo.some((col: any) => col.name === "is_archived")
    if (!hasIsArchived) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0")
    }

    const hasArchivedAt = tableInfo.some((col: any) => col.name === "archived_at")
    if (!hasArchivedAt) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER")
    }

    const optCount = this.db.query("SELECT COUNT(*) as cnt FROM options").get() as any
    if (optCount.cnt === 0) {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO options (key, value) VALUES (?, ?)"
      )
      insert.run("commit_prompt", DEFAULT_OPTIONS.commitPrompt)
      insert.run("extra_prompt", DEFAULT_OPTIONS.extraPrompt)
      insert.run("branch", DEFAULT_OPTIONS.branch)
      insert.run("plan_model", DEFAULT_OPTIONS.planModel)
      insert.run("execution_model", DEFAULT_OPTIONS.executionModel)
      insert.run("review_model", DEFAULT_OPTIONS.reviewModel)
      insert.run("command", DEFAULT_OPTIONS.command)
      insert.run("parallel_tasks", String(DEFAULT_OPTIONS.parallelTasks))
      insert.run("auto_delete_normal_sessions", String(DEFAULT_OPTIONS.autoDeleteNormalSessions))
      insert.run("auto_delete_review_sessions", String(DEFAULT_OPTIONS.autoDeleteReviewSessions))
      insert.run("port", String(DEFAULT_OPTIONS.port))
      insert.run("thinking_level", DEFAULT_OPTIONS.thinkingLevel)
    }

    const hasThinkingLevelKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'thinking_level'").get() as any
    if (hasThinkingLevelKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('thinking_level', 'default')").run()
    }

    const hasReviewModelKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'review_model'").get() as any
    if (hasReviewModelKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('review_model', ?)").run(DEFAULT_OPTIONS.reviewModel)
    }

    const hasRepairModelKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'repair_model'").get() as any
    if (hasRepairModelKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('repair_model', ?)").run(DEFAULT_OPTIONS.repairModel)
    }

    const hasAutoDeleteNormalSessionsKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'auto_delete_normal_sessions'").get() as any
    if (hasAutoDeleteNormalSessionsKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('auto_delete_normal_sessions', 'false')").run()
    }

    const hasAutoDeleteReviewSessionsKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'auto_delete_review_sessions'").get() as any
    if (hasAutoDeleteReviewSessionsKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('auto_delete_review_sessions', 'false')").run()
    }

    const hasTelegramBotTokenKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'telegram_bot_token'").get() as any
    if (hasTelegramBotTokenKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('telegram_bot_token', '')").run()
    }

    const hasTelegramChatIdKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'telegram_chat_id'").get() as any
    if (hasTelegramChatIdKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('telegram_chat_id', '')").run()
    }

    const hasExtraPromptKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'extra_prompt'").get() as any
    if (hasExtraPromptKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('extra_prompt', '')").run()
    }

    const hasMaxReviewsKey = this.db.prepare("SELECT COUNT(*) as cnt FROM options WHERE key = 'max_reviews'").get() as any
    if (hasMaxReviewsKey.cnt === 0) {
      this.db.prepare("INSERT OR IGNORE INTO options (key, value) VALUES ('max_reviews', '2')").run()
    }

    const hasWorkflowSessionsTable = this.db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='workflow_sessions'").get() as any
    if (hasWorkflowSessionsTable.cnt === 0) {
      this.db.exec(`
        CREATE TABLE workflow_sessions (
          session_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_run_id TEXT,
          session_kind TEXT NOT NULL,
          owner_directory TEXT NOT NULL,
          skip_permission_asking INTEGER NOT NULL,
          permission_mode TEXT NOT NULL DEFAULT 'always',
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX idx_workflow_sessions_task_id ON workflow_sessions(task_id);
        CREATE INDEX idx_workflow_sessions_status ON workflow_sessions(status);
        CREATE INDEX idx_workflow_sessions_session_kind ON workflow_sessions(session_kind);
      `)
    }

    // Migration: Create session_messages table for detailed message logging
    const hasSessionMessagesTable = this.db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='session_messages'").get() as any
    if (hasSessionMessagesTable.cnt === 0) {
      this.db.exec(`
        CREATE TABLE session_messages (
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
          raw_event_json TEXT
        );
        CREATE INDEX idx_session_messages_session_id ON session_messages(session_id);
        CREATE INDEX idx_session_messages_task_id ON session_messages(task_id);
        CREATE INDEX idx_session_messages_timestamp ON session_messages(timestamp);
        CREATE INDEX idx_session_messages_role ON session_messages(role);
        CREATE INDEX idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);
      `)
    } else {
      // Migration: Remove foreign key constraints if they exist (for backward compatibility)
      // Check if the table has foreign keys by looking at the schema
      const tableInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_messages'").get() as any
      if (tableInfo?.sql?.includes('FOREIGN KEY')) {
        console.log("[db] Migrating session_messages table to remove foreign key constraints...")
        // Recreate table without foreign keys
        this.db.exec(`
          CREATE TABLE session_messages_new (
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
            raw_event_json TEXT
          );
          INSERT INTO session_messages_new SELECT * FROM session_messages;
          DROP TABLE session_messages;
          ALTER TABLE session_messages_new RENAME TO session_messages;
          CREATE INDEX idx_session_messages_session_id ON session_messages(session_id);
          CREATE INDEX idx_session_messages_task_id ON session_messages(task_id);
          CREATE INDEX idx_session_messages_timestamp ON session_messages(timestamp);
          CREATE INDEX idx_session_messages_role ON session_messages(role);
          CREATE INDEX idx_session_messages_session_timestamp ON session_messages(session_id, timestamp);
        `)
        console.log("[db] Migration complete: foreign key constraints removed")
      }
    }

    const hasWorkflowRunsTable = this.db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get() as any
    if (hasWorkflowRunsTable.cnt === 0) {
      this.db.exec(`
        CREATE TABLE workflow_runs (
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
          finished_at INTEGER,
          is_archived INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          color TEXT NOT NULL DEFAULT '#888888'
        );
        CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
        CREATE INDEX idx_workflow_runs_current_task_id ON workflow_runs(current_task_id);
      `)
    }

    const workflowRunColumns = this.db.prepare("PRAGMA table_info(workflow_runs)").all() as any[]
    const hasWorkflowRunArchived = workflowRunColumns.some((col: any) => col.name === "is_archived")
    if (!hasWorkflowRunArchived) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0")
    }
    const hasWorkflowRunArchivedAt = workflowRunColumns.some((col: any) => col.name === "archived_at")
    if (!hasWorkflowRunArchivedAt) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN archived_at INTEGER")
    }
    const hasWorkflowRunColor = workflowRunColumns.some((col: any) => col.name === "color")
    if (!hasWorkflowRunColor) {
      this.db.exec("ALTER TABLE workflow_runs ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'")
    }
  }

  private repairInvalidTaskStates() {
    const tasks = (this.db.query("SELECT * FROM tasks ORDER BY idx ASC").all() as any[]).map(rowToTask)
    for (const task of tasks) {
      if (!task.planmode) continue

      const hasPlan = hasCapturedPlanOutput(task.agentOutput)
      const hasRevisionRequest = hasCapturedRevisionRequest(task.agentOutput)

      if (task.executionPhase === "plan_complete_waiting_approval") {
        if (!hasPlan) {
          this.updateTask(task.id, {
            status: "failed",
            awaitingPlanApproval: false,
            executionPhase: "not_started",
            errorMessage: task.errorMessage?.trim()
              ? task.errorMessage
              : "Plan phase completed without a captured [plan] block. Reset the task to backlog and retry.",
          })
          continue
        }

        if (task.status !== "review" || task.awaitingPlanApproval !== true) {
          this.updateTask(task.id, {
            status: "review",
            awaitingPlanApproval: true,
            errorMessage: task.errorMessage,
          })
          continue
        }
      }

      if (task.executionPhase === "plan_revision_pending") {
        if (!hasPlan) {
          this.updateTask(task.id, {
            status: "failed",
            awaitingPlanApproval: false,
            errorMessage: task.errorMessage?.trim()
              ? task.errorMessage
              : "Plan revision was pending without a captured [plan] block. Reset the task to backlog and retry.",
          })
          continue
        }

        if (!hasRevisionRequest) {
          this.updateTask(task.id, {
            status: "review",
            awaitingPlanApproval: true,
            executionPhase: "plan_complete_waiting_approval",
            errorMessage: task.errorMessage?.trim()
              ? task.errorMessage
              : "Plan revision was pending without a captured revision request. Returned the task to plan approval review.",
          })
          continue
        }

        if (task.status !== "backlog" && task.status !== "executing") {
          this.updateTask(task.id, {
            status: "backlog",
            awaitingPlanApproval: false,
          })
          continue
        }

        if (task.awaitingPlanApproval) {
          this.updateTask(task.id, {
            awaitingPlanApproval: false,
          })
          continue
        }
      }

      if (task.executionPhase === "implementation_pending" && !hasPlan) {
        this.updateTask(task.id, {
          status: "failed",
          awaitingPlanApproval: false,
          executionPhase: "not_started",
          errorMessage: task.errorMessage?.trim()
            ? task.errorMessage
            : "Implementation was queued without a captured [plan] block. Reset the task to backlog and retry.",
        })
        continue
      }

      if (task.executionPhase === "implementation_pending" && task.status === "review") {
        this.updateTask(task.id, {
          status: "backlog",
          awaitingPlanApproval: false,
        })
      }
    }

    this.db.prepare(`
      UPDATE tasks
      SET
        status = 'failed',
        best_of_n_substage = 'idle',
        error_message = 'Best-of-n task marked executing but all child runs are terminal with no final result. Reset the task to backlog and retry.',
        updated_at = unixepoch()
      WHERE execution_strategy = 'best_of_n'
        AND status = 'executing'
        AND best_of_n_substage IN ('workers_running', 'reviewers_running', 'final_apply_running')
        AND NOT EXISTS (
          SELECT 1 FROM task_runs
          WHERE task_id = tasks.id
          AND status NOT IN ('done', 'failed', 'skipped')
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_candidates
          WHERE task_id = tasks.id
        )
    `).run()

    this.db.prepare(`
      UPDATE tasks
      SET
        status = 'failed',
        best_of_n_substage = 'idle',
        error_message = 'Best-of-n task in final_apply_running state but no final applier run exists. Reset the task to backlog and retry.',
        updated_at = unixepoch()
      WHERE execution_strategy = 'best_of_n'
        AND status = 'executing'
        AND best_of_n_substage = 'final_apply_running'
        AND NOT EXISTS (
          SELECT 1 FROM task_runs
          WHERE task_id = tasks.id
          AND phase = 'final_applier'
          AND status = 'done'
        )
    `).run()

    this.db.prepare(`
      UPDATE tasks
      SET
        status = 'failed',
        best_of_n_substage = 'idle',
        error_message = 'Best-of-n task in reviewers_running state but no successful workers exist. Reset the task to backlog and retry.',
        updated_at = unixepoch()
      WHERE execution_strategy = 'best_of_n'
        AND status = 'executing'
        AND best_of_n_substage = 'reviewers_running'
        AND NOT EXISTS (
          SELECT 1 FROM task_candidates
          WHERE task_id = tasks.id
        )
    `).run()

    this.db.prepare(`
      UPDATE tasks
      SET
        status = 'done',
        completed_at = COALESCE(completed_at, unixepoch()),
        error_message = NULL,
        updated_at = unixepoch()
      WHERE status = 'review'
        AND execution_strategy = 'standard'
        AND planmode = 0
        AND awaiting_plan_approval = 0
        AND execution_phase = 'not_started'
        AND review_count = 0
        AND trim(COALESCE(agent_output, '')) <> ''
    `).run()
  }

  getTasks(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE is_archived = 0 ORDER BY idx ASC").all() as any[]
    return rows.map(rowToTask)
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ? AND is_archived = 0").get(id) as any
    return row ? rowToTask(row) : null
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE status = ? AND is_archived = 0 ORDER BY idx ASC").all(status) as any[]
    return rows.map(rowToTask)
  }

  createTask(data: {
    name: string
    prompt: string
    status?: TaskStatus
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
    executionPhase?: ExecutionPhase
    awaitingPlanApproval?: boolean
    planRevisionCount?: number
    executionStrategy?: ExecutionStrategy
    bestOfNConfig?: BestOfNConfig | null
    bestOfNSubstage?: BestOfNSubstage
    skipPermissionAsking?: boolean
    maxReviewRunsOverride?: number | null
    smartRepairHints?: string | null
    reviewActivity?: string
  }): Task {
    const id = Math.random().toString(36).substring(2, 10)
    const maxIdx = this.db.query("SELECT COALESCE(MAX(idx), -1) as max_idx FROM tasks").get() as any
    const idx = maxIdx.max_idx + 1
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO tasks (id, name, idx, prompt, branch, plan_model, execution_model, planmode, auto_approve_plan, review, auto_commit, delete_worktree, status, requirements, created_at, updated_at, thinking_level, execution_phase, awaiting_plan_approval, plan_revision_count, execution_strategy, best_of_n_config, best_of_n_substage, skip_permission_asking, max_review_runs_override, smart_repair_hints, review_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      idx,
      data.prompt,
      data.branch ?? this.getOptions().branch,
      data.planModel ?? "default",
      data.executionModel ?? "default",
      data.planmode ? 1 : 0,
      data.autoApprovePlan ? 1 : 0,
      data.review !== false ? 1 : 0,
      data.autoCommit !== false ? 1 : 0,
      data.deleteWorktree !== false ? 1 : 0,
      data.status ?? "backlog",
      JSON.stringify(data.requirements ?? []),
      now,
      now,
      data.thinkingLevel ?? "default",
      data.executionPhase ?? "not_started",
      data.awaitingPlanApproval ? 1 : 0,
      data.planRevisionCount ?? 0,
      data.executionStrategy ?? "standard",
      data.bestOfNConfig ? JSON.stringify(data.bestOfNConfig) : null,
      data.bestOfNSubstage ?? "idle",
      data.skipPermissionAsking !== false ? 1 : 0,
      data.maxReviewRunsOverride ?? null,
      data.smartRepairHints ?? null,
      data.reviewActivity ?? "idle",
    )

    return this.getTask(id)!
  }

  updateTask(id: string, updates: Partial<{
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
  }>): Task | null {
    // Capture old status before applying updates
    const oldTask = this.getTask(id)
    const oldStatus: TaskStatus | undefined = oldTask?.status

    const sets: string[] = []
    const values: any[] = []

    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name) }
    if (updates.idx !== undefined) { sets.push("idx = ?"); values.push(updates.idx) }
    if (updates.prompt !== undefined) { sets.push("prompt = ?"); values.push(updates.prompt) }
    if (updates.branch !== undefined) { sets.push("branch = ?"); values.push(updates.branch) }
    if (updates.planModel !== undefined) { sets.push("plan_model = ?"); values.push(updates.planModel) }
    if (updates.executionModel !== undefined) { sets.push("execution_model = ?"); values.push(updates.executionModel) }
    if (updates.planmode !== undefined) { sets.push("planmode = ?"); values.push(updates.planmode ? 1 : 0) }
    if (updates.autoApprovePlan !== undefined) { sets.push("auto_approve_plan = ?"); values.push(updates.autoApprovePlan ? 1 : 0) }
    if (updates.review !== undefined) { sets.push("review = ?"); values.push(updates.review ? 1 : 0) }
    if (updates.autoCommit !== undefined) { sets.push("auto_commit = ?"); values.push(updates.autoCommit ? 1 : 0) }
    if (updates.deleteWorktree !== undefined) { sets.push("delete_worktree = ?"); values.push(updates.deleteWorktree ? 1 : 0) }
    if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status) }
    if (updates.requirements !== undefined) { sets.push("requirements = ?"); values.push(JSON.stringify(updates.requirements)) }
    if (updates.agentOutput !== undefined) { sets.push("agent_output = ?"); values.push(updates.agentOutput) }
    if (updates.reviewCount !== undefined) { sets.push("review_count = ?"); values.push(updates.reviewCount) }
    if (updates.sessionId !== undefined) { sets.push("session_id = ?"); values.push(updates.sessionId) }
    if (updates.sessionUrl !== undefined) { sets.push("session_url = ?"); values.push(updates.sessionUrl) }
    if (updates.worktreeDir !== undefined) { sets.push("worktree_dir = ?"); values.push(updates.worktreeDir) }
    if (updates.errorMessage !== undefined) { sets.push("error_message = ?"); values.push(updates.errorMessage) }
    if (updates.completedAt !== undefined) { sets.push("completed_at = ?"); values.push(updates.completedAt) }
    if (updates.thinkingLevel !== undefined) { sets.push("thinking_level = ?"); values.push(updates.thinkingLevel) }
    if (updates.executionPhase !== undefined) { sets.push("execution_phase = ?"); values.push(updates.executionPhase) }
    if (updates.awaitingPlanApproval !== undefined) { sets.push("awaiting_plan_approval = ?"); values.push(updates.awaitingPlanApproval ? 1 : 0) }
    if (updates.planRevisionCount !== undefined) { sets.push("plan_revision_count = ?"); values.push(updates.planRevisionCount) }
    if (updates.executionStrategy !== undefined) { sets.push("execution_strategy = ?"); values.push(updates.executionStrategy) }
    if (updates.bestOfNConfig !== undefined) { sets.push("best_of_n_config = ?"); values.push(updates.bestOfNConfig ? JSON.stringify(updates.bestOfNConfig) : null) }
    if (updates.bestOfNSubstage !== undefined) { sets.push("best_of_n_substage = ?"); values.push(updates.bestOfNSubstage) }
    if (updates.skipPermissionAsking !== undefined) { sets.push("skip_permission_asking = ?"); values.push(updates.skipPermissionAsking ? 1 : 0) }
    if (updates.maxReviewRunsOverride !== undefined) { sets.push("max_review_runs_override = ?"); values.push(updates.maxReviewRunsOverride) }
    if (updates.smartRepairHints !== undefined) { sets.push("smart_repair_hints = ?"); values.push(updates.smartRepairHints) }
    if (updates.reviewActivity !== undefined) { sets.push("review_activity = ?"); values.push(updates.reviewActivity) }
    if (updates.isArchived !== undefined) { sets.push("is_archived = ?"); values.push(updates.isArchived ? 1 : 0) }
    if (updates.archivedAt !== undefined) { sets.push("archived_at = ?"); values.push(updates.archivedAt) }

    if (sets.length === 0) return oldTask

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    const updatedTask = this.getTask(id)

    // Fire status change listener if status actually changed
    if (updatedTask && oldStatus !== undefined && oldStatus !== updatedTask.status && this._taskStatusChangeListener) {
      try {
        this._taskStatusChangeListener(id, oldStatus, updatedTask.status)
      } catch (err) {
        // Best-effort: never let listener errors crash task updates
        console.error("[db] taskStatusChangeListener error:", err)
      }
    }

    return updatedTask
  }

  deleteTask(id: string): boolean {
    const allTasks = this.getTasks()
    for (const task of allTasks) {
      if (task.requirements.includes(id)) {
        const newReqs = task.requirements.filter(r => r !== id)
        this.db.prepare("UPDATE tasks SET requirements = ?, updated_at = unixepoch() WHERE id = ?")
          .run(JSON.stringify(newReqs), task.id)
      }
    }
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    return result.changes > 0
  }

  hasTaskExecutionHistory(taskId: string): boolean {
    // Check if task has any execution history
    const task = this.db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as any
    if (!task) return false

    // Has session tracking
    if (task.session_id || task.session_url) return true

    // Has agent output (executed at least once)
    if (task.agent_output && task.agent_output.trim() !== "") return true

    // Has task runs
    const runsCount = this.db.query("SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?").get(taskId) as any
    if (runsCount && runsCount.cnt > 0) return true

    // Has workflow sessions
    const sessionsCount = this.db.query("SELECT COUNT(*) as cnt FROM workflow_sessions WHERE task_id = ?").get(taskId) as any
    if (sessionsCount && sessionsCount.cnt > 0) return true

    // Has session messages
    const messagesCount = this.db.query("SELECT COUNT(*) as cnt FROM session_messages WHERE task_id = ?").get(taskId) as any
    if (messagesCount && messagesCount.cnt > 0) return true

    return false
  }

  archiveTask(id: string): Task | null {
    const task = this.getTask(id)
    if (!task) return null

    // Update task to archived state
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(
      "UPDATE tasks SET is_archived = 1, archived_at = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(now, id)

    // Remove from other tasks' requirements
    const allTasks = this.getTasks()
    for (const t of allTasks) {
      if (t.requirements.includes(id)) {
        const newReqs = t.requirements.filter(r => r !== id)
        this.db.prepare("UPDATE tasks SET requirements = ?, updated_at = unixepoch() WHERE id = ?")
          .run(JSON.stringify(newReqs), t.id)
      }
    }

    // Return the original task object (getTask filters out archived tasks)
    return { ...task, isArchived: true, archivedAt: now }
  }

  unarchiveTask(id: string): Task | null {
    this.db.prepare(
      "UPDATE tasks SET is_archived = 0, archived_at = NULL, updated_at = unixepoch() WHERE id = ?"
    ).run(id)
    return this.getTask(id)
  }

  hardDeleteTask(id: string): boolean {
    // Only allow hard delete for tasks without execution history
    if (this.hasTaskExecutionHistory(id)) {
      return false
    }

    const allTasks = this.getTasks()
    for (const task of allTasks) {
      if (task.requirements.includes(id)) {
        const newReqs = task.requirements.filter(r => r !== id)
        this.db.prepare("UPDATE tasks SET requirements = ?, updated_at = unixepoch() WHERE id = ?")
          .run(JSON.stringify(newReqs), task.id)
      }
    }
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
    return result.changes > 0
  }

  getArchivedTasks(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE is_archived = 1 ORDER BY archived_at DESC").all() as any[]
    return rows.map(rowToTask)
  }

  reorderTask(id: string, newIdx: number): Task | null {
    const task = this.getTask(id)
    if (!task) return null

    if (newIdx < task.idx) {
      this.db.prepare(
        "UPDATE tasks SET idx = idx + 1, updated_at = unixepoch() WHERE idx >= ? AND idx < ? AND id != ?"
      ).run(newIdx, task.idx, id)
    } else if (newIdx > task.idx) {
      this.db.prepare(
        "UPDATE tasks SET idx = idx - 1, updated_at = unixepoch() WHERE idx > ? AND idx <= ? AND id != ?"
      ).run(task.idx, newIdx, id)
    }

    this.db.prepare("UPDATE tasks SET idx = ?, updated_at = unixepoch() WHERE id = ?").run(newIdx, id)
    return this.getTask(id)
  }

  appendAgentOutput(taskId: string, output: string): void {
    this.db.prepare(
      "UPDATE tasks SET agent_output = agent_output || ?, updated_at = unixepoch() WHERE id = ?"
    ).run(output, taskId)
  }

  setTaskStatusChangeListener(listener: TaskStatusChangeListener | null): void {
    this._taskStatusChangeListener = listener
  }

  getOptions(): Options {
    const rows = this.db.query("SELECT key, value FROM options").all() as any[]
    const opts: Record<string, string> = {}
    for (const row of rows) opts[row.key] = row.value

    return {
      commitPrompt: opts.commit_prompt ?? DEFAULT_OPTIONS.commitPrompt,
      extraPrompt: opts.extra_prompt ?? DEFAULT_OPTIONS.extraPrompt,
      branch: opts.branch ?? DEFAULT_OPTIONS.branch,
      planModel: opts.plan_model ?? DEFAULT_OPTIONS.planModel,
      executionModel: opts.execution_model ?? DEFAULT_OPTIONS.executionModel,
      reviewModel: opts.review_model ?? DEFAULT_OPTIONS.reviewModel,
      repairModel: opts.repair_model ?? DEFAULT_OPTIONS.repairModel,
      command: opts.command ?? DEFAULT_OPTIONS.command,
      parallelTasks: parseInt(opts.parallel_tasks ?? "1", 10) || 1,
      autoDeleteNormalSessions: normalizeOptionBoolean(opts.auto_delete_normal_sessions, DEFAULT_OPTIONS.autoDeleteNormalSessions),
      autoDeleteReviewSessions: normalizeOptionBoolean(opts.auto_delete_review_sessions, DEFAULT_OPTIONS.autoDeleteReviewSessions),
      showExecutionGraph: normalizeOptionBoolean(opts.show_execution_graph, DEFAULT_OPTIONS.showExecutionGraph),
      port: parseInt(opts.port ?? "3789", 10) || 3789,
      thinkingLevel: normalizeThinkingLevel(opts.thinking_level) ?? DEFAULT_OPTIONS.thinkingLevel,
      telegramBotToken: opts.telegram_bot_token ?? DEFAULT_OPTIONS.telegramBotToken,
      telegramChatId: opts.telegram_chat_id ?? DEFAULT_OPTIONS.telegramChatId,
      telegramNotificationsEnabled: normalizeOptionBoolean(opts.telegram_notifications_enabled, DEFAULT_OPTIONS.telegramNotificationsEnabled),
      maxReviews: parseInt(opts.max_reviews ?? "2", 10) || 2,
    }
  }

  updateOptions(partial: Partial<Options>): Options {
    const upsert = this.db.prepare(
      "INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
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

  resetTasksForBacklog(): void {
    const tasksToReset = this.db.query("SELECT id FROM tasks WHERE status IN ('executing', 'review', 'failed', 'stuck')").all() as any[]
    for (const task of tasksToReset) {
      this.db.prepare("DELETE FROM task_candidates WHERE task_id = ?").run(task.id)
      this.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(task.id)
    }
    this.db.prepare(
      "UPDATE tasks SET status = 'backlog', session_id = NULL, session_url = NULL, worktree_dir = NULL, agent_output = '', review_count = 0, error_message = NULL, completed_at = NULL, updated_at = unixepoch(), execution_phase = 'not_started', awaiting_plan_approval = 0, plan_revision_count = 0, best_of_n_substage = 'idle', review_activity = 'idle' WHERE status IN ('executing', 'review', 'failed', 'stuck')"
    ).run()
  }

  getNextRunColor(): string {
    const activeRuns = this.getActiveWorkflowRuns()
    const usedColors = activeRuns.map(run => run.color).filter(c => c && c !== "#888888")
    return pickRunColor(usedColors)
  }

  createWorkflowRun(data: {
    kind: WorkflowRunKind
    displayName: string
    taskOrder: string[]
    targetTaskId?: string | null
    status?: WorkflowRunStatus
    currentTaskId?: string | null
    currentTaskIndex?: number
    pauseRequested?: boolean
    stopRequested?: boolean
    errorMessage?: string | null
    finishedAt?: number | null
    color?: string
  }): WorkflowRun {
    const id = Math.random().toString(36).substring(2, 10)
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT INTO workflow_runs (
        id, kind, status, display_name, target_task_id, task_order_json,
        current_task_id, current_task_index, pause_requested, stop_requested,
        error_message, created_at, started_at, updated_at, finished_at, color
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.kind,
      data.status ?? "running",
      data.displayName,
      data.targetTaskId ?? null,
      JSON.stringify(data.taskOrder),
      data.currentTaskId ?? null,
      data.currentTaskIndex ?? 0,
      data.pauseRequested ? 1 : 0,
      data.stopRequested ? 1 : 0,
      data.errorMessage ?? null,
      now,
      now,
      now,
      data.finishedAt ?? null,
      data.color ?? "#888888",
    )
    return this.getWorkflowRun(id)!
  }

  getWorkflowRun(id: string): WorkflowRun | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as any
    return row ? rowToWorkflowRun(row) : null
  }

  getWorkflowRuns(): WorkflowRun[] {
    const rows = this.db.prepare("SELECT * FROM workflow_runs WHERE is_archived = 0 ORDER BY started_at DESC, created_at DESC").all() as any[]
    return rows.map(rowToWorkflowRun)
  }

  getActiveWorkflowRuns(): WorkflowRun[] {
    const rows = this.db.prepare("SELECT * FROM workflow_runs WHERE status IN ('running', 'stopping') ORDER BY started_at ASC, created_at ASC").all() as any[]
    return rows.map(rowToWorkflowRun)
  }

  countConsumedWorkflowSlots(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM workflow_runs WHERE status IN ('running', 'stopping')").get() as any
    return row?.cnt ?? 0
  }

  getActiveWorkflowRunForTask(taskId: string): WorkflowRun | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE current_task_id = ? AND status IN ('running', 'stopping') ORDER BY started_at ASC LIMIT 1").get(taskId) as any
    return row ? rowToWorkflowRun(row) : null
  }

  updateWorkflowRun(id: string, updates: Partial<{
    status: WorkflowRunStatus
    displayName: string
    targetTaskId: string | null
    taskOrder: string[]
    currentTaskId: string | null
    currentTaskIndex: number
    pauseRequested: boolean
    stopRequested: boolean
    errorMessage: string | null
    startedAt: number
    finishedAt: number | null
  }>): WorkflowRun | null {
    const sets: string[] = []
    const values: any[] = []

    if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status) }
    if (updates.displayName !== undefined) { sets.push("display_name = ?"); values.push(updates.displayName) }
    if (updates.targetTaskId !== undefined) { sets.push("target_task_id = ?"); values.push(updates.targetTaskId) }
    if (updates.taskOrder !== undefined) { sets.push("task_order_json = ?"); values.push(JSON.stringify(updates.taskOrder)) }
    if (updates.currentTaskId !== undefined) { sets.push("current_task_id = ?"); values.push(updates.currentTaskId) }
    if (updates.currentTaskIndex !== undefined) { sets.push("current_task_index = ?"); values.push(updates.currentTaskIndex) }
    if (updates.pauseRequested !== undefined) { sets.push("pause_requested = ?"); values.push(updates.pauseRequested ? 1 : 0) }
    if (updates.stopRequested !== undefined) { sets.push("stop_requested = ?"); values.push(updates.stopRequested ? 1 : 0) }
    if (updates.errorMessage !== undefined) { sets.push("error_message = ?"); values.push(updates.errorMessage) }
    if (updates.startedAt !== undefined) { sets.push("started_at = ?"); values.push(updates.startedAt) }
    if (updates.finishedAt !== undefined) { sets.push("finished_at = ?"); values.push(updates.finishedAt) }

    if (sets.length === 0) return this.getWorkflowRun(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)
    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getWorkflowRun(id)
  }

  failStaleWorkflowRuns(errorMessage = "Workflow server restarted while this run was active. Review the last task and restart or repair as needed."): WorkflowRun[] {
    const staleRuns = this.db.prepare("SELECT * FROM workflow_runs WHERE is_archived = 0 AND status IN ('running', 'paused', 'stopping') ORDER BY started_at ASC").all() as any[]
    if (staleRuns.length === 0) return []

    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      UPDATE workflow_runs
      SET status = 'failed', pause_requested = 0, stop_requested = 0, error_message = ?, finished_at = ?, updated_at = ?
      WHERE status IN ('running', 'paused', 'stopping')
    `).run(errorMessage, now, now)

    return staleRuns.map((row) => rowToWorkflowRun({
      ...row,
      status: "failed",
      pause_requested: 0,
      stop_requested: 0,
      error_message: errorMessage,
      finished_at: now,
      updated_at: now,
    }))
  }

  archiveWorkflowRun(id: string): WorkflowRun | null {
    const run = this.getWorkflowRun(id)
    if (!run) return null
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(
      "UPDATE workflow_runs SET is_archived = 1, archived_at = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(now, id)
    return { ...run, isArchived: true, archivedAt: now, updatedAt: now }
  }

  createTaskRun(data: {
    taskId: string
    phase: RunPhase
    slotIndex: number
    attemptIndex: number
    model: string
    taskSuffix?: string | null
    status?: RunStatus
  }): TaskRun {
    const id = Math.random().toString(36).substring(2, 10)
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO task_runs (id, task_id, phase, slot_index, attempt_index, model, task_suffix, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      id,
      data.taskId,
      data.phase,
      data.slotIndex,
      data.attemptIndex,
      data.model,
      data.taskSuffix ?? null,
      data.status ?? "pending",
      now,
      now,
    )

    return this.getTaskRun(id)!
  }

  getTaskRun(id: string): TaskRun | null {
    const row = this.db.query("SELECT * FROM task_runs WHERE id = ?").get(id) as any
    return row ? rowToTaskRun(row) : null
  }

  getTaskRuns(taskId: string): TaskRun[] {
    const rows = this.db.query("SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[]
    return rows.map(rowToTaskRun)
  }

  getTaskRunsByPhase(taskId: string, phase: RunPhase): TaskRun[] {
    const rows = this.db.query("SELECT * FROM task_runs WHERE task_id = ? AND phase = ? ORDER BY created_at ASC").all(taskId, phase) as any[]
    return rows.map(rowToTaskRun)
  }

  updateTaskRun(id: string, updates: Partial<{
    status: RunStatus
    sessionId: string | null
    sessionUrl: string | null
    worktreeDir: string | null
    summary: string | null
    errorMessage: string | null
    candidateId: string | null
    metadataJson: Record<string, any>
    completedAt: number | null
  }>): TaskRun | null {
    const sets: string[] = []
    const values: any[] = []

    if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status) }
    if (updates.sessionId !== undefined) { sets.push("session_id = ?"); values.push(updates.sessionId) }
    if (updates.sessionUrl !== undefined) { sets.push("session_url = ?"); values.push(updates.sessionUrl) }
    if (updates.worktreeDir !== undefined) { sets.push("worktree_dir = ?"); values.push(updates.worktreeDir) }
    if (updates.summary !== undefined) { sets.push("summary = ?"); values.push(updates.summary) }
    if (updates.errorMessage !== undefined) { sets.push("error_message = ?"); values.push(updates.errorMessage) }
    if (updates.candidateId !== undefined) { sets.push("candidate_id = ?"); values.push(updates.candidateId) }
    if (updates.metadataJson !== undefined) { sets.push("metadata_json = ?"); values.push(JSON.stringify(updates.metadataJson)) }
    if (updates.completedAt !== undefined) { sets.push("completed_at = ?"); values.push(updates.completedAt) }

    if (sets.length === 0) return this.getTaskRun(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE task_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getTaskRun(id)
  }

  deleteTaskRunsForTask(taskId: string): void {
    this.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId)
  }

  createTaskCandidate(data: {
    taskId: string
    workerRunId: string
    status?: "available" | "selected" | "rejected"
    changedFiles?: string[]
    diffStats?: Record<string, number>
    verificationJson?: Record<string, any>
    summary?: string | null
    errorMessage?: string | null
  }): TaskCandidate {
    const id = Math.random().toString(36).substring(2, 10)
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO task_candidates (id, task_id, worker_run_id, status, changed_files_json, diff_stats_json, verification_json, summary, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.taskId,
      data.workerRunId,
      data.status ?? "available",
      JSON.stringify(data.changedFiles ?? []),
      JSON.stringify(data.diffStats ?? {}),
      JSON.stringify(data.verificationJson ?? {}),
      data.summary ?? null,
      data.errorMessage ?? null,
      now,
      now,
    )

    return this.getTaskCandidate(id)!
  }

  getTaskCandidate(id: string): TaskCandidate | null {
    const row = this.db.query("SELECT * FROM task_candidates WHERE id = ?").get(id) as any
    return row ? rowToTaskCandidate(row) : null
  }

  getTaskCandidates(taskId: string): TaskCandidate[] {
    const rows = this.db.query("SELECT * FROM task_candidates WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[]
    return rows.map(rowToTaskCandidate)
  }

  updateTaskCandidate(id: string, updates: Partial<{
    status: "available" | "selected" | "rejected"
    changedFilesJson: string[]
    diffStatsJson: Record<string, number>
    verificationJson: Record<string, any>
    summary: string | null
    errorMessage: string | null
  }>): TaskCandidate | null {
    const sets: string[] = []
    const values: any[] = []

    if (updates.status !== undefined) { sets.push("status = ?"); values.push(updates.status) }
    if (updates.changedFilesJson !== undefined) { sets.push("changed_files_json = ?"); values.push(JSON.stringify(updates.changedFilesJson)) }
    if (updates.diffStatsJson !== undefined) { sets.push("diff_stats_json = ?"); values.push(JSON.stringify(updates.diffStatsJson)) }
    if (updates.verificationJson !== undefined) { sets.push("verification_json = ?"); values.push(JSON.stringify(updates.verificationJson)) }
    if (updates.summary !== undefined) { sets.push("summary = ?"); values.push(updates.summary) }
    if (updates.errorMessage !== undefined) { sets.push("error_message = ?"); values.push(updates.errorMessage) }

    if (sets.length === 0) return this.getTaskCandidate(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE task_candidates SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getTaskCandidate(id)
  }

  getBestOfNCounts(taskId: string): { workersTotal: number; workersDone: number; reviewersTotal: number; reviewersDone: number; hasFinalApplier: boolean; finalApplierDone: boolean } {
    const workers = this.getTaskRunsByPhase(taskId, "worker")
    const reviewers = this.getTaskRunsByPhase(taskId, "reviewer")
    const finalApplierRuns = this.getTaskRunsByPhase(taskId, "final_applier")

    return {
      workersTotal: workers.length,
      workersDone: workers.filter(w => w.status === "done" || w.status === "failed" || w.status === "skipped").length,
      reviewersTotal: reviewers.length,
      reviewersDone: reviewers.filter(r => r.status === "done" || r.status === "failed" || r.status === "skipped").length,
      hasFinalApplier: finalApplierRuns.length > 0,
      finalApplierDone: finalApplierRuns.some(f => f.status === "done"),
    }
  }

  registerWorkflowSession(data: {
    sessionId: string
    taskId?: string | null
    taskRunId?: string | null
    sessionKind: WorkflowSessionKind
    ownerDirectory: string
    skipPermissionAsking: boolean
    permissionMode?: string
  }): WorkflowSession {
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(`
      INSERT INTO workflow_sessions (session_id, task_id, task_run_id, session_kind, owner_directory, skip_permission_asking, permission_mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        task_id = excluded.task_id,
        task_run_id = excluded.task_run_id,
        session_kind = excluded.session_kind,
        owner_directory = excluded.owner_directory,
        skip_permission_asking = excluded.skip_permission_asking,
        permission_mode = excluded.permission_mode,
        status = 'active',
        updated_at = excluded.updated_at
    `).run(
      data.sessionId,
      data.taskId ?? null,
      data.taskRunId ?? null,
      data.sessionKind,
      data.ownerDirectory,
      data.skipPermissionAsking ? 1 : 0,
      data.permissionMode ?? "always",
      now,
      now,
    )
    return this.getWorkflowSession(data.sessionId)!
  }

  getWorkflowSession(sessionId: string): WorkflowSession | null {
    const row = this.db.prepare("SELECT * FROM workflow_sessions WHERE session_id = ?").get(sessionId) as any
    return row ? rowToWorkflowSession(row) : null
  }

  getWorkflowSessionsByTask(taskId: string): WorkflowSession[] {
    const rows = this.db.prepare("SELECT * FROM workflow_sessions WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[]
    return rows.map(rowToWorkflowSession)
  }

  markWorkflowSessionStatus(sessionId: string, status: WorkflowSessionStatus): void {
    this.db.prepare("UPDATE workflow_sessions SET status = ?, updated_at = unixepoch() WHERE session_id = ?").run(status, sessionId)
  }

  cleanupStaleWorkflowSessions(maxAgeSeconds = 86400 * 7): void {
    const now = Math.floor(Date.now() / 1000)
    const cutoff = now - maxAgeSeconds
    this.db.prepare("UPDATE workflow_sessions SET status = 'stale', updated_at = ? WHERE status = 'active' AND created_at < ?").run(now, cutoff)
    this.db.prepare("DELETE FROM workflow_sessions WHERE status IN ('deleted', 'stale')").run()
  }

  // Session message logging methods
  createSessionMessage(data: CreateSessionMessageInput): SessionMessage {
    const timestamp = data.timestamp ?? Date.now()
    
    const result = this.db.prepare(`
      INSERT INTO session_messages (
        message_id, session_id, task_id, task_run_id, timestamp, role, message_type,
        content_json, model_provider, model_id, agent_name, prompt_tokens,
        completion_tokens, total_tokens, tool_name, tool_args_json, tool_result_json,
        tool_status, edit_diff, edit_file_path, session_status, workflow_phase, raw_event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.messageId ?? null,
      data.sessionId,
      data.taskId ?? null,
      data.taskRunId ?? null,
      timestamp,
      data.role,
      data.messageType,
      JSON.stringify(data.contentJson),
      data.modelProvider ?? null,
      data.modelId ?? null,
      data.agentName ?? null,
      data.promptTokens ?? null,
      data.completionTokens ?? null,
      data.totalTokens ?? null,
      data.toolName ?? null,
      data.toolArgsJson ? JSON.stringify(data.toolArgsJson) : null,
      data.toolResultJson ? JSON.stringify(data.toolResultJson) : null,
      data.toolStatus ?? null,
      data.editDiff ?? null,
      data.editFilePath ?? null,
      data.sessionStatus ?? null,
      data.workflowPhase ?? null,
      data.rawEventJson ? JSON.stringify(data.rawEventJson) : null
    )
    
    return this.getSessionMessage(result.lastInsertRowid as number)!
  }

  getSessionMessage(id: number): SessionMessage | null {
    const row = this.db.prepare("SELECT * FROM session_messages WHERE id = ?").get(id) as any
    return row ? rowToSessionMessage(row) : null
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    const rows = this.db.prepare("SELECT * FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC").all(sessionId) as any[]
    return rows.map(rowToSessionMessage)
  }

  getSessionMessagesByTask(taskId: string): SessionMessage[] {
    const rows = this.db.prepare("SELECT * FROM session_messages WHERE task_id = ? ORDER BY timestamp ASC").all(taskId) as any[]
    return rows.map(rowToSessionMessage)
  }

  getSessionMessagesByTaskRun(taskRunId: string): SessionMessage[] {
    const rows = this.db.prepare("SELECT * FROM session_messages WHERE task_run_id = ? ORDER BY timestamp ASC").all(taskRunId) as any[]
    return rows.map(rowToSessionMessage)
  }

  getSessionTimeline(sessionId: string, limit?: number, offset?: number): SessionMessage[] {
    let query = "SELECT * FROM session_messages WHERE session_id = ? ORDER BY timestamp ASC"
    const params: any[] = [sessionId]
    
    if (limit !== undefined) {
      query += " LIMIT ?"
      params.push(limit)
    }
    if (offset !== undefined) {
      query += " OFFSET ?"
      params.push(offset)
    }
    
    const rows = this.db.prepare(query).all(...params) as any[]
    return rows.map(rowToSessionMessage)
  }

  getMessageCount(sessionId: string): number {
    const result = this.db.prepare("SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?").get(sessionId) as any
    return result?.count ?? 0
  }

  deleteSessionMessages(sessionId: string): number {
    const result = this.db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(sessionId)
    return result.changes
  }

  cleanupOldSessionMessages(maxAgeDays = 30): number {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)
    const result = this.db.prepare("DELETE FROM session_messages WHERE timestamp < ?").run(cutoff)
    return result.changes
  }

  close() {
    this.db.close()
  }
}

function rowToTaskRun(row: any): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    phase: row.phase as RunPhase,
    slotIndex: row.slot_index,
    attemptIndex: row.attempt_index,
    model: row.model,
    taskSuffix: row.task_suffix,
    status: row.status as RunStatus,
    sessionId: row.session_id,
    sessionUrl: row.session_url,
    worktreeDir: row.worktree_dir,
    summary: row.summary,
    errorMessage: row.error_message,
    candidateId: row.candidate_id,
    metadataJson: JSON.parse(row.metadata_json || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function rowToTaskCandidate(row: any): TaskCandidate {
  return {
    id: row.id,
    taskId: row.task_id,
    workerRunId: row.worker_run_id,
    status: row.status as "available" | "selected" | "rejected",
    changedFilesJson: JSON.parse(row.changed_files_json || "[]"),
    diffStatsJson: JSON.parse(row.diff_stats_json || "{}"),
    verificationJson: JSON.parse(row.verification_json || "{}"),
    summary: row.summary,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSessionMessage(row: any): SessionMessage {
  return {
    id: row.id,
    messageId: row.message_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    timestamp: row.timestamp,
    role: row.role as import("./types").MessageRole,
    messageType: row.message_type as import("./types").MessageType,
    contentJson: JSON.parse(row.content_json || "{}"),
    modelProvider: row.model_provider,
    modelId: row.model_id,
    agentName: row.agent_name,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    toolName: row.tool_name,
    toolArgsJson: row.tool_args_json ? JSON.parse(row.tool_args_json) : null,
    toolResultJson: row.tool_result_json ? JSON.parse(row.tool_result_json) : null,
    toolStatus: row.tool_status,
    editDiff: row.edit_diff,
    editFilePath: row.edit_file_path,
    sessionStatus: row.session_status,
    workflowPhase: row.workflow_phase,
    rawEventJson: row.raw_event_json ? JSON.parse(row.raw_event_json) : null,
  }
}
