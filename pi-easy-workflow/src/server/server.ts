import { randomUUID } from "crypto"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { buildExecutionGraph, getExecutableTasks, resolveDependencyChain } from "../execution-plan.ts"
import { discoverPiModels } from "../pi/model-discovery.ts"
import { chooseDeterministicRepairAction, hasCapturedPlanOutput, isTaskAwaitingPlanApproval } from "../task-state.ts"
import type { BestOfNConfig, Task, TaskRun, ThinkingLevel, WSMessage } from "../types.ts"
import { PiKanbanDB } from "../db.ts"
import { Router } from "./router.ts"
import type { RequestContext } from "./types.ts"
import { WebSocketHub } from "./websocket.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const KANBAN_HTML = readFileSync(join(__dirname, "..", "kanban", "index.html"), "utf-8")

const TASK_BOOLEAN_FIELDS = ["planmode", "autoApprovePlan", "review", "autoCommit", "deleteWorktree", "skipPermissionAsking"] as const

type RunControlFn = (runId: string) => Promise<any>
type StartFn = () => Promise<any>
type StartSingleFn = (taskId: string) => Promise<any>
type StopFn = () => Promise<any>

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "default" || value === "low" || value === "medium" || value === "high"
}

function isExecutionStrategy(value: unknown): value is "standard" | "best_of_n" {
  return value === "standard" || value === "best_of_n"
}

function isSelectionMode(value: unknown): value is "pick_best" | "synthesize" | "pick_or_synthesize" {
  return value === "pick_best" || value === "synthesize" || value === "pick_or_synthesize"
}

function validateBestOfNConfig(config: unknown): { valid: boolean; error?: string } {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "bestOfNConfig must be an object" }
  }

  const cfg = config as any
  if (!Array.isArray(cfg.workers) || cfg.workers.length === 0) {
    return { valid: false, error: "At least one worker slot is required" }
  }

  for (let i = 0; i < cfg.workers.length; i++) {
    const slot = cfg.workers[i]
    if (!slot.model || typeof slot.model !== "string") return { valid: false, error: `Worker slot ${i + 1}: model is required` }
    if (typeof slot.count !== "number" || slot.count < 1) return { valid: false, error: `Worker slot ${i + 1}: count must be at least 1` }
  }

  if (!Array.isArray(cfg.reviewers)) return { valid: false, error: "Reviewers must be an array" }
  for (let i = 0; i < cfg.reviewers.length; i++) {
    const slot = cfg.reviewers[i]
    if (!slot.model || typeof slot.model !== "string") return { valid: false, error: `Reviewer slot ${i + 1}: model is required` }
    if (typeof slot.count !== "number" || slot.count < 1) return { valid: false, error: `Reviewer slot ${i + 1}: count must be at least 1` }
  }

  if (!cfg.finalApplier || typeof cfg.finalApplier !== "object" || typeof cfg.finalApplier.model !== "string") {
    return { valid: false, error: "Final applier model is required" }
  }

  if (cfg.selectionMode && !isSelectionMode(cfg.selectionMode)) {
    return { valid: false, error: "selectionMode must be pick_best, synthesize, or pick_or_synthesize" }
  }

  const totalWorkers = cfg.workers.reduce((sum: number, slot: any) => sum + Number(slot.count || 0), 0)
  if (typeof cfg.minSuccessfulWorkers !== "number" || cfg.minSuccessfulWorkers < 1 || cfg.minSuccessfulWorkers > totalWorkers) {
    return { valid: false, error: "minSuccessfulWorkers must be between 1 and total worker count" }
  }

  return { valid: true }
}

function getInvalidTaskBooleanField(body: any): string | null {
  for (const field of TASK_BOOLEAN_FIELDS) {
    if (body?.[field] !== undefined && !isBoolean(body[field])) return field
  }
  return null
}

function normalizeTaskForClient(task: Task, sessionUrlFor: (sessionId: string) => string): Task {
  if (!task.sessionId) return task
  if (!task.sessionUrl || task.sessionUrl.includes("opencode") || !task.sessionUrl.includes("#session/")) {
    return { ...task, sessionUrl: sessionUrlFor(task.sessionId) }
  }
  return task
}

