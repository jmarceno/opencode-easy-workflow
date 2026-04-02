import { readFileSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import { execFileSync } from "child_process"
import type { WSMessage, ThinkingLevel } from "./types"
import { KanbanDB } from "./db"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { buildExecutionGraph } from "./execution-plan"

const __dirname = dirname(fileURLToPath(import.meta.url))
const KANBAN_HTML = readFileSync(join(__dirname, "kanban", "index.html"), "utf-8")

type StartFn = () => Promise<void>
type StopFn = () => void
type StartPreflightFn = () => string | null
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
  private onStop: StopFn
  private getExecuting: () => boolean
  private getStartError: StartPreflightFn
  private getServerUrl: ServerUrlFn

  constructor(
    db: KanbanDB,
    opts: { onStart: StartFn; onStop: StopFn; getExecuting: () => boolean; getStartError?: StartPreflightFn; getServerUrl?: ServerUrlFn }
  ) {
    this.db = db
    this.onStart = opts.onStart
    this.onStop = opts.onStop
    this.getExecuting = opts.getExecuting
    this.getStartError = opts.getStartError || (() => null)
    this.getServerUrl = opts.getServerUrl || (() => null)
  }

  broadcast(msg: WSMessage) {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      try { ws.send(data) } catch { this.clients.delete(ws) }
    }
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

  private getGitBranches(): { branches: string[]; current: string | null } {
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
    } catch {
      return { branches: [], current: null }
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
          if (body?.status === "backlog" && body?.executionPhase === undefined) {
            body.executionPhase = "not_started"
            body.awaitingPlanApproval = false
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
        if (!hasExecutableTasks(this.db)) {
          return this.json({ error: "No tasks in backlog" }, 400)
        }
        const preflightError = this.getStartError()
        if (preflightError) {
          return this.json({ error: preflightError }, 500)
        }
        this.onStart().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error("[kanban] orchestrator start failed:", msg)
          this.broadcast({ type: "error", payload: { message: `Execution failed: ${msg}` } })
          this.broadcast({ type: "execution_stopped", payload: {} })
        })
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
            this.onStart().catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              console.error("[kanban] orchestrator start failed:", msg)
              this.broadcast({ type: "error", payload: { message: `Execution failed: ${msg}` } })
              this.broadcast({ type: "execution_stopped", payload: {} })
            })
          }
        }
        return this.json({ ok: true })
      }

      return this.json({ error: "Not found" }, 404)
    } catch (err) {
      return this.json({ error: String(err) }, 500)
    }
  }
}
