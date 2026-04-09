import type { PiKanbanDB } from "../db.ts"
import type { PiWorkflowSession } from "../db/types.ts"
import type { SessionMessage } from "../types.ts"
import { projectPiEventToSessionMessage } from "./message-projection.ts"

export type PiEventListener = (event: Record<string, unknown>) => void
export type ExtensionUIRequestHandler = (request: {
  id: string
  method: string
  [key: string]: unknown
}) => Promise<{ type: "extension_ui_response"; id: string } & Record<string, unknown>>

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

/**
 * PiRpcProcess - Event-driven RPC client for pi CLI
 * 
 * Architecture:
 * - Commands sent with unique string IDs
 * - Responses match commands by ID
 * - Events stream asynchronously (messages, tool calls, UI requests)
 * - Completion detected via agent_end event (not polling)
 * - Interactive UI via extension_ui_request/response
 */
export class PiRpcProcess {
  private readonly db: PiKanbanDB
  private readonly session: PiWorkflowSession
  private readonly onOutput?: (chunk: string) => void
  private readonly onSessionMessage?: (message: SessionMessage) => void
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
  private requestId = 0
  private readonly pending = new Map<string, Pending>()
  private eventListeners: PiEventListener[] = []
  private extensionUIHandler: ExtensionUIRequestHandler | null = null
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private isIdle = true

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
    const defaultArgs = ["--mode", "rpc", "--no-extensions"]
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

  /**
   * Subscribe to agent events
   */
  onEvent(listener: PiEventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      const index = this.eventListeners.indexOf(listener)
      if (index !== -1) {
        this.eventListeners.splice(index, 1)
      }
    }
  }

  /**
   * Set handler for extension UI requests (interactive prompts)
   */
  setExtensionUIHandler(handler: ExtensionUIRequestHandler): void {
    this.extensionUIHandler = handler
  }

  /**
   * Send a command and wait for response
   */
  async send(command: { type: string } & Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (!this.proc) throw new Error("Pi process not started")

    const id = `req_${++this.requestId}`
    const payload = { ...command, id }
    const line = `${JSON.stringify(payload)}\n`

    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stdin",
      recordType: "rpc_command",
      payloadJson: payload,
      payloadText: JSON.stringify(payload),
    })

    await this.proc.stdin.write(line)

    // Set idle to false when we send a prompt
    if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
      this.isIdle = false
    }

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC timeout for command ${command.type}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  /**
   * Send a prompt (returns immediately, use onEvent/waitForIdle for results)
   */
  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message }, 10_000)
  }

  /**
   * Wait for agent to become idle (no streaming)
   * Resolves when agent_end event is received
   */
  waitForIdle(timeoutMs = 600_000): Promise<void> { // 10 min default
    return new Promise((resolve, reject) => {
      if (this.isIdle) {
        resolve()
        return
      }

      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout waiting for agent to become idle`))
      }, timeoutMs)

      const unsubscribe = this.onEvent((event) => {
        if (event.type === "agent_end") {
          this.isIdle = true
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
  }

  /**
   * Collect all events until agent becomes idle
   */
  collectEvents(timeoutMs = 600_000): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const events: Record<string, unknown>[] = []

      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout collecting events`))
      }, timeoutMs)

      const unsubscribe = this.onEvent((event) => {
        events.push(event)
        if (event.type === "agent_end") {
          this.isIdle = true
          clearTimeout(timer)
          unsubscribe()
          resolve(events)
        }
      })
    })
  }

  /**
   * Send prompt and wait for completion
   */
  async promptAndWait(message: string, timeoutMs = 600_000): Promise<Record<string, unknown>[]> {
    const eventsPromise = this.collectEvents(timeoutMs)
    await this.prompt(message)
    return eventsPromise
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

  private async handleStdoutLine(line: string): Promise<void> {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not JSON, treat as text event
      parsed = { type: "text", text: line }
    }

    const id = typeof parsed.id === "string" ? parsed.id : null
    const isResponse = parsed.type === "response" && id !== null
    const isExtensionUIRequest = parsed.type === "extension_ui_request" && id !== null

    // Record in database first (before handling response which might return early)
    const recordType = isResponse ? "rpc_response" : "rpc_event"
    this.db.appendSessionIO({
      sessionId: this.session.id,
      stream: "stdout",
      recordType,
      payloadJson: parsed,
      payloadText: line,
    })

    // Handle RPC responses to pending requests
    if (isResponse && id && this.pending.has(id)) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(pending.timer)

      if (parsed.success === false) {
        const errorMsg = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error)
        pending.reject(new Error(errorMsg))
      } else {
        pending.resolve(asRecord(parsed.data))
      }
      return
    }

    // Handle extension UI requests (interactive prompts)
    if (isExtensionUIRequest && this.extensionUIHandler) {
      try {
        const response = await this.extensionUIHandler(parsed as { id: string; method: string; [key: string]: unknown })
        await this.send(response, 10_000)
      } catch (error) {
        // Send cancelled response if handler fails
        await this.send({
          type: "extension_ui_response",
          id: parsed.id,
          cancelled: true,
        }, 10_000).catch(() => {})
      }
      return
    }

    // Broadcast to event listeners
    for (const listener of this.eventListeners) {
      try {
        listener(parsed)
      } catch {
        // Ignore listener errors
      }
    }

    // Project to session messages
    const message = projectPiEventToSessionMessage({
      event: parsed,
      sessionId: this.session.id,
      taskId: this.session.taskId,
      taskRunId: this.session.taskRunId,
    })
    if (message.contentJson && Object.keys(message.contentJson).length > 0) {
      const createdMessage = this.db.createSessionMessage(message)
      if (createdMessage && this.onSessionMessage) {
        this.onSessionMessage(createdMessage)
      }
      const text = pullResponseText(parsed)
      if (text && this.onOutput) {
        this.onOutput(text)
      }
    }
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
