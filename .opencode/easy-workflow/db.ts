import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { dirname } from "path"
import type { Task, TaskStatus, Options, ThinkingLevel, ExecutionPhase, ExecutionStrategy, BestOfNConfig, BestOfNSubstage, TaskRun, TaskCandidate, RunPhase, RunStatus } from "./types"
import { DEFAULT_COMMIT_PROMPT } from "./types"

const DEFAULT_OPTIONS: Options = {
  commitPrompt: DEFAULT_COMMIT_PROMPT,
  branch: "main",
  planModel: "default",
  executionModel: "default",
  reviewModel: "minimax/MiniMax-M2.7",
  command: "",
  parallelTasks: 1,
  port: 3789,
  thinkingLevel: "default",
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
    branch: row.branch || "main",
    planModel: row.plan_model,
    executionModel: row.execution_model,
    planmode: row.planmode === 1,
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
  }
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

export class KanbanDB {
  private db: Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
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
        branch TEXT NOT NULL DEFAULT 'main',
        plan_model TEXT NOT NULL DEFAULT 'default',
        execution_model TEXT NOT NULL DEFAULT 'default',
        planmode INTEGER NOT NULL DEFAULT 0,
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
        best_of_n_substage TEXT NOT NULL DEFAULT 'idle'
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

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_idx ON tasks(idx);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id ON task_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_phase ON task_runs(phase);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_task_candidates_task_id ON task_candidates(task_id);
    `)

    // Migration: add session_url column if missing
    const tableInfo = this.db.prepare("PRAGMA table_info(tasks)").all() as any[]
    const hasSessionUrl = tableInfo.some((col: any) => col.name === "session_url")
    if (!hasSessionUrl) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN session_url TEXT")
    }

    const hasBranch = tableInfo.some((col: any) => col.name === "branch")
    if (!hasBranch) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT 'main'")
    }

    const hasDeleteWorktree = tableInfo.some((col: any) => col.name === "delete_worktree")
    if (!hasDeleteWorktree) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN delete_worktree INTEGER NOT NULL DEFAULT 1")
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

    const optCount = this.db.query("SELECT COUNT(*) as cnt FROM options").get() as any
    if (optCount.cnt === 0) {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO options (key, value) VALUES (?, ?)"
      )
      insert.run("commit_prompt", DEFAULT_OPTIONS.commitPrompt)
      insert.run("branch", DEFAULT_OPTIONS.branch)
      insert.run("plan_model", DEFAULT_OPTIONS.planModel)
      insert.run("execution_model", DEFAULT_OPTIONS.executionModel)
      insert.run("review_model", DEFAULT_OPTIONS.reviewModel)
      insert.run("command", DEFAULT_OPTIONS.command)
      insert.run("parallel_tasks", String(DEFAULT_OPTIONS.parallelTasks))
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
  }

  private repairInvalidTaskStates() {
    this.db.prepare(`
      UPDATE tasks
      SET
        status = 'failed',
        awaiting_plan_approval = 0,
        execution_phase = 'not_started',
        error_message = CASE
          WHEN error_message IS NULL OR trim(error_message) = ''
            THEN 'Plan phase completed without any captured plan output. Reset the task to backlog and retry.'
          ELSE error_message
        END,
        updated_at = unixepoch()
      WHERE planmode = 1
        AND status = 'review'
        AND awaiting_plan_approval = 1
        AND execution_phase = 'plan_complete_waiting_approval'
        AND trim(COALESCE(agent_output, '')) = ''
    `).run()

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
    const rows = this.db.query("SELECT * FROM tasks ORDER BY idx ASC").all() as any[]
    return rows.map(rowToTask)
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any
    return row ? rowToTask(row) : null
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE status = ? ORDER BY idx ASC").all(status) as any[]
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
  }): Task {
    const id = Math.random().toString(36).substring(2, 10)
    const maxIdx = this.db.query("SELECT COALESCE(MAX(idx), -1) as max_idx FROM tasks").get() as any
    const idx = maxIdx.max_idx + 1
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
      INSERT INTO tasks (id, name, idx, prompt, branch, plan_model, execution_model, planmode, review, auto_commit, delete_worktree, status, requirements, created_at, updated_at, thinking_level, execution_phase, awaiting_plan_approval, plan_revision_count, execution_strategy, best_of_n_config, best_of_n_substage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      idx,
      data.prompt,
      data.branch ?? this.getOptions().branch,
      data.planModel ?? "default",
      data.executionModel ?? "default",
      data.planmode ? 1 : 0,
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
  }>): Task | null {
    const sets: string[] = []
    const values: any[] = []

    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name) }
    if (updates.idx !== undefined) { sets.push("idx = ?"); values.push(updates.idx) }
    if (updates.prompt !== undefined) { sets.push("prompt = ?"); values.push(updates.prompt) }
    if (updates.branch !== undefined) { sets.push("branch = ?"); values.push(updates.branch) }
    if (updates.planModel !== undefined) { sets.push("plan_model = ?"); values.push(updates.planModel) }
    if (updates.executionModel !== undefined) { sets.push("execution_model = ?"); values.push(updates.executionModel) }
    if (updates.planmode !== undefined) { sets.push("planmode = ?"); values.push(updates.planmode ? 1 : 0) }
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

    if (sets.length === 0) return this.getTask(id)

    sets.push("updated_at = unixepoch()")
    values.push(id)

    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values)
    return this.getTask(id)
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

  getOptions(): Options {
    const rows = this.db.query("SELECT key, value FROM options").all() as any[]
    const opts: Record<string, string> = {}
    for (const row of rows) opts[row.key] = row.value

    return {
      commitPrompt: opts.commit_prompt ?? DEFAULT_OPTIONS.commitPrompt,
      branch: opts.branch ?? DEFAULT_OPTIONS.branch,
      planModel: opts.plan_model ?? DEFAULT_OPTIONS.planModel,
      executionModel: opts.execution_model ?? DEFAULT_OPTIONS.executionModel,
      reviewModel: opts.review_model ?? DEFAULT_OPTIONS.reviewModel,
      command: opts.command ?? DEFAULT_OPTIONS.command,
      parallelTasks: parseInt(opts.parallel_tasks ?? "1", 10) || 1,
      port: parseInt(opts.port ?? "3789", 10) || 3789,
      thinkingLevel: normalizeThinkingLevel(opts.thinking_level) ?? DEFAULT_OPTIONS.thinkingLevel,
    }
  }

  updateOptions(partial: Partial<Options>): Options {
    const upsert = this.db.prepare(
      "INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )

    if (partial.commitPrompt !== undefined) upsert.run("commit_prompt", partial.commitPrompt)
    if (partial.branch !== undefined) upsert.run("branch", partial.branch)
    if (partial.planModel !== undefined) upsert.run("plan_model", partial.planModel)
    if (partial.executionModel !== undefined) upsert.run("execution_model", partial.executionModel)
    if (partial.reviewModel !== undefined) upsert.run("review_model", partial.reviewModel)
    if (partial.command !== undefined) upsert.run("command", partial.command)
    if (partial.parallelTasks !== undefined) upsert.run("parallel_tasks", String(partial.parallelTasks))
    if (partial.port !== undefined) upsert.run("port", String(partial.port))
    if (partial.thinkingLevel !== undefined) upsert.run("thinking_level", partial.thinkingLevel)

    return this.getOptions()
  }

  resetTasksForBacklog(): void {
    const tasksToReset = this.db.query("SELECT id FROM tasks WHERE status IN ('executing', 'review', 'failed', 'stuck')").all() as any[]
    for (const task of tasksToReset) {
      this.db.prepare("DELETE FROM task_candidates WHERE task_id = ?").run(task.id)
      this.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(task.id)
    }
    this.db.prepare(
      "UPDATE tasks SET status = 'backlog', session_id = NULL, session_url = NULL, worktree_dir = NULL, agent_output = '', review_count = 0, error_message = NULL, completed_at = NULL, updated_at = unixepoch(), execution_phase = 'not_started', awaiting_plan_approval = 0, plan_revision_count = 0, best_of_n_substage = 'idle' WHERE status IN ('executing', 'review', 'failed', 'stuck')"
    ).run()
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
