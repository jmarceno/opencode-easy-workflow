import { randomUUID } from "crypto"
import type { PiKanbanDB } from "../db.ts"
import type { PiSessionKind, PiWorkflowSession } from "../db/types.ts"
import type { ThinkingLevel } from "../types.ts"
import { PiRpcProcess } from "./pi-process.ts"
import { buildInitializeCommand, buildPromptCommand, buildSnapshotCommand } from "./pi-rpc.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return null
}

function readPromptText(result: Record<string, unknown>): string {
  if (typeof result.text === "string") return result.text
  if (typeof result.output === "string") return result.output
  if (typeof result.message === "string") return result.message
  if (result.message && typeof result.message === "object") {
    const text = (result.message as Record<string, unknown>).text
    if (typeof text === "string") return text
  }
  if (Array.isArray(result.messages)) {
    const last = result.messages[result.messages.length - 1]
    if (last && typeof last === "object") {
      const text = (last as Record<string, unknown>).text
      if (typeof text === "string") return text
    }
  }
  return ""
}

export interface ExecuteSessionPromptInput {
  taskId: string
  taskRunId?: string | null
  sessionKind: PiSessionKind
  cwd: string
  worktreeDir?: string | null
  branch?: string | null
  model?: string
  thinkingLevel?: ThinkingLevel
  promptText: string
  onOutput?: (chunk: string) => void
}

export interface ExecuteSessionPromptResult {
  session: PiWorkflowSession
  responseText: string
}

export class PiSessionManager {
  constructor(private readonly db: PiKanbanDB) {}

  async executePrompt(input: ExecuteSessionPromptInput): Promise<ExecuteSessionPromptResult> {
    const sessionId = randomUUID().slice(0, 8)
    let session = this.db.createWorkflowSession({
      id: sessionId,
      taskId: input.taskId,
      taskRunId: input.taskRunId ?? null,
      sessionKind: input.sessionKind,
      status: "starting",
      cwd: input.cwd,
      worktreeDir: input.worktreeDir ?? null,
      branch: input.branch ?? null,
      model: input.model ?? "default",
      thinkingLevel: input.thinkingLevel ?? "default",
      startedAt: nowUnix(),
    })

    const process = new PiRpcProcess({
      db: this.db,
      session,
      onOutput: input.onOutput,
    })

    let responseText = ""
    try {
      process.start()

      const init = buildInitializeCommand({
        cwd: input.cwd,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      })
      const initResult = await process.send(init.method, init.params ?? {}, 60_000)

      session = this.db.updateWorkflowSession(session.id, {
        piSessionId: readString(initResult, "sessionId", "piSessionId"),
        piSessionFile: readString(initResult, "sessionFile", "piSessionFile"),
      }) ?? session

      const prompt = buildPromptCommand(input.promptText)
      const promptResult = await process.send(prompt.method, prompt.params ?? {}, 300_000)
      responseText = readPromptText(promptResult)

      const snapshot = buildSnapshotCommand()
      const snapshotResult = await process.send(snapshot.method, snapshot.params ?? {}, 30_000).catch(() => null)
      if (snapshotResult) {
        this.db.appendSessionIO({
          sessionId: session.id,
          stream: "server",
          recordType: "snapshot",
          payloadJson: snapshotResult,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.updateWorkflowSession(session.id, {
        status: "failed",
        errorMessage: message,
        finishedAt: nowUnix(),
      })
      throw error
    } finally {
      await process.close()
    }

    return {
      session: this.db.getWorkflowSession(session.id) ?? session,
      responseText,
    }
  }
}
