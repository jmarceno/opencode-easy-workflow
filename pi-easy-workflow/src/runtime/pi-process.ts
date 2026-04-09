import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { SessionMessage } from "../types.ts"
import { projectPiEventToSessionMessage } from "./message-projection.ts"

type Pending = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: Timer
}

function parseArgs(value: string): string[] {
  return value
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pullResponseText(result: Record<string, unknown>): string {
  if (typeof result.text === "string") return result.text
  if (typeof result.output === "string") return result.output
  const message = result.message
  if (typeof message === "string") return message
  if (message && typeof message === "object") {
    const messageText = (message as Record<string, unknown>).text
    if (typeof messageText === "string") return messageText
  }
  return ""
}

export class PiRpcProcess {
  private readonly db: PiKanbanDB
  private readonly session: PiWorkflowSession
  private readonly onOutput?: (chunk: string) => void
  private readonly onSessionMessage?: (message: SessionMessage) => void
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stdoutBuffer = ""
  private stderrBuffer = ""

  constructor(args: {
    db: PiKanbanDB
    session: PiWorkflowSession
    onOutput?: (chunk: string) => void
    onSessionMessage?: (message: SessionMessage) => void
  }) {
    this.db = args.db
    this.session = args.session
    this.onOutput = args.onOutput
    this.onSessionMessage = args.onSessionMessage
  }

  start(): void {
    if (this.proc) return

    const piBin = process.env.PI_EASY_WORKFLOW_PI_BIN?.trim() || "pi"
    const defaultArgs = ["--rpc", "--no-extensions"]
    const configuredArgs = process.env.PI_EASY_WORKFLOW_PI_ARGS
      ? parseArgs(process.env.PI_EASY_WORKFLOW_PI_ARGS)
      : defaultArgs

    this.proc = Bun.spawn({
      cmd: [piBin, ...configuredArgs],
      cwd: this.session.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    })

    this.db.updateWorkflowSession(this.session.id, {
      status: "active",
      processPid: this.proc.pid,
    })
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "process_started",
        pid: this.proc.pid,
        command: [piBin, ...configuredArgs],
      },
    })

    this.captureStdout()
    this.captureStderr()
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    if (!this.proc) throw new Error("Pi process not started")

    const id = this.nextId++
    const payload = { id, method, params }
    const line = `${JSON.stringify(payload)}\n`

    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stdin",
      recordType: "rpc_command",
      payloadJson: payload,
      payloadText: JSON.stringify(payload),
    })

    await this.proc.stdin.write(line)

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC timeout for method ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  async close(): Promise<void> {
    if (!this.proc) return

    const proc = this.proc
    this.proc = null

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`Pi process closed before RPC response (${id})`))
      this.pending.delete(id)
    }

    try {
      proc.kill()
    } catch {
      // ignore
    }

    const exitCode = await proc.exited
    this.db.updateWorkflowSession(this.session.id, {
      status: exitCode === 0 ? "completed" : "failed",
      finishedAt: Math.floor(Date.now() / 1000),
      exitCode,
    })
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "process_exited",
        exitCode,
      },
    })
  }

  private captureStdout(): void {
    if (!this.proc) return

    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()

    const loop = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.stdoutBuffer += decoder.decode(value, { stream: true })
        this.consumeStdoutLines()
      }
      if (this.stdoutBuffer.trim()) {
        this.handleStdoutLine(this.stdoutBuffer.trim())
        this.stdoutBuffer = ""
      }
    }

    void loop()
  }

  private consumeStdoutLines(): void {
    while (true) {
      const newlineIdx = this.stdoutBuffer.indexOf("\n")
      if (newlineIdx < 0) break
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1)
      if (!line) continue
      this.handleStdoutLine(line)
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      parsed = { type: "text", text: line }
    }

    const record = asRecord(parsed)
    const id = typeof record.id === "number" ? record.id : null
    const isResponse = id !== null && ("result" in record || "error" in record)
    const recordType = isResponse ? "rpc_response" : "rpc_event"

    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stdout",
      recordType,
      payloadJson: record,
      payloadText: line,
    })

    const message = projectPiEventToSessionMessage({
      event: record,
      sessionId: this.session.id,
      taskId: this.session.taskId,
      taskRunId: this.session.taskRunId,
    })
    if (message.contentJson && Object.keys(message.contentJson).length > 0) {
      const createdMessage = this.db.createSessionMessage(message)
      if (createdMessage && this.onSessionMessage) {
        this.onSessionMessage(createdMessage)
      }
      const text = pullResponseText(asRecord(record.result)) || pullResponseText(record)
      if (text && this.onOutput) {
        this.onOutput(text)
      }
    }

    if (!isResponse || id === null) return

    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    if (record.error !== undefined && record.error !== null) {
      pending.reject(new Error(typeof record.error === "string" ? record.error : JSON.stringify(record.error)))
      return
    }

    pending.resolve(asRecord(record.result))
  }

  private captureStderr(): void {
    if (!this.proc) return

    const reader = this.proc.stderr.getReader()
    const decoder = new TextDecoder()

    const loop = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.stderrBuffer += decoder.decode(value, { stream: true })
        this.consumeStderrLines()
      }
      if (this.stderrBuffer.trim()) {
        this.persistStderr(this.stderrBuffer.trim())
        this.stderrBuffer = ""
      }
    }

    void loop()
  }

  private consumeStderrLines(): void {
    while (true) {
      const newlineIdx = this.stderrBuffer.indexOf("\n")
      if (newlineIdx < 0) break
      const line = this.stderrBuffer.slice(0, newlineIdx).trim()
      this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1)
      if (!line) continue
      this.persistStderr(line)
    }
  }

  private persistStderr(line: string): void {
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stderr",
      recordType: "stderr_chunk",
      payloadText: line,
      payloadJson: { line },
    })
  }
}
