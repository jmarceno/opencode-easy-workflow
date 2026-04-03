import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import { execFileSync } from "child_process"
import type { WSMessage, ThinkingLevel, ExecutionStrategy, BestOfNConfig, SelectionMode } from "./types"
import { KanbanDB } from "./db"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { buildExecutionGraph } from "./execution-plan"

const MAX_EXPANDED_WORKER_RUNS = 8
const MAX_EXPANDED_REVIEWER_RUNS = 4
const MAX_TOTAL_INTERNAL_RUNS = 12

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_ROOT = join(__dirname, "..")
const KANBAN_HTML = readFileSync(join(__dirname, "kanban", "index.html"), "utf-8")
const REVIEW_AGENT_PATH = join(WORKFLOW_ROOT, "agents", "workflow-review.md")

type StartFn = () => Promise<void>
type StartSingleFn = (taskId: string) => Promise<void>
type StopFn = () => void
type StartPreflightFn = (taskId?: string) => string | null
type ServerUrlFn = () => string | null

function createV2Client(baseUrl: string, directory?: string) {
  return createOpencodeClient({
    baseUrl,
    directory,
    throwOnError: true,
  })
}

const THINKING_LEVELS: ThinkingLevel[] = ["default", "low", "medium", "high"]

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)
}

function isExecutionStrategy(value: unknown): value is ExecutionStrategy {
  return value === "standard" || value === "best_of_n"
}

function isSelectionMode(value: unknown): value is SelectionMode {
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
    if (!slot.model || typeof slot.model !== "string") {
      return { valid: false, error: `Worker slot ${i + 1}: model is required` }
    }
    if (typeof slot.count !== "number" || slot.count < 1) {
      return { valid: false, error: `Worker slot ${i + 1}: count must be at least 1` }
    }
  }

  if (!Array.isArray(cfg.reviewers)) {
    return { valid: false, error: "Reviewers must be an array" }
  }

  for (let i = 0; i < cfg.reviewers.length; i++) {
    const slot = cfg.reviewers[i]
    if (!slot.model || typeof slot.model !== "string") {
      return { valid: false, error: `Reviewer slot ${i + 1}: model is required` }
    }
    if (typeof slot.count !== "number" || slot.count < 1) {
      return { valid: false, error: `Reviewer slot ${i + 1}: count must be at least 1` }
    }
  }

  if (!cfg.finalApplier || typeof cfg.finalApplier !== "object") {
    return { valid: false, error: "Final applier is required" }
  }

  if (!cfg.finalApplier.model || typeof cfg.finalApplier.model !== "string") {
    return { valid: false, error: "Final applier model is required" }
  }

  if (cfg.selectionMode && !isSelectionMode(cfg.selectionMode)) {
    return { valid: false, error: "selectionMode must be pick_best, synthesize, or pick_or_synthesize" }
  }

  if (typeof cfg.minSuccessfulWorkers !== "number" || cfg.minSuccessfulWorkers < 1) {
    return { valid: false, error: "minSuccessfulWorkers must be at least 1" }
  }

  const totalWorkers = cfg.workers.reduce((sum: number, s: any) => sum + s.count, 0)
  if (cfg.minSuccessfulWorkers > totalWorkers) {
    return { valid: false, error: "minSuccessfulWorkers cannot exceed total worker count" }
  }

  const totalReviewers = cfg.reviewers.reduce((sum: number, s: any) => sum + s.count, 0)
  const totalRuns = totalWorkers + totalReviewers + 1

  if (totalWorkers > MAX_EXPANDED_WORKER_RUNS) {
    return { valid: false, error: `Total worker runs (${totalWorkers}) exceeds maximum of ${MAX_EXPANDED_WORKER_RUNS}` }
  }

  if (totalReviewers > MAX_EXPANDED_REVIEWER_RUNS) {
    return { valid: false, error: `Total reviewer runs (${totalReviewers}) exceeds maximum of ${MAX_EXPANDED_REVIEWER_RUNS}` }
  }

  if (totalRuns > MAX_TOTAL_INTERNAL_RUNS) {
    return { valid: false, error: `Total internal runs (${totalRuns}) exceeds maximum of ${MAX_TOTAL_INTERNAL_RUNS}` }
  }

  return { valid: true }
}

