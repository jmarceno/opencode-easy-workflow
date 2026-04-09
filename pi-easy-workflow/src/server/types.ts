import type { PiKanbanDB } from "../db.ts"
import type { WSMessage } from "../types.ts"

export interface RouteParams {
  [key: string]: string
}

export interface RequestContext {
  req: Request
  url: URL
  params: RouteParams
  db: PiKanbanDB
  json: (data: unknown, status?: number) => Response
  text: (data: string, status?: number) => Response
  broadcast: (message: WSMessage) => void
  sessionUrlFor: (sessionId: string) => string
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response
