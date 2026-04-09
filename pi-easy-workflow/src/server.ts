import { mkdirSync } from "fs"
import { dirname } from "path"
import { join } from "path"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"
import { PiOrchestrator } from "./orchestrator.ts"

export interface CreateServerOptions {
  dbPath?: string
  port?: number
}

export function createPiServer(options: CreateServerOptions = {}): {
  db: PiKanbanDB
  server: PiKanbanServer
  orchestrator: PiOrchestrator
} {
  const defaultDbPath = join(process.cwd(), ".pi", "easy-workflow", "tasks.db")
  const dbPath = options.dbPath ?? defaultDbPath
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new PiKanbanDB(dbPath)
  let orchestrator: PiOrchestrator | null = null

  const server = new PiKanbanServer(db, {
    port: options.port,
    onStart: async () => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      return await orchestrator.startAll()
    },
    onStartSingle: async (taskId: string) => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      return await orchestrator.startSingle(taskId)
    },
    onStop: async () => {
      if (!orchestrator) throw new Error("Orchestrator unavailable")
      await orchestrator.stop()
      return { ok: true }
    },
  })

  orchestrator = new PiOrchestrator(
    db,
    (message) => server.broadcast(message),
    (sessionId) => `/#session/${encodeURIComponent(sessionId)}`,
  )

  return { db, server, orchestrator }
}

export { PiKanbanServer }
