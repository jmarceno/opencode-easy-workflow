import { mkdirSync } from "fs"
import { dirname } from "path"
import { join } from "path"
import { PiKanbanDB } from "./db.ts"
import { PiKanbanServer } from "./server/server.ts"

export interface CreateServerOptions {
  dbPath?: string
  port?: number
}

export function createPiServer(options: CreateServerOptions = {}): { db: PiKanbanDB; server: PiKanbanServer } {
  const defaultDbPath = join(process.cwd(), ".pi", "easy-workflow", "tasks.db")
  const dbPath = options.dbPath ?? defaultDbPath
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new PiKanbanDB(dbPath)
  const server = new PiKanbanServer(db, { port: options.port })
  return { db, server }
}

export { PiKanbanServer }