function normalizeTaskRunForClient(run: TaskRun, sessionUrlFor: (sessionId: string) => string): TaskRun {
  if (!run.sessionId) return run
  if (!run.sessionUrl || run.sessionUrl.includes("opencode") || !run.sessionUrl.includes("#session/")) {
    return { ...run, sessionUrl: sessionUrlFor(run.sessionId) }
  }
  return run
}

export class PiKanbanServer {
  private readonly db: PiKanbanDB
  private readonly router = new Router()
  private readonly wsHub = new WebSocketHub()
  private server: Bun.Server<unknown> | null = null
  private readonly onStart: StartFn
  private readonly onStartSingle: StartSingleFn
  private readonly onStop: StopFn
  private readonly onPauseRun: RunControlFn | null
  private readonly onResumeRun: RunControlFn | null
  private readonly onStopRun: RunControlFn | null
  private readonly defaultPort: number

  constructor(
    db: PiKanbanDB,
    opts: {
      port?: number
      onStart?: StartFn
      onStartSingle?: StartSingleFn
      onStop?: StopFn
      onPauseRun?: RunControlFn
      onResumeRun?: RunControlFn
      onStopRun?: RunControlFn
    } = {},
  ) {
    this.db = db
    this.defaultPort = opts.port ?? this.db.getOptions().port
    this.onStart = opts.onStart ?? (async () => null)
    this.onStartSingle = opts.onStartSingle ?? (async () => null)
    this.onStop = opts.onStop ?? (async () => null)
    this.onPauseRun = opts.onPauseRun ?? null
    this.onResumeRun = opts.onResumeRun ?? null
    this.onStopRun = opts.onStopRun ?? null

    this.registerRoutes()
  }

  private withCors(response: Response): Response {
    const headers = new Headers(response.headers)
    headers.set("Access-Control-Allow-Origin", "*")
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
    headers.set("Access-Control-Allow-Headers", "Content-Type")
    return new Response(response.body, { status: response.status, headers })
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
  }

  private text(data: string, status = 200): Response {
    return new Response(data, { status, headers: { "Content-Type": "text/plain" } })
  }

  private sessionUrlFor(sessionId: string): string {
    return `/#session/${encodeURIComponent(sessionId)}`
  }

  private baseContext(req: Request): Omit<RequestContext, "params"> {
    const url = new URL(req.url)
    return {
      req,
      url,
      db: this.db,
      json: (data, status = 200) => this.json(data, status),
      text: (data, status = 200) => this.text(data, status),
      broadcast: (message) => this.broadcast(message),
      sessionUrlFor: (sessionId) => this.sessionUrlFor(sessionId),
    }
  }

  broadcast(message: WSMessage): void {
    this.wsHub.broadcast(message)
  }