function expandWorkerSlots(workers: BestOfNConfig["workers"]): { model: string; taskSuffix?: string }[] {
  const expanded: { model: string; taskSuffix?: string }[] = []
  for (const slot of workers) {
    for (let i = 0; i < slot.count; i++) {
      expanded.push({ model: slot.model, taskSuffix: slot.taskSuffix })
    }
  }
  return expanded
}

function expandReviewerSlots(reviewers: BestOfNConfig["reviewers"]): { model: string; taskSuffix?: string }[] {
  const expanded: { model: string; taskSuffix?: string }[] = []
  for (const slot of reviewers) {
    for (let i = 0; i < slot.count; i++) {
      expanded.push({ model: slot.model, taskSuffix: slot.taskSuffix })
    }
  }
  return expanded
}

function normalizeDefaultModelMap(catalog: any): Record<string, string> {
  const defaults: Record<string, string> = {}
  const source = catalog?.defaultModel ?? catalog?.defaults ?? catalog?.defaultModels ?? null
  if (!source || typeof source !== "object") return defaults

  for (const [providerID, modelID] of Object.entries(source)) {
    if (typeof providerID !== "string") continue
    if (typeof modelID !== "string" || !modelID.trim()) continue
    defaults[providerID] = `${providerID}/${modelID}`
  }

  return defaults
}

function parseModelSelection(value: string): { providerID: string; modelID: string } | null {
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null
  const providerID = trimmed.slice(0, separatorIndex).trim()
  const modelID = trimmed.slice(separatorIndex + 1).trim()
  return providerID && modelID ? { providerID, modelID } : null
}

function resolveCatalogModel(rawModel: string, catalog: any, context: string): string {
  const parsed = parseModelSelection(rawModel)
  if (!parsed) {
    throw new Error(`${context} model is invalid: ${rawModel}. Expected format provider/model.`)
  }

  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  const provider = providers.find((p: any) => typeof p?.id === "string" && p.id.toLowerCase() === parsed.providerID.toLowerCase())
  if (!provider) {
    const availableProviders = providers.map((p: any) => p?.id).filter(Boolean).join(", ") || "none"
    throw new Error(`${context} model provider not found: ${parsed.providerID}. Available providers: ${availableProviders}`)
  }

  const modelIds = Object.keys(provider.models || {})
  const exact = modelIds.find((m) => m === parsed.modelID)
  const insensitive = exact ?? modelIds.find((m) => m.toLowerCase() === parsed.modelID.toLowerCase())
  if (!insensitive) {
    const suggestions = modelIds.slice(0, 8).join(", ") || "none"
    throw new Error(`${context} model not found: ${provider.id}/${parsed.modelID}. Available models: ${suggestions}`)
  }

  return `${provider.id}/${insensitive}`
}

function hasExecutableTasks(db: KanbanDB): boolean {
  return db.getTasks().some((task) => {
    const isBacklogTask = task.status === "backlog" && task.executionPhase !== "plan_complete_waiting_approval"
    const isApprovedPlanTask = task.executionPhase === "implementation_pending"
    return isBacklogTask || isApprovedPlanTask
  })
}

function getExecutionMutationError(): string {
  return "Cannot modify workflow tasks while execution is running. Stop execution first."
}

export class KanbanServer {
  private db: KanbanDB
  private clients: Set<any> = new Set()
  private server: ReturnType<typeof Bun.serve> | null = null
  private onStart: StartFn
  private onStartSingle: StartSingleFn
  private onStop: StopFn
  private getExecuting: () => boolean
  private getStartError: StartPreflightFn
  private getServerUrl: ServerUrlFn

  constructor(
    db: KanbanDB,
    opts: { onStart: StartFn; onStartSingle: StartSingleFn; onStop: StopFn; getExecuting: () => boolean; getStartError?: StartPreflightFn; getServerUrl?: ServerUrlFn }
  ) {
    this.db = db
    this.onStart = opts.onStart
    this.onStartSingle = opts.onStartSingle
    this.onStop = opts.onStop
    this.getExecuting = opts.getExecuting
    this.getStartError = opts.getStartError || (() => null)
    this.getServerUrl = opts.getServerUrl || (() => null)
  }

