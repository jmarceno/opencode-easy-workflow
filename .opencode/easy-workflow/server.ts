import { readFileSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import type { WSMessage } from "./types"
import { KanbanDB } from "./db"

const __dirname = dirname(fileURLToPath(import.meta.url))
const KANBAN_HTML = readFileSync(join(__dirname, "kanban", "index.html"), "utf-8")

type StartFn = () => Promise<void>
type StopFn = () => void

export class KanbanServer {
  private db: KanbanDB
  private clients: Set<any> = new Set()
  private server: ReturnType<typeof Bun.serve> | null = null
  private onStart: StartFn
  private onStop: StopFn
  private getExecuting: () => boolean

  constructor(
    db: KanbanDB,
    opts: { onStart: StartFn; onStop: StopFn; getExecuting: () => boolean }
  ) {
    this.db = db
    this.onStart = opts.onStart
    this.onStop = opts.onStop
    this.getExecuting = opts.getExecuting
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
        const task = this.db.createTask(body)
        this.broadcast({ type: "task_created", payload: task })
        return this.json(task, 201)
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)$/)
      if (taskMatch) {
        const taskId = taskMatch[1]

        if (method === "PATCH") {
          const body = await req.json()
          const task = this.db.updateTask(taskId, body)
          if (!task) return this.json({ error: "Task not found" }, 404)
          this.broadcast({ type: "task_updated", payload: task })
          return this.json(task)
        }

        if (method === "DELETE") {
          const deleted = this.db.deleteTask(taskId)
          if (!deleted) return this.json({ error: "Task not found" }, 404)
          this.broadcast({ type: "task_deleted", payload: { id: taskId } })
          return new Response(null, { status: 204 })
        }
      }

      if (method === "PUT" && url.pathname === "/api/tasks/reorder") {
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

      if (method === "PUT" && url.pathname === "/api/options") {
        const body = await req.json()
        const options = this.db.updateOptions(body)
        this.broadcast({ type: "options_updated", payload: options })
        return this.json(options)
      }

      // Execution
      if (method === "POST" && url.pathname === "/api/start") {
        if (this.getExecuting()) {
          return this.json({ error: "Already executing" }, 409)
        }
        const tasks = this.db.getTasksByStatus("backlog")
        if (tasks.length === 0) {
          return this.json({ error: "No tasks in backlog" }, 400)
        }
        this.onStart().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error("[kanban] orchestrator start failed:", msg)
          this.broadcast({ type: "error", payload: { message: `Execution failed: ${msg}` } })
          this.broadcast({ type: "execution_stopped", payload: {} })
        })
        return this.json({ ok: true })
      }

      if (method === "POST" && url.pathname === "/api/stop") {
        this.onStop()
        return this.json({ ok: true })
      }

      return this.json({ error: "Not found" }, 404)
    } catch (err) {
      return this.json({ error: String(err) }, 500)
    }
  }
}