  async start(port = this.defaultPort): Promise<number> {
    if (this.server) return this.server.port

    this.server = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: async (req, server) => {
        const url = new URL(req.url)

        if (req.method === "OPTIONS") {
          return this.withCors(this.text("", 204))
        }

        if (url.pathname === "/ws") {
          if (server.upgrade(req)) return undefined
          return this.withCors(this.text("Upgrade failed", 500))
        }

        try {
          const handled = await this.router.dispatch(req.method, url.pathname, this.baseContext(req))
          if (handled) return this.withCors(handled)
          return this.withCors(this.json({ error: "Not found" }, 404))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return this.withCors(this.json({ error: message }, 500))
        }
      },
      websocket: {
        open: (ws) => this.wsHub.addClient(ws),
        close: (ws) => this.wsHub.removeClient(ws),
        message: () => {},
      },
    })

    return this.server.port
  }

  stop(): void {
    this.server?.stop()
    this.server = null
  }

  private registerRoutes(): void {
    this.router.get("/", () => new Response(KANBAN_HTML, { headers: { "Content-Type": "text/html" } }))
    this.router.get("/healthz", ({ json }) => json({ ok: true, wsClients: this.wsHub.size() }))

    this.router.get("/api/tasks", ({ json, sessionUrlFor }) => {
      const tasks = this.db.getTasks().map((task) => normalizeTaskForClient(task, sessionUrlFor))
      return json(tasks)
    })

    this.router.post("/api/tasks", async ({ req, json, sessionUrlFor, broadcast }) => {
      const body = await req.json()
      const invalidBooleanField = getInvalidTaskBooleanField(body)
      if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
        return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
      }
      if (body?.executionStrategy === "best_of_n") {
        const valid = validateBestOfNConfig(body.bestOfNConfig)
        if (!valid.valid) return json({ error: valid.error }, 400)
      }

      const task = this.db.createTask({
        id: randomUUID().slice(0, 8),
        name: String(body.name ?? "").trim(),
        prompt: String(body.prompt ?? ""),
        status: body.status ?? "backlog",
        branch: body.branch,
        planModel: body.planModel,
        executionModel: body.executionModel,
        planmode: body.planmode,
        autoApprovePlan: body.autoApprovePlan,
        review: body.review,
        autoCommit: body.autoCommit,
        deleteWorktree: body.deleteWorktree,
        requirements: Array.isArray(body.requirements) ? body.requirements : [],
        thinkingLevel: body.thinkingLevel,
        executionStrategy: body.executionStrategy,
        bestOfNConfig: body.bestOfNConfig,
        bestOfNSubstage: body.bestOfNSubstage,
        skipPermissionAsking: body.skipPermissionAsking,
      })

      const normalized = normalizeTaskForClient(task, sessionUrlFor)
      broadcast({ type: "task_created", payload: normalized })
      return json(normalized, 201)
    })

    this.router.put("/api/tasks/reorder", async ({ req, json, broadcast }) => {
      const body = await req.json()
      if (!body?.id || typeof body.newIdx !== "number") return json({ error: "id and newIdx are required" }, 400)
      this.db.reorderTask(String(body.id), Number(body.newIdx))
      broadcast({ type: "task_reordered", payload: {} })
      return json({ ok: true })
    })

    this.router.delete("/api/tasks/done/all", ({ json, broadcast }) => {
      const doneTasks = this.db.getTasksByStatus("done")
      let archived = 0
      let deleted = 0

      for (const task of doneTasks) {
        if (this.db.hasTaskExecutionHistory(task.id)) {
          this.db.archiveTask(task.id)
          broadcast({ type: "task_archived", payload: { id: task.id } })
          archived++
        } else {
          this.db.hardDeleteTask(task.id)
          broadcast({ type: "task_deleted", payload: { id: task.id } })
          deleted++
        }
      }

      return json({ archived, deleted })
    })

    this.router.get("/api/tasks/:id", ({ params, json, sessionUrlFor }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      return json(normalizeTaskForClient(task, sessionUrlFor))
    })

    this.router.patch("/api/tasks/:id", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const existing = this.db.getTask(params.id)
      if (!existing) return json({ error: "Task not found" }, 404)

      const activeRun = this.db.getActiveWorkflowRunForTask(params.id)
      if (activeRun) {
        return json({ error: `Cannot modify task \"${existing.name}\" while it is executing in run ${activeRun.id}.` }, 409)
      }

      const body = await req.json()
      const invalidBooleanField = getInvalidTaskBooleanField(body)
      if (invalidBooleanField) return json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
        return json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
      }
      if (body?.executionStrategy === "best_of_n" || (body?.bestOfNConfig && existing.executionStrategy === "best_of_n")) {
        const validation = validateBestOfNConfig(body.bestOfNConfig ?? existing.bestOfNConfig)
        if (!validation.valid) return json({ error: validation.error }, 400)
      }

      if (body?.status === "backlog" && body?.executionPhase === undefined) {
        body.executionPhase = "not_started"
        body.awaitingPlanApproval = false
      }
      if (body?.status === "backlog" && body?.bestOfNSubstage === undefined) {
        body.bestOfNSubstage = "idle"
      }

      const task = this.db.updateTask(params.id, body)
      if (!task) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(task, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    })

    this.router.delete("/api/tasks/:id", ({ params, json, broadcast }) => {
      const existing = this.db.getTask(params.id)
      if (!existing) return json({ error: "Task not found" }, 404)

      const activeRun = this.db.getActiveWorkflowRunForTask(params.id)
      if (activeRun) {
        return json({ error: `Cannot modify task \"${existing.name}\" while it is executing in run ${activeRun.id}.` }, 409)
      }

      if (this.db.hasTaskExecutionHistory(params.id)) {
        this.db.archiveTask(params.id)
        broadcast({ type: "task_archived", payload: { id: params.id } })
        return json({ id: params.id, archived: true })
      }

      this.db.hardDeleteTask(params.id)
      broadcast({ type: "task_deleted", payload: { id: params.id } })
      return new Response(null, { status: 204 })
    })

    this.router.get("/api/options", ({ json }) => json(this.db.getOptions()))

    this.router.put("/api/options", async ({ req, json, broadcast }) => {
      const body = await req.json()
      if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
        return json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
      }
      const options = this.db.updateOptions(body)
      broadcast({ type: "options_updated", payload: options })
      return json(options)
    })

    this.router.get("/api/branches", ({ json }) => {
      try {
        const branchOutput = Bun.spawnSync({ cmd: ["git", "branch", "--format=%(refname:short)"], stdout: "pipe", stderr: "pipe" })
        const currentOutput = Bun.spawnSync({ cmd: ["git", "branch", "--show-current"], stdout: "pipe", stderr: "pipe" })
        if (branchOutput.exitCode !== 0 || currentOutput.exitCode !== 0) {
          return json({ branches: [], current: null, error: "Failed to list git branches" })
        }
        const branches = new TextDecoder().decode(branchOutput.stdout).split("\n").map((line) => line.trim()).filter(Boolean)
        const current = new TextDecoder().decode(currentOutput.stdout).trim() || null
        if (current && !branches.includes(current)) branches.unshift(current)
        return json({ branches, current })
      } catch (error) {
        return json({ branches: [], current: null, error: error instanceof Error ? error.message : String(error) })
      }
    })

    this.router.get("/api/models", async ({ json }) => {
      const catalog = await discoverPiModels({ maxRetries: 1, commandTimeoutMs: 500 })
      return json(catalog)
    })

    this.router.get("/api/runs", ({ json }) => json(this.db.getWorkflowRuns()))

    this.router.post("/api/start", async ({ json, broadcast }) => {
      const run = await this.onStart()
      return json(run)
    })

    this.router.post("/api/execution/start", async ({ json }) => {
      const run = await this.onStart()
      return json(run)
    })

    this.router.post("/api/stop", async ({ json, broadcast }) => {
      const result = await this.onStop()
      return json(result ?? { ok: true })
    })

    this.router.post("/api/execution/stop", async ({ json }) => {
      const result = await this.onStop()
      return json(result ?? { ok: true })
    })

    this.router.post("/api/execution/pause", async ({ json }) => {
      const active = this.db.getWorkflowRuns().find((run) => run.status === "running")
      if (!active) return json({ error: "No running workflow run" }, 404)
      const updated = this.db.updateWorkflowRun(active.id, {
        pauseRequested: true,
        status: "paused",
      })
      if (updated) this.broadcast({ type: "run_updated", payload: updated })
      return json(updated ?? { error: "Run not found" }, updated ? 200 : 404)
    })

    this.router.post("/api/tasks/:id/start", async ({ params, json, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      const run = await this.onStartSingle(params.id)
      return json(run)
    })

    this.router.post("/api/runs/:id/pause", async ({ params, json, broadcast }) => {
      if (this.onPauseRun) {
        const response = await this.onPauseRun(params.id)
        if (response) return json(response)
      }
      const updated = this.db.updateWorkflowRun(params.id, { pauseRequested: true, status: "paused" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      return json(updated)
    })

    this.router.post("/api/runs/:id/resume", async ({ params, json, broadcast }) => {
      if (this.onResumeRun) {
        const response = await this.onResumeRun(params.id)
        if (response) return json(response)
      }
      const updated = this.db.updateWorkflowRun(params.id, { pauseRequested: false, status: "running" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      return json(updated)
    })

    this.router.post("/api/runs/:id/stop", async ({ params, json, broadcast }) => {
      if (this.onStopRun) {
        const response = await this.onStopRun(params.id)
        if (response) return json(response)
      }
      const updated = this.db.updateWorkflowRun(params.id, { stopRequested: true, status: "stopping" })
      if (!updated) return json({ error: "Run not found" }, 404)
      broadcast({ type: "run_updated", payload: updated })
      return json(updated)
    })

    this.router.get("/api/execution-graph", ({ json }) => {
      const executable = getExecutableTasks(this.db.getTasks())
      if (executable.length === 0) return json({ error: "No tasks in backlog" }, 400)

      const options = this.db.getOptions()
      const graph = buildExecutionGraph(this.db.getTasks(), options.parallelTasks)

      for (const node of graph.nodes) {
        const task = this.db.getTask(node.id)
        if (task?.executionStrategy === "best_of_n" && task.bestOfNConfig) {
          const cfg = task.bestOfNConfig as BestOfNConfig
          const workers = cfg.workers.reduce((sum, slot) => sum + slot.count, 0)
          const reviewers = cfg.reviewers.reduce((sum, slot) => sum + slot.count, 0)
          node.expandedWorkerRuns = workers
          node.expandedReviewerRuns = reviewers
          node.hasFinalApplier = true
          node.estimatedRunCount = workers + reviewers + 1
        } else {
          node.expandedWorkerRuns = 1
          node.expandedReviewerRuns = task?.review ? 1 : 0
          node.hasFinalApplier = false
          node.estimatedRunCount = 1 + (task?.review ? 1 : 0)
        }
      }

      graph.pendingApprovals = this.db.getTasks().filter((task) => isTaskAwaitingPlanApproval(task)).map((task) => ({
        id: task.id,
        name: task.name,
        status: task.status,
        awaitingPlanApproval: task.awaitingPlanApproval,
        planRevisionCount: task.planRevisionCount,
      }))

      return json(graph)
    })

    this.router.get("/api/tasks/:id/runs", ({ params, json, sessionUrlFor }) => {
      if (!this.db.getTask(params.id)) return json({ error: "Task not found" }, 404)
      return json(this.db.getTaskRuns(params.id).map((run) => normalizeTaskRunForClient(run, sessionUrlFor)))
    })

    this.router.get("/api/tasks/:id/candidates", ({ params, json }) => {
      if (!this.db.getTask(params.id)) return json({ error: "Task not found" }, 404)
      return json(this.db.getTaskCandidates(params.id))
    })

    this.router.get("/api/tasks/:id/best-of-n-summary", ({ params, json }) => {
      try {
        return json(this.db.getBestOfNSummary(params.id))
      } catch {
        return json({ error: "Task not found" }, 404)
      }
    })

    this.router.get("/api/tasks/:id/review-status", ({ params, json }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      const options = this.db.getOptions()
      return json({
        taskId: task.id,
        reviewCount: task.reviewCount,
        maxReviewRuns: options.maxReviews,
        maxReviewRunsOverride: task.maxReviewRunsOverride,
      })
    })

    this.router.post("/api/tasks/:id/approve-plan", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.planmode) return json({ error: "Task is not in plan mode" }, 400)
      const body = await req.json().catch(() => ({}))

      const updated = this.db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "implementation_pending",
        errorMessage: null,
        ...(typeof body?.approvalNote === "string" && body.approvalNote.trim().length > 0
          ? { agentOutput: `${task.agentOutput}\n[user-approval-note]\n${body.approvalNote.trim()}\n` }
          : typeof body?.message === "string" && body.message.trim().length > 0
            ? { agentOutput: `${task.agentOutput}\n[user-approval-note]\n${body.message.trim()}\n` }
          : {}),
      })

      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    })

    this.router.post("/api/tasks/:id/request-plan-revision", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.planmode) return json({ error: "Task is not in plan mode" }, 400)
      const body = await req.json()
      if (typeof body?.feedback !== "string" || !body.feedback.trim()) {
        return json({ error: "feedback is required" }, 400)
      }

      const updated = this.db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "plan_revision_pending",
        planRevisionCount: (task.planRevisionCount ?? 0) + 1,
        agentOutput: `${task.agentOutput}\n[user-revision-request]\n${body.feedback.trim()}\n`,
      })

      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      broadcast({ type: "plan_revision_requested", payload: { taskId: task.id } })
      const run = await this.onStartSingle(task.id).catch(() => null)
      return json({ task: normalized, run })
    })

    this.router.post("/api/tasks/:id/request-revision", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)
      if (!task.planmode) return json({ error: "Task is not in plan mode" }, 400)
      const body = await req.json()
      if (typeof body?.feedback !== "string" || !body.feedback.trim()) {
        return json({ error: "feedback is required" }, 400)
      }

      const updated = this.db.updateTask(task.id, {
        status: "backlog",
        awaitingPlanApproval: false,
        executionPhase: "plan_revision_pending",
        planRevisionCount: (task.planRevisionCount ?? 0) + 1,
        agentOutput: `${task.agentOutput}\n[user-revision-request]\n${body.feedback.trim()}\n`,
      })

      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      broadcast({ type: "plan_revision_requested", payload: { taskId: task.id } })
      const run = await this.onStartSingle(task.id).catch(() => null)
      return json({ task: normalized, run })
    })

    this.router.post("/api/tasks/:id/reset", async ({ params, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      const reset = this.db.updateTask(task.id, {
        status: "backlog",
        reviewCount: 0,
        errorMessage: null,
        completedAt: null,
        sessionId: null,
        sessionUrl: null,
        worktreeDir: null,
        executionPhase: "not_started",
        awaitingPlanApproval: false,
        planRevisionCount: 0,
      })

      if (!reset) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(reset, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json(normalized)
    })

    this.router.post("/api/tasks/:id/repair-state", async ({ params, req, json, sessionUrlFor, broadcast }) => {
      const task = this.db.getTask(params.id)
      if (!task) return json({ error: "Task not found" }, 404)

      const body = await req.json().catch(() => ({}))
      const requestedAction = typeof body?.action === "string" ? body.action : "smart"
      const action = requestedAction === "smart" ? chooseDeterministicRepairAction(task).action : requestedAction

      let update: Record<string, unknown> = {}
      let reason = ""

      if (action === "queue_implementation") {
        if (!hasCapturedPlanOutput(task.agentOutput)) return json({ error: "No captured [plan] block exists" }, 400)
        update = { status: "backlog", awaitingPlanApproval: false, executionPhase: "implementation_pending", errorMessage: null }
        reason = "Queued implementation from repair"
      } else if (action === "restore_plan_approval") {
        if (!hasCapturedPlanOutput(task.agentOutput)) return json({ error: "No captured [plan] block exists" }, 400)
        update = { status: "review", awaitingPlanApproval: true, executionPhase: "plan_complete_waiting_approval", errorMessage: null }
        reason = "Restored plan approval"
      } else if (action === "mark_done") {
        update = { status: "done", completedAt: Math.floor(Date.now() / 1000), awaitingPlanApproval: false, errorMessage: null }
        reason = "Marked done via repair"
      } else if (action === "fail_task") {
        update = { status: "failed", awaitingPlanApproval: false, errorMessage: body?.errorMessage ?? "Marked failed via repair" }
        reason = "Marked failed via repair"
      } else if (action === "continue_with_more_reviews") {
        const additional = Number(body?.additionalReviewCount ?? 1)
        const currentMax = task.maxReviewRunsOverride ?? this.db.getOptions().maxReviews
        update = {
          status: "backlog",
          errorMessage: null,
          maxReviewRunsOverride: currentMax + Math.max(1, additional),
          ...(typeof body?.smartRepairHints === "string" && body.smartRepairHints.trim() ? { smartRepairHints: body.smartRepairHints.trim() } : {}),
        }
        reason = "Increased review allowance and resumed"
      } else {
        update = {
          status: "backlog",
          reviewCount: 0,
          agentOutput: "",
          errorMessage: null,
          completedAt: null,
          sessionId: null,
          sessionUrl: null,
          worktreeDir: null,
          executionPhase: "not_started",
          awaitingPlanApproval: false,
          planRevisionCount: 0,
          bestOfNSubstage: "idle",
        }
        reason = "Reset to backlog via repair"
      }

      const updated = this.db.updateTask(task.id, update)
      if (!updated) return json({ error: "Task not found" }, 404)
      const normalized = normalizeTaskForClient(updated, sessionUrlFor)
      broadcast({ type: "task_updated", payload: normalized })
      return json({ ok: true, action, reason, task: normalized })
    })

    this.router.get("/api/sessions/:id", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      return json(session)
    })

    this.router.get("/api/sessions/:id/messages", ({ params, url, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      return json(this.db.getSessionMessages(params.id, { limit, offset }))
    })

    this.router.get("/api/sessions/:id/timeline", ({ params, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)
      return json(this.db.getSessionTimelineEntries(params.id))
    })

    this.router.get("/api/sessions/:id/io", ({ params, url, json }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)

      const limit = Number(url.searchParams.get("limit") ?? 500)
      const offset = Number(url.searchParams.get("offset") ?? 0)
      const recordType = url.searchParams.get("recordType") as any
      return json(this.db.getSessionIO(params.id, { limit, offset, ...(recordType ? { recordType } : {}) }))
    })

    this.router.get("/api/tasks/:id/messages", ({ params, json }) => json(this.db.getSessionMessageViewsByTask(params.id)))
    this.router.get("/api/task-runs/:id/messages", ({ params, json }) => json(this.db.getSessionMessageViewsByTaskRun(params.id)))

    this.router.post("/api/pi/sessions/:id/events", async ({ params, req, json, broadcast }) => {
      const session = this.db.getWorkflowSession(params.id)
      if (!session) return json({ error: "Session not found" }, 404)

      const body = await req.json()
      const eventType = String(body?.type ?? "")

      if (eventType === "start") {
        const updated = this.db.updateWorkflowSession(session.id, {
          status: "active",
          processPid: typeof body?.processPid === "number" ? body.processPid : session.processPid,
          piSessionId: typeof body?.piSessionId === "string" ? body.piSessionId : session.piSessionId,
          piSessionFile: typeof body?.piSessionFile === "string" ? body.piSessionFile : session.piSessionFile,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "lifecycle",
          payloadJson: { type: "session_started", ...body },
        })
        if (updated?.taskId) {
          this.db.updateTask(updated.taskId, {
            sessionId: updated.id,
            sessionUrl: this.sessionUrlFor(updated.id),
          })
        }
        broadcast({ type: "session_started", payload: updated ?? session })
        return json({ ok: true })
      }

      if (eventType === "message") {
        const message = this.db.createSessionMessage({
          sessionId: session.id,
          taskId: session.taskId,
          taskRunId: session.taskRunId,
          role: body?.role ?? "assistant",
          messageType: body?.messageType ?? "text",
          contentJson: body?.contentJson ?? { text: String(body?.text ?? "") },
          modelProvider: body?.modelProvider ?? null,
          modelId: body?.modelId ?? null,
          agentName: body?.agentName ?? null,
          rawEventJson: body,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "stdout",
          recordType: "rpc_event",
          payloadJson: body,
          payloadText: typeof body?.text === "string" ? body.text : null,
        })
        broadcast({ type: "session_message_created", payload: message })
        return json({ ok: true, message })
      }

      if (eventType === "status") {
        const updated = this.db.updateWorkflowSession(session.id, {
          status: body?.status ?? session.status,
          errorMessage: body?.errorMessage ?? session.errorMessage,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "lifecycle",
          payloadJson: { type: "session_status", ...body },
        })
        broadcast({ type: "session_status_changed", payload: updated ?? session })
        return json({ ok: true })
      }

      if (eventType === "complete") {
        const updated = this.db.updateWorkflowSession(session.id, {
          status: body?.status ?? "completed",
          finishedAt: Math.floor(Date.now() / 1000),
          exitCode: body?.exitCode ?? null,
          exitSignal: body?.exitSignal ?? null,
          errorMessage: body?.errorMessage ?? null,
        })
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "lifecycle",
          payloadJson: { type: "session_completed", ...body },
        })
        broadcast({ type: "session_completed", payload: updated ?? session })
        return json({ ok: true })
      }

      return json({ error: "Unsupported event type" }, 400)
    })
  }
}
