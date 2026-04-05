/**
 * Kanban Database Layer
 *
 * SQLite database for managing workflow tasks.
 * Adapted from OpenCode plugin for pi extension.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type {
  Task,
  TaskStatus,
  Options,
  ThinkingLevel,
  ExecutionPhase,
  ExecutionStrategy,
  BestOfNConfig,
  BestOfNSubstage,
  TaskRun,
  TaskCandidate,
  RunPhase,
  RunStatus,
} from "./types";

const DEFAULT_OPTIONS: Options = {
  commitPrompt: "",
  branch: "main",
  planModel: "default",
  executionModel: "default",
  reviewModel: "default",
  command: "",
  parallelTasks: 2,
  autoDeleteNormalSessions: false,
  autoDeleteReviewSessions: false,
  showExecutionGraph: true,
  port: 3847,
  thinkingLevel: "default",
  telegramBotToken: "",
  telegramChatId: "",
};

function normalizeBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") return true;
    if (normalized === "0" || normalized === "false") return false;
  }
  return fallback;
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  return value === "low" || value === "medium" || value === "high" || value === "default"
    ? value
    : "default";
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
  };
}

function normalizeExecutionStrategy(value: unknown): ExecutionStrategy {
  return value === "standard" || value === "best_of_n" ? value : "standard";
}

function normalizeBestOfNSubstage(value: unknown): BestOfNSubstage {
  const validSubstages: BestOfNSubstage[] = [
    "idle",
    "workers_running",
    "reviewers_running",
    "final_apply_running",
    "blocked_for_manual_review",
    "completed",
  ];
  if (validSubstages.includes(value as BestOfNSubstage)) {
    return value as BestOfNSubstage;
  }
  return "idle";
}

function normalizeExecutionPhase(value: unknown): ExecutionPhase {
  const validPhases: ExecutionPhase[] = [
    "not_started",
    "plan_complete_waiting_approval",
    "plan_revision_pending",
    "implementation_pending",
    "implementation_done",
  ];
  if (validPhases.includes(value as ExecutionPhase)) {
    return value as ExecutionPhase;
  }
  return "not_started";
}

export type WorkflowSessionKind = "task" | "task_run_worker" | "review" | "plan" | "build" | "repair";

export interface WorkflowSessionEntry {
  taskId: string;
  sessionId: string;
  sessionKind: WorkflowSessionKind;
  skipPermissionAsking: boolean;
  createdAt: number;
}

export interface KanbanDBOptions {
  port?: number;
}

export class KanbanDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string, options?: KanbanDBOptions) {
    this.dbPath = dbPath;

    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.initialize();
  }

  private initialize(): void {
    // Create tasks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        idx INTEGER NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        thinking_level TEXT NOT NULL DEFAULT 'default',
        execution_phase TEXT NOT NULL DEFAULT 'not_started',
        awaiting_plan_approval INTEGER NOT NULL DEFAULT 0,
        plan_revision_count INTEGER NOT NULL DEFAULT 0,
        execution_strategy TEXT NOT NULL DEFAULT 'standard',
        best_of_n_config TEXT,
        best_of_n_substage TEXT NOT NULL DEFAULT 'idle',
        skip_permission_asking INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Create task_runs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        attempt_index INTEGER NOT NULL,
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);

    // Create task_candidates table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        diff_stats_json TEXT NOT NULL DEFAULT '{}',
        verification_json TEXT,
        summary TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);

    // Create workflow_sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_kind TEXT NOT NULL,
        skip_permission_asking INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);

    // Create options table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS options (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_candidates_task_id ON task_candidates(task_id);
    `);

    // Initialize default options
    this.initializeDefaultOptions();
  }

  private initializeDefaultOptions(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO options (key, value) VALUES (?, ?)",
    );

    const transaction = this.db.transaction(() => {
      insert.run("commit_prompt", DEFAULT_OPTIONS.commitPrompt);
      insert.run("branch", DEFAULT_OPTIONS.branch);
      insert.run("plan_model", DEFAULT_OPTIONS.planModel);
      insert.run("execution_model", DEFAULT_OPTIONS.executionModel);
      insert.run("review_model", DEFAULT_OPTIONS.reviewModel);
      insert.run("command", DEFAULT_OPTIONS.command);
      insert.run("parallel_tasks", String(DEFAULT_OPTIONS.parallelTasks));
      insert.run("auto_delete_normal_sessions", String(DEFAULT_OPTIONS.autoDeleteNormalSessions ? 1 : 0));
      insert.run("auto_delete_review_sessions", String(DEFAULT_OPTIONS.autoDeleteReviewSessions ? 1 : 0));
      insert.run("show_execution_graph", String(DEFAULT_OPTIONS.showExecutionGraph ? 1 : 0));
      insert.run("port", String(DEFAULT_OPTIONS.port));
      insert.run("thinking_level", DEFAULT_OPTIONS.thinkingLevel);
      insert.run("telegram_bot_token", DEFAULT_OPTIONS.telegramBotToken);
      insert.run("telegram_chat_id", DEFAULT_OPTIONS.telegramChatId);
    });

    transaction();
  }

  // Task operations
  getTasks(status?: TaskStatus): Task[] {
    let query = "SELECT * FROM tasks";
    const params: any[] = [];

    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }

    query += " ORDER BY idx ASC";

    const rows = this.db.prepare(query).all(...params);
    return rows.map(rowToTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : null;
  }

  createTask(task: Partial<Task> & { id: string; name: string }): Task {
    const now = Date.now();
    const maxIdx = this.db.prepare("SELECT MAX(idx) as max_idx FROM tasks").get() as any;
    const idx = maxIdx?.max_idx ?? -1;

    this.db.prepare(`
      INSERT INTO tasks (
        id, name, idx, prompt, branch, plan_model, execution_model,
        planmode, auto_approve_plan, review, auto_commit, delete_worktree,
        status, requirements, created_at, updated_at, thinking_level,
        execution_strategy, execution_phase
      ) VALUES (
        @id, @name, @idx, @prompt, @branch, @planModel, @executionModel,
        @planmode, @autoApprovePlan, @review, @autoCommit, @deleteWorktree,
        @status, @requirements, @createdAt, @updatedAt, @thinkingLevel,
        @executionStrategy, @executionPhase
      )
    `).run({
      id: task.id,
      name: task.name,
      idx: task.idx ?? idx + 1,
      prompt: task.prompt ?? "",
      branch: task.branch ?? "",
      planModel: task.planModel ?? "default",
      executionModel: task.executionModel ?? "default",
      planmode: task.planmode ? 1 : 0,
      autoApprovePlan: task.autoApprovePlan ? 1 : 0,
      review: task.review ?? 1 ? 1 : 0,
      autoCommit: task.autoCommit ?? 1 ? 1 : 0,
      deleteWorktree: task.deleteWorktree ?? 1 ? 1 : 0,
      status: task.status ?? "backlog",
      requirements: JSON.stringify(task.requirements ?? []),
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? now,
      thinkingLevel: task.thinkingLevel ?? "default",
      executionStrategy: task.executionStrategy ?? "standard",
      executionPhase: task.executionPhase ?? "not_started",
    });

    return this.getTask(task.id)!;
  }

  updateTask(id: string, updates: Partial<Task>): Task | null {
    const now = Date.now();
    const current = this.getTask(id);
    if (!current) return null;

    const fields: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, any> = { id, updatedAt: now };

    if (updates.name !== undefined) {
      fields.push("name = @name");
      params.name = updates.name;
    }
    if (updates.prompt !== undefined) {
      fields.push("prompt = @prompt");
      params.prompt = updates.prompt;
    }
    if (updates.status !== undefined) {
      fields.push("status = @status");
      params.status = updates.status;
      if (updates.status === "done" || updates.status === "completed") {
        fields.push("completed_at = @completedAt");
        params.completedAt = now;
      }
    }
    if (updates.sessionId !== undefined) {
      fields.push("session_id = @sessionId");
      params.sessionId = updates.sessionId;
    }
    if (updates.sessionUrl !== undefined) {
      fields.push("session_url = @sessionUrl");
      params.sessionUrl = updates.sessionUrl;
    }
    if (updates.worktreeDir !== undefined) {
      fields.push("worktree_dir = @worktreeDir");
      params.worktreeDir = updates.worktreeDir;
    }
    if (updates.executionPhase !== undefined) {
      fields.push("execution_phase = @executionPhase");
      params.executionPhase = updates.executionPhase;
    }
    if (updates.awaitingPlanApproval !== undefined) {
      fields.push("awaiting_plan_approval = @awaitingPlanApproval");
      params.awaitingPlanApproval = updates.awaitingPlanApproval ? 1 : 0;
    }
    if (updates.reviewCount !== undefined) {
      fields.push("review_count = @reviewCount");
      params.reviewCount = updates.reviewCount;
    }
    if (updates.errorMessage !== undefined) {
      fields.push("error_message = @errorMessage");
      params.errorMessage = updates.errorMessage;
    }
    if (updates.bestOfNSubstage !== undefined) {
      fields.push("best_of_n_substage = @bestOfNSubstage");
      params.bestOfNSubstage = updates.bestOfNSubstage;
    }

    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = @id`).run(params);

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  reorderTasks(taskIds: string[]): void {
    const update = this.db.prepare("UPDATE tasks SET idx = ? WHERE id = ?");
    const transaction = this.db.transaction(() => {
      taskIds.forEach((id, idx) => {
        update.run(idx, id);
      });
    });
    transaction();
  }

  // Options operations
  getOption(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM options WHERE key = ?").get(key) as any;
    return row?.value ?? null;
  }

  setOption(key: string, value: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO options (key, value) VALUES (?, ?)",
    ).run(key, value);
  }

  getOptions(): Options {
    const rows = this.db.prepare("SELECT key, value FROM options").all() as any[];
    const options: Record<string, string> = {};
    for (const row of rows) {
      options[row.key] = row.value;
    }

    return {
      commitPrompt: options["commit_prompt"] ?? DEFAULT_OPTIONS.commitPrompt,
      branch: options["branch"] ?? DEFAULT_OPTIONS.branch,
      planModel: options["plan_model"] ?? DEFAULT_OPTIONS.planModel,
      executionModel: options["execution_model"] ?? DEFAULT_OPTIONS.executionModel,
      reviewModel: options["review_model"] ?? DEFAULT_OPTIONS.reviewModel,
      command: options["command"] ?? DEFAULT_OPTIONS.command,
      parallelTasks: parseInt(options["parallel_tasks"] ?? String(DEFAULT_OPTIONS.parallelTasks), 10),
      autoDeleteNormalSessions: normalizeBoolean(options["auto_delete_normal_sessions"], DEFAULT_OPTIONS.autoDeleteNormalSessions),
      autoDeleteReviewSessions: normalizeBoolean(options["auto_delete_review_sessions"], DEFAULT_OPTIONS.autoDeleteReviewSessions),
      showExecutionGraph: normalizeBoolean(options["show_execution_graph"], DEFAULT_OPTIONS.showExecutionGraph),
      port: parseInt(options["port"] ?? String(DEFAULT_OPTIONS.port), 10),
      thinkingLevel: (options["thinking_level"] as ThinkingLevel) ?? DEFAULT_OPTIONS.thinkingLevel,
      telegramBotToken: options["telegram_bot_token"] ?? DEFAULT_OPTIONS.telegramBotToken,
      telegramChatId: options["telegram_chat_id"] ?? DEFAULT_OPTIONS.telegramChatId,
    };
  }

  // Workflow session operations
  registerWorkflowSession(entry: WorkflowSessionEntry): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO workflow_sessions
      (session_id, task_id, session_kind, skip_permission_asking, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      entry.sessionId,
      entry.taskId,
      entry.sessionKind,
      entry.skipPermissionAsking ? 1 : 0,
      entry.createdAt,
    );
  }

  getWorkflowSession(sessionId: string): WorkflowSessionEntry | null {
    const row = this.db.prepare(
      "SELECT * FROM workflow_sessions WHERE session_id = ?",
    ).get(sessionId) as any;

    if (!row) return null;

    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      sessionKind: row.session_kind as WorkflowSessionKind,
      skipPermissionAsking: row.skip_permission_asking !== 0,
      createdAt: row.created_at,
    };
  }

  deleteWorkflowSession(sessionId: string): void {
    this.db.prepare("DELETE FROM workflow_sessions WHERE session_id = ?").run(sessionId);
  }

  cleanupStaleWorkflowSessions(): void {
    // Remove sessions older than 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM workflow_sessions WHERE created_at < ?").run(cutoff);
  }

  // Task run operations
  getTaskRuns(taskId: string): TaskRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at ASC",
    ).all(taskId);

    return rows.map((row: any) => ({
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
    }));
  }

  createTaskRun(run: Partial<TaskRun> & { id: string; taskId: string; phase: RunPhase }): TaskRun {
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO task_runs (
        id, task_id, phase, slot_index, attempt_index, model, task_suffix,
        status, session_id, session_url, worktree_dir, created_at, updated_at, metadata_json
      ) VALUES (
        @id, @taskId, @phase, @slotIndex, @attemptIndex, @model, @taskSuffix,
        @status, @sessionId, @sessionUrl, @worktreeDir, @createdAt, @updatedAt, @metadataJson
      )
    `).run({
      id: run.id,
      taskId: run.taskId,
      phase: run.phase,
      slotIndex: run.slotIndex ?? 0,
      attemptIndex: run.attemptIndex ?? 0,
      model: run.model ?? "default",
      taskSuffix: run.taskSuffix ?? null,
      status: run.status ?? "pending",
      sessionId: run.sessionId ?? null,
      sessionUrl: run.sessionUrl ?? null,
      worktreeDir: run.worktreeDir ?? null,
      createdAt: run.createdAt ?? now,
      updatedAt: run.updatedAt ?? now,
      metadataJson: JSON.stringify(run.metadataJson ?? {}),
    });

    return this.getTaskRuns(run.taskId).find((r) => r.id === run.id)!;
  }

  updateTaskRun(id: string, taskId: string, updates: Partial<TaskRun>): void {
    const now = Date.now();
    const fields: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, any> = { id, updatedAt: now };

    if (updates.status !== undefined) {
      fields.push("status = @status");
      params.status = updates.status;
      if (updates.status === "done" || updates.status === "failed") {
        fields.push("completed_at = @completedAt");
        params.completedAt = now;
      }
    }
    if (updates.sessionId !== undefined) {
      fields.push("session_id = @sessionId");
      params.sessionId = updates.sessionId;
    }
    if (updates.summary !== undefined) {
      fields.push("summary = @summary");
      params.summary = updates.summary;
    }
    if (updates.candidateId !== undefined) {
      fields.push("candidate_id = @candidateId");
      params.candidateId = updates.candidateId;
    }
    if (updates.metadataJson !== undefined) {
      fields.push("metadata_json = @metadataJson");
      params.metadataJson = JSON.stringify(updates.metadataJson);
    }

    this.db.prepare(`UPDATE task_runs SET ${fields.join(", ")} WHERE id = @id AND task_id = @taskId`).run(params);
  }

  // Task candidate operations
  getTaskCandidates(taskId: string): TaskCandidate[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_candidates WHERE task_id = ? ORDER BY created_at ASC",
    ).all(taskId);

    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      workerRunId: row.worker_run_id,
      status: row.status,
      changedFilesJson: JSON.parse(row.changed_files_json || "[]"),
      diffStatsJson: JSON.parse(row.diff_stats_json || "{}"),
      verificationJson: row.verification_json ? JSON.parse(row.verification_json) : null,
      summary: row.summary,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  createTaskCandidate(candidate: Partial<TaskCandidate> & { id: string; taskId: string; workerRunId: string }): TaskCandidate {
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO task_candidates (
        id, task_id, worker_run_id, status, changed_files_json,
        diff_stats_json, verification_json, summary, error_message,
        created_at, updated_at
      ) VALUES (
        @id, @taskId, @workerRunId, @status, @changedFilesJson,
        @diffStatsJson, @verificationJson, @summary, @errorMessage,
        @createdAt, @updatedAt
      )
    `).run({
      id: candidate.id,
      taskId: candidate.taskId,
      workerRunId: candidate.workerRunId,
      status: candidate.status ?? "available",
      changedFilesJson: JSON.stringify(candidate.changedFilesJson ?? []),
      diffStatsJson: JSON.stringify(candidate.diffStatsJson ?? {}),
      verificationJson: candidate.verificationJson ? JSON.stringify(candidate.verificationJson) : null,
      summary: candidate.summary ?? null,
      errorMessage: candidate.errorMessage ?? null,
      createdAt: candidate.createdAt ?? now,
      updatedAt: candidate.updatedAt ?? now,
    });

    return this.getTaskCandidates(candidate.taskId).find((c) => c.id === candidate.id)!;
  }

  close(): void {
    this.db.close();
  }
}