  broadcast(msg: WSMessage) {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      try {
        ws.send(data)
      } catch (sendErr) {
        void sendErr
        this.clients.delete(ws)
      }
    }
  }

  private reportExecutionStartFailure(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.broadcast({ type: "error", payload: { message: `Execution failed: ${msg}` } })
    this.broadcast({ type: "execution_stopped", payload: {} })
  }

  private classifyStartError(message: string): number {
    const normalized = message.toLowerCase()
    if (normalized.includes("task not found") || normalized.includes("missing task")) {
      return 404
    }
    if (normalized.includes("opencode server url")) {
      return 500
    }
    return 400
  }

  start(): number {
    const port = this.db.getOptions().port
    const server = Bun.serve({
      port,
      fetch: (req, server) => {
        const url = new URL(req.url)

        if (url.pathname === "/ws") {
          if (server.upgrade(req)) return undefined
          return new Response("Upgrade failed", { status: 500 })
        }

        return this.handleHTTP(req)
      },
      websocket: {
        open: (ws) => { this.clients.add(ws) },
        close: (ws) => { this.clients.delete(ws) },
        message: () => {},
      },
    })

    this.server = server
    console.log(`[kanban] server started on http://localhost:${server.port}`)
    return server.port
  }

  stop() {
    this.server?.stop()
    this.server = null
  }

  private json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }

  private updateReviewAgentModel(model: string): void {
    if (!existsSync(REVIEW_AGENT_PATH)) {
      throw new Error(`Review agent file not found at ${REVIEW_AGENT_PATH}`)
    }

    const content = readFileSync(REVIEW_AGENT_PATH, "utf-8")
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!frontmatterMatch) {
      throw new Error(`Review agent file is missing frontmatter: ${REVIEW_AGENT_PATH}`)
    }

    const [, frontmatterText, body] = frontmatterMatch
    const lines = frontmatterText.split("\n")
    let replaced = false
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*model\s*:/.test(lines[i])) {
        lines[i] = `model: ${model}`
        replaced = true
        break
      }
    }

    if (!replaced) {
      lines.push(`model: ${model}`)
    }

    writeFileSync(REVIEW_AGENT_PATH, `---\n${lines.join("\n")}\n---\n${body}`, "utf-8")
  }

  private getGitBranches(): { branches: string[]; current: string | null; error?: string } {
    try {
      const branchOutput = execFileSync("git", ["branch", "--format=%(refname:short)"], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      const currentOutput = execFileSync("git", ["branch", "--show-current"], {
        cwd: process.cwd(),
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })

      const branches = branchOutput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      const current = currentOutput.trim() || null

      if (current && !branches.includes(current)) {
        branches.unshift(current)
      }

      return { branches, current }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { branches: [], current: null, error: `Failed to list git branches: ${message}` }
    }
  }

  private async handleHTTP(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const method = req.method

    // Serve kanban UI
    if (method === "GET" && url.pathname === "/") {
      return new Response(KANBAN_HTML, {
        headers: { "Content-Type": "text/html" },
      })
    }

    // REST API
    try {
      // Tasks
      if (method === "GET" && url.pathname === "/api/tasks") {
        return this.json(this.db.getTasks())
      }

      if (method === "POST" && url.pathname === "/api/tasks") {
        const body = await req.json()
        if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
          return this.json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
        }
        if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
          return this.json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
        }
        if (body?.executionStrategy === "best_of_n") {
          if (!body.bestOfNConfig) {
            return this.json({ error: "bestOfNConfig is required when executionStrategy is best_of_n" }, 400)
          }
          const validation = validateBestOfNConfig(body.bestOfNConfig)
          if (!validation.valid) {
            return this.json({ error: validation.error }, 400)
          }
        }
        if (body?.executionStrategy === "standard" && body?.bestOfNConfig !== undefined && body.bestOfNConfig !== null) {
          return this.json({ error: "bestOfNConfig must be null when executionStrategy is standard" }, 400)
        }
        if (body?.planmode === true && body?.executionStrategy === "best_of_n") {
          return this.json({ error: "planmode and best_of_n execution strategy cannot be combined in v1" }, 400)
        }
        const task = this.db.createTask(body)
        this.broadcast({ type: "task_created", payload: task })
        return this.json(task, 201)
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)$/)
      if (taskMatch) {
        const taskId = taskMatch[1]

        if (method === "PATCH") {
          const existingTask = this.db.getTask(taskId)
          if (!existingTask) return this.json({ error: "Task not found" }, 404)
          if (this.getExecuting() && existingTask.status !== "template") {
            return this.json({ error: getExecutionMutationError() }, 409)
          }

          const body = await req.json()
          if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
            return this.json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
          }
          if (body?.executionStrategy !== undefined && !isExecutionStrategy(body.executionStrategy)) {
            return this.json({ error: "Invalid executionStrategy. Allowed values: standard, best_of_n" }, 400)
          }
          if (body?.executionStrategy === "best_of_n" || (body?.bestOfNConfig && existingTask.executionStrategy === "best_of_n")) {
            if (body.bestOfNConfig === null) {
              return this.json({ error: "bestOfNConfig cannot be set to null for best_of_n tasks" }, 400)
            }
            const configToValidate = body.bestOfNConfig ?? existingTask.bestOfNConfig
            const validation = validateBestOfNConfig(configToValidate)
            if (!validation.valid) {
              return this.json({ error: validation.error }, 400)
            }
          }
          if (body?.executionStrategy === "standard" && body?.bestOfNConfig !== undefined && body.bestOfNConfig !== null) {
            return this.json({ error: "bestOfNConfig must be null when executionStrategy is standard" }, 400)
          }
          if (body?.planmode === true && (body?.executionStrategy === "best_of_n" || existingTask.executionStrategy === "best_of_n")) {
            return this.json({ error: "planmode and best_of_n execution strategy cannot be combined in v1" }, 400)
          }
          if (body?.status === "backlog" && body?.executionPhase === undefined) {
            body.executionPhase = "not_started"
            body.awaitingPlanApproval = false
          }
          if (body?.status === "backlog") {
            body.bestOfNSubstage = "idle"
          }
          const task = this.db.updateTask(taskId, body)
          if (!task) return this.json({ error: "Task not found" }, 404)
          this.broadcast({ type: "task_updated", payload: task })
          return this.json(task)
        }

        if (method === "DELETE") {
          const existingTask = this.db.getTask(taskId)
          if (!existingTask) return this.json({ error: "Task not found" }, 404)
          if (this.getExecuting() && existingTask.status !== "template") {
            return this.json({ error: getExecutionMutationError() }, 409)
          }

          const deleted = this.db.deleteTask(taskId)
          if (!deleted) return this.json({ error: "Task not found" }, 404)
          this.broadcast({ type: "task_deleted", payload: { id: taskId } })
          return new Response(null, { status: 204 })
        }
      }

      if (method === "PUT" && url.pathname === "/api/tasks/reorder") {
        if (this.getExecuting()) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }

        const body = await req.json()
        if (body.id && typeof body.newIdx === "number") {
          this.db.reorderTask(body.id, body.newIdx)
          this.broadcast({ type: "task_reordered", payload: {} })
        }
        return this.json({ ok: true })
      }

      // Options
      if (method === "GET" && url.pathname === "/api/options") {
        return this.json(this.db.getOptions())
      }

      if (method === "GET" && url.pathname === "/api/branches") {
        return this.json(this.getGitBranches())
      }

      if (method === "PUT" && url.pathname === "/api/options") {
        const body = await req.json()
        if (body?.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) {
          return this.json({ error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" }, 400)
        }
        if (body?.reviewModel !== undefined) {
          if (typeof body.reviewModel !== "string" || !body.reviewModel.trim() || body.reviewModel === "default") {
            return this.json({ error: "Invalid reviewModel. Select a concrete provider/model value." }, 400)
          }

          const serverUrl = this.getServerUrl()
          if (!serverUrl) {
            return this.json({ error: "OpenCode server URL is not configured" }, 500)
          }

          const client = createV2Client(serverUrl)
          const providersResponse = await client.config.providers()
          const catalog = providersResponse?.data ?? providersResponse
          const canonicalReviewModel = resolveCatalogModel(body.reviewModel, catalog, "Review")
          body.reviewModel = canonicalReviewModel
          this.updateReviewAgentModel(canonicalReviewModel)
        }
        const options = this.db.updateOptions(body)
        this.broadcast({ type: "options_updated", payload: options })
        return this.json(options)
      }

      // Models catalog
      if (method === "GET" && url.pathname === "/api/models") {
        const serverUrl = this.getServerUrl()
        if (!serverUrl) {
          return this.json({ error: "OpenCode server URL is not configured" }, 500)
        }
        try {
          const client = createV2Client(serverUrl)
          const response = await client.config.providers()
          const catalog = response?.data ?? response
          const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
          const normalized = providers.map((p: any) => ({
            id: p.id,
            name: p.name || p.id,
            models: Object.entries(p.models || {}).map(([id, model]: [string, any]) => ({
              id,
              label: typeof model === "object" && model?.label ? model.label : id,
              value: `${p.id}/${id}`,
            })),
          }))
          return this.json({ providers: normalized, defaults: normalizeDefaultModelMap(catalog) })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return this.json({ error: `Failed to fetch model catalog: ${msg}` }, 500)
        }
      }

      // Execution
      if (method === "POST" && url.pathname === "/api/start") {
        if (this.getExecuting()) {
          return this.json({ error: "Already executing" }, 409)
        }
        const preflightError = this.getStartError()
        if (preflightError) {
          return this.json({ error: preflightError }, this.classifyStartError(preflightError))
        }
        this.onStart().catch((err) => this.reportExecutionStartFailure(err))
        return this.json({ ok: true })
      }

      if (method === "GET" && url.pathname === "/api/execution-graph") {
        if (!hasExecutableTasks(this.db)) {
          return this.json({ error: "No tasks in backlog" }, 400)
        }
        try {
          const tasks = this.db.getTasks()
          const options = this.db.getOptions()
          const graph = buildExecutionGraph(tasks, options.parallelTasks)

          for (const node of graph.nodes) {
            const task = tasks.find(t => t.id === node.id)
            if (task && task.executionStrategy === "best_of_n" && task.bestOfNConfig) {
              const expandedWorkers = expandWorkerSlots(task.bestOfNConfig.workers).length
              const expandedReviewers = expandReviewerSlots(task.bestOfNConfig.reviewers).length
              node.expandedWorkerRuns = expandedWorkers
              node.expandedReviewerRuns = expandedReviewers
              node.hasFinalApplier = true
              node.estimatedRunCount = expandedWorkers + expandedReviewers + 1
            } else {
              node.expandedWorkerRuns = 1
              // Standard strategy can still run reviewer passes when "Review" is enabled.
              // Count at least one reviewer run in the execution graph estimate.
              const standardReviewerRuns = task?.review ? 1 : 0
              node.expandedReviewerRuns = standardReviewerRuns
              node.hasFinalApplier = false
              node.estimatedRunCount = 1 + standardReviewerRuns
            }
          }

          const pendingApprovalTasks = tasks.filter(t => t.status === "review" && t.awaitingPlanApproval)
          graph.pendingApprovals = pendingApprovalTasks.map(t => ({
            id: t.id,
            name: t.name,
            status: t.status,
            awaitingPlanApproval: t.awaitingPlanApproval,
            planRevisionCount: t.planRevisionCount,
          }))

          return this.json(graph)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return this.json({ error: msg }, 400)
        }
      }

      if (method === "POST" && url.pathname === "/api/stop") {
        this.onStop()
        return this.json({ ok: true })
      }

      const startSingleMatch = method === "POST"
        ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/start$/)
        : null
      if (startSingleMatch) {
        if (this.getExecuting()) {
          return this.json({ error: "Already executing" }, 409)
        }
        const taskId = startSingleMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) {
          return this.json({ error: "Task not found" }, 404)
        }
        const isBacklogTask = task.status === "backlog" && task.executionPhase !== "plan_complete_waiting_approval"
        const isApprovedPlanTask = task.executionPhase === "implementation_pending"
        const isRevisionPendingTask = task.executionPhase === "plan_revision_pending"
        if (!isBacklogTask && !isApprovedPlanTask && !isRevisionPendingTask) {
          return this.json({ error: "Task is not executable" }, 400)
        }
        const preflightError = this.getStartError(taskId)
        if (preflightError) {
          return this.json({ error: preflightError }, this.classifyStartError(preflightError))
        }
        this.onStartSingle(taskId).catch((err) => this.reportExecutionStartFailure(err))
        return this.json({ ok: true })
      }

      // Approve plan for planmode task
      const approveMatch = method === "POST"
        ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/approve-plan$/)
        : null
      if (approveMatch) {
        const taskId = approveMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) {
          return this.json({ error: "Task not found" }, 404)
        }
        if (this.getExecuting()) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }
        if (!task.agentOutput.trim()) {
          return this.json({ error: "Task has no captured plan output to approve. Reset it to backlog and rerun planning." }, 400)
        }
        if (task.planmode && (task.executionPhase === "implementation_pending" || task.executionPhase === "implementation_done")) {
          return this.json({ ok: true, message: "Plan already approved" })
        }
        if (task.status !== "review" || !task.awaitingPlanApproval) {
          return this.json({ error: "Task is not awaiting plan approval" }, 400)
        }
        let approvalNote: string | undefined
        try {
          const body = await req.json()
          if (body && typeof body.message === "string") {
            const trimmed = body.message.trim()
            if (trimmed) {
              approvalNote = trimmed
            }
          }
        } catch {
          // ignore parse errors, message is optional
        }
        if (approvalNote) {
          this.db.appendAgentOutput(taskId, `[user-approval-note] ${approvalNote}\n`)
          this.broadcast({ type: "agent_output", payload: { taskId, output: `[user-approval-note] ${approvalNote}\n` } })
        }
        this.db.updateTask(taskId, {
          awaitingPlanApproval: false,
          executionPhase: "implementation_pending",
          status: "backlog",
        })
        const updated = this.db.getTask(taskId)!
        this.broadcast({ type: "task_updated", payload: updated })
        if (!this.getExecuting()) {
          const preflightError = this.getStartError()
          if (!preflightError) {
            this.onStart().catch((err) => this.reportExecutionStartFailure(err))
          }
        }
        return this.json({ ok: true })
      }

      // Request plan revision for planmode task
      const revisionMatch = method === "POST"
        ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/request-plan-revision$/)
        : null
      if (revisionMatch) {
        const taskId = revisionMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) {
          return this.json({ error: "Task not found" }, 404)
        }
        if (this.getExecuting()) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }
        if (!task.agentOutput.trim()) {
          return this.json({ error: "Task has no captured plan output to revise" }, 400)
        }
        if (task.status !== "review" || !task.awaitingPlanApproval) {
          return this.json({ error: "Task is not awaiting plan approval" }, 400)
        }
        let feedback: string | undefined
        try {
          const body = await req.json()
          if (body && typeof body.feedback === "string") {
            const trimmed = body.feedback.trim()
            if (trimmed) {
              feedback = trimmed
            }
          }
        } catch {
          // ignore parse errors
        }
        if (!feedback) {
          return this.json({ error: "Feedback cannot be empty" }, 400)
        }
        this.db.appendAgentOutput(taskId, `[user-revision-request] ${feedback}\n`)
        this.broadcast({ type: "agent_output", payload: { taskId, output: `[user-revision-request] ${feedback}\n` } })
        this.db.updateTask(taskId, {
          planRevisionCount: (task.planRevisionCount ?? 0) + 1,
          executionPhase: "plan_revision_pending",
        })
        const updated = this.db.getTask(taskId)!
        this.broadcast({ type: "plan_revision_requested", payload: updated })
        this.broadcast({ type: "task_updated", payload: updated })
        if (!this.getExecuting()) {
          const preflightError = this.getStartError()
          if (!preflightError) {
            this.onStart().catch((err) => this.reportExecutionStartFailure(err))
          }
        }
        return this.json({ ok: true })
      }

      // Task runs
      const runsMatch = method === "GET" ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/runs$/) : null
      if (runsMatch) {
        const taskId = runsMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) return this.json({ error: "Task not found" }, 404)
        const runs = this.db.getTaskRuns(taskId)
        return this.json(runs)
      }

      // Task candidates
      const candidatesMatch = method === "GET" ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/candidates$/) : null
      if (candidatesMatch) {
        const taskId = candidatesMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) return this.json({ error: "Task not found" }, 404)
        const candidates = this.db.getTaskCandidates(taskId)
        return this.json(candidates)
      }

      // Best-of-n summary
      const summaryMatch = method === "GET" ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/best-of-n-summary$/) : null
      if (summaryMatch) {
        const taskId = summaryMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) return this.json({ error: "Task not found" }, 404)
        if (task.executionStrategy !== "best_of_n") {
          return this.json({ error: "Task is not a best_of_n task" }, 400)
        }
        const counts = this.db.getBestOfNCounts(taskId)
        const candidates = this.db.getTaskCandidates(taskId)
        const expandedWorkerCount = task.bestOfNConfig ? expandWorkerSlots(task.bestOfNConfig.workers).length : 0
        const expandedReviewerCount = task.bestOfNConfig ? expandReviewerSlots(task.bestOfNConfig.reviewers).length : 0
        return this.json({
          taskId,
          substage: task.bestOfNSubstage,
          ...counts,
          expandedWorkerCount,
          expandedReviewerCount,
          totalExpandedRuns: expandedWorkerCount + expandedReviewerCount + 1,
          successfulCandidateCount: candidates.length,
          selectedCandidate: candidates.find(c => c.status === "selected")?.id ?? null,
        })
      }

      return this.json({ error: "Not found" }, 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return this.json({ error: message }, 500)
    }
  }
}
