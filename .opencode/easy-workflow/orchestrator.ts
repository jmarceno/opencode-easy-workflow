import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import { execFileSync } from "child_process"
import type { Task, Options, ReviewResult, ThinkingLevel, BestOfNConfig, BestOfNSlot, TaskRun, TaskCandidate, ReviewerOutput, AggregatedReviewResult, SelectionMode } from "./types"
import type { WorkflowSessionKind } from "./db"
import { KanbanDB } from "./db"
import { KanbanServer } from "./server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { resolveExecutionTasks, resolveBatches } from "./execution-plan"
import { getLatestTaggedOutput, getPlanExecutionEligibility } from "./task-state"

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_ROOT = join(__dirname, "..")
const TEMPLATE_PATH = join(WORKFLOW_ROOT, "easy-workflow", "workflow.md")
const AGENTS_DIR = join(WORKFLOW_ROOT, "agents")
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "easy-workflow", "debug.log")
let debugLogErrorReporter: ((message: string) => void) | null = null

const THINKING_LEVEL_AGENT_MAP: Record<Exclude<ThinkingLevel, "default">, string> = {
  low: "build-fast",
  medium: "build",
  high: "deep-thinker",
}

const AUTONOMOUS_THINKING_AGENT_MAP: Record<ThinkingLevel, string> = {
  default: "workflow-build",
  low: "workflow-build-fast",
  medium: "workflow-build",
  high: "workflow-deep-thinker",
}

const EXPECTED_THINKING_AGENTS = Object.values(THINKING_LEVEL_AGENT_MAP)

export const AUTONOMY_INSTRUCTION = "EXECUTE END-TO-END. Do not ask follow-up questions unless blocked by: missing credentials, missing required external input, or an irreversible product decision. Make reasonable assumptions from the codebase."

// ---- SDK v2 client wrapper ----

function createV2Client(baseUrl: string, directory?: string) {
  return createOpencodeClient({
    baseUrl,
    directory,
    throwOnError: true,
  })
}

function registerWorkflowSessionSafe(
  db: KanbanDB,
  sessionId: string,
  taskId: string,
  sessionKind: WorkflowSessionKind,
  ownerDirectory: string,
  skipPermissionAsking: boolean,
  taskRunId?: string | null,
): void {
  try {
    db.registerWorkflowSession({
      sessionId,
      taskId,
      taskRunId: taskRunId ?? null,
      sessionKind,
      ownerDirectory,
      skipPermissionAsking,
    })
    appendDebugLog("info", "workflow session registered", { sessionId, taskId, sessionKind })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendDebugLog("warn", "failed to register workflow session", { sessionId, taskId, sessionKind, error: msg })
  }
}

function writeRootOwnerPointerSafe(worktreeDirectory: string, ownerDirectory: string, dbPath: string): void {
  try {
    const targetDir = join(worktreeDirectory, ".opencode", "easy-workflow")
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, "root-owner.json"),
      JSON.stringify({ ownerDirectory, rootDbPath: dbPath }, null, 2),
      "utf-8",
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendDebugLog("warn", "failed to write root-owner pointer", { worktreeDirectory, error: msg })
  }
}

// ---- Utility functions (reused from existing plugin) ----

function unwrapResponseData<T>(response: any): T {
  if (response && typeof response === "object" && "data" in response) {
    return response.data as T
  }
  return response as T
}

function parseModelSelection(value: string): { providerID: string; modelID: string } | null {
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return null
  const providerID = trimmed.slice(0, separatorIndex).trim()
  const modelID = trimmed.slice(separatorIndex + 1).trim()
  return providerID && modelID ? { providerID, modelID } : null
}

function parseScalar(rawValue: string): unknown {
  if (rawValue === "null") return null
  if (rawValue === "true") return true
  if (rawValue === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue)
  return rawValue
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const [, frontmatterText, body] = match
  const frontmatter: Record<string, unknown> = {}
  for (const line of frontmatterText.split("\n")) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex === -1) continue
    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    frontmatter[key] = parseScalar(rawValue)
  }
  return { frontmatter, body }
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function appendDebugLog(kind: string, message: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : ""
  try {
    mkdirSync(join(WORKFLOW_ROOT, "easy-workflow"), { recursive: true })
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${kind}: ${message}${payload}\n`, "utf-8")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (debugLogErrorReporter) {
      debugLogErrorReporter(`Failed to write debug log: ${msg}`)
    }
  }
}

function base64EncodeUrlSafe(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function buildSessionUrl(serverUrl: string, directory: string, sessionId: string): string {
  const encodedDir = base64EncodeUrlSafe(directory)
  return `${serverUrl}/${encodedDir}/session/${sessionId}`
}

function getAssistantErrorMessage(error: any): string {
  if (!error) return "Unknown error"
  if (typeof error.data?.message === "string") {
    const code = typeof error.data?.statusCode === "number" ? ` (status ${error.data.statusCode})` : ""
    return `${error.data.message}${code}`
  }
  if (typeof error.message === "string") return error.message
  return JSON.stringify(error)
}

function resolveThinkingLevel(task: Task, options: Options): ThinkingLevel {
  if (task.thinkingLevel && task.thinkingLevel !== "default") {
    return task.thinkingLevel
  }
  if (options.thinkingLevel && options.thinkingLevel !== "default") {
    return options.thinkingLevel
  }
  return "default"
}

export function mapThinkingLevelToAgent(level: ThinkingLevel): string | null {
  if (level === "default") return null
  return THINKING_LEVEL_AGENT_MAP[level] || null
}

export function resolvePlanningAgent(skipPermissionAsking: boolean): string {
  return skipPermissionAsking ? "workflow-plan" : "plan"
}

export function resolveExecutionAgent(skipPermissionAsking: boolean, level: ThinkingLevel): string | null {
  if (skipPermissionAsking) {
    return AUTONOMOUS_THINKING_AGENT_MAP[level]
  }
  return mapThinkingLevelToAgent(level)
}

function remapThinkingAgentError(error: unknown, agent: string | null): Error {
  if (!agent) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage.toLowerCase()
  const looksLikeMissingAgent =
    message.includes("agent")
    && (message.includes("not found") || message.includes("unknown") || message.includes("invalid") || message.includes("does not exist"))

  if (!looksLikeMissingAgent) {
    return error instanceof Error ? error : new Error(rawMessage)
  }

  return new Error(
    `Thinking-level agent \"${agent}\" is unavailable. Configure one of: ${EXPECTED_THINKING_AGENTS.join(", ")}. Original error: ${rawMessage}`,
  )
}

function unwrapResponseDataOrThrow<T>(response: any, operation: string): T {
  if (response && typeof response === "object" && "error" in response && response.error) {
    throw new Error(`${operation} failed: ${getAssistantErrorMessage(response.error)}`)
  }
  return unwrapResponseData<T>(response)
}

// ---- Review config from workflow.md ----

interface ReviewConfig {
  reviewAgent: string | null
  maxReviewRuns: number
}

function loadReviewConfig(): ReviewConfig {
  if (!existsSync(TEMPLATE_PATH)) {
    return { reviewAgent: "workflow-review", maxReviewRuns: 2 }
  }
  const content = readFileSync(TEMPLATE_PATH, "utf-8")
  const { frontmatter } = parseFrontmatter(content)
  return {
    reviewAgent: normalizeAgentName(frontmatter.reviewAgent) ?? "workflow-review",
    maxReviewRuns: typeof frontmatter.maxReviewRuns === "number" ? frontmatter.maxReviewRuns : 2,
  }
}

// ---- Orchestrator ----

export class Orchestrator {
  private db: KanbanDB
  private server: KanbanServer
  private serverUrlSource: string | (() => string | null)
  private worktreeDir: string
  private ownerDirectory: string
  private running = false
  private shouldStop = false
  private providerCatalog: any | null = null

  constructor(db: KanbanDB, server: KanbanServer, serverUrl: string | (() => string | null), worktreeDir: string, ownerDirectory?: string) {
    this.db = db
    this.server = server
    this.serverUrlSource = serverUrl
    this.worktreeDir = worktreeDir
    this.ownerDirectory = ownerDirectory || worktreeDir
    debugLogErrorReporter = (message: string) => {
      this.server.broadcast({ type: "error", payload: { message } })
    }
  }

  private emitError(message: string): void {
    this.server.broadcast({ type: "error", payload: { message } })
  }

  private resolveServerUrl(): string {
    const raw = typeof this.serverUrlSource === "function"
      ? this.serverUrlSource()
      : this.serverUrlSource

    if (!raw || !raw.trim()) {
      throw new Error("OpenCode server URL is unavailable for this plugin instance")
    }

    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`OpenCode server URL is invalid: ${raw}`)
    }

    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.port === "0") {
      throw new Error(`OpenCode server URL is invalid: ${raw}`)
    }

    return parsed.origin
  }

  private getClient(directory?: string, serverUrl?: string) {
    return createV2Client(serverUrl || this.resolveServerUrl(), directory || this.worktreeDir)
  }

  private async tryDeleteSession(
    client: any,
    sessionId: string | null,
    context: "normal" | "review",
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    if (!sessionId) return false
    try {
      await client.session.delete({ path: { id: sessionId } })
      appendDebugLog("info", "session auto-deleted", { context, sessionId, ...metadata })
      return true
    } catch (err) {
      appendDebugLog("warn", "session auto-delete failed", {
        context,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        ...metadata,
      })
      return false
    }
  }

  preflightStartError(taskId?: string): string | null {
    if (this.running) {
      return "Already executing"
    }

    let executionTasks: Task[] = []
    try {
      executionTasks = resolveExecutionTasks(this.db.getTasks(), taskId)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }

    if (executionTasks.length === 0) {
      return "No tasks in backlog"
    }

    try {
      this.resolveServerUrl()
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }

    return null
  }

  private async createWorktree(name: string): Promise<any> {
    const client = this.getClient()
    const response = await client.worktree.create({
      worktreeCreateInput: { name },
    })
    if (response.error) {
      const error = response.error as any
      throw new Error(`Worktree creation failed: ${error?.message ?? JSON.stringify(error)}`)
    }
    return response.data
  }

  private async removeWorktree(directory: string): Promise<void> {
    const client = this.getClient()
    const response = await client.worktree.remove({
      worktreeRemoveInput: { directory },
    })
    if (response.error) {
      const error = response.error as any
      throw new Error(`Worktree removal failed: ${error?.message ?? JSON.stringify(error)}`)
    }
  }

  private async getProviderCatalog(client: any): Promise<any> {
    if (this.providerCatalog) return this.providerCatalog

    // Retry with exponential backoff - OpenCode server may be initializing
    const maxRetries = 3
    let lastError: unknown

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await client.config.providers()
        this.providerCatalog = unwrapResponseDataOrThrow<any>(response, "Provider discovery")
        return this.providerCatalog
      } catch (err) {
        lastError = err
        // Wait before retrying (exponential backoff: 1000ms, 2000ms, 4000ms)
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
        }
      }
    }

    // All retries failed
    const msg = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`Failed to fetch provider catalog after ${maxRetries} attempts: ${msg}`)
  }

  private async resolveModelSelection(rawModel: string | null, client: any, context: string): Promise<{ providerID: string; modelID: string } | undefined> {
    if (!rawModel) return undefined

    const parsed = parseModelSelection(rawModel)
    if (!parsed) {
      throw new Error(`${context} model is invalid: ${rawModel}. Expected format provider/model.`)
    }

    const catalog = await this.getProviderCatalog(client)
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

    return {
      providerID: provider.id,
      modelID: insensitive,
    }
  }

  private gitBranchExists(branch: string, directory?: string): boolean {
    const trimmed = branch.trim()
    if (!trimmed || !directory) return false

    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${trimmed}`], {
        cwd: directory,
        stdio: "ignore",
      })
      return true
    } catch {
      return false
    }
  }

  private readRemoteDefaultBranch(directory?: string): string | null {
    if (!directory) return null

    try {
      const value = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
        cwd: directory,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim()
      if (!value) return null
      return value.startsWith("origin/") ? value.slice("origin/".length) : value
    } catch {
      return null
    }
  }

  private readLocalBranches(directory?: string): string[] {
    if (!directory) return []

    try {
      const output = execFileSync("git", ["branch", "--format=%(refname:short)"], {
        cwd: directory,
        encoding: "utf-8",
        stdio: "pipe",
      })
      return output.split("\n").map((line: string) => line.trim()).filter(Boolean)
    } catch {
      return []
    }
  }

  private resolveTargetBranch(task: Task, options: Options, worktreeInfo?: any): string {
    const worktreeDirectory = typeof worktreeInfo?.directory === "string" ? worktreeInfo.directory : undefined
    const taskBranch = typeof task.branch === "string" ? task.branch.trim() : ""
    if (this.gitBranchExists(taskBranch, worktreeDirectory)) return taskBranch

    const worktreeBaseRef = typeof worktreeInfo?.baseRef === "string" ? worktreeInfo.baseRef.trim() : ""
    if (this.gitBranchExists(worktreeBaseRef, worktreeDirectory)) return worktreeBaseRef

    const optionBranch = typeof options.branch === "string" ? options.branch.trim() : ""
    if (this.gitBranchExists(optionBranch, worktreeDirectory)) return optionBranch

    const remoteDefaultBranch = this.readRemoteDefaultBranch(worktreeDirectory)
    if (this.gitBranchExists(remoteDefaultBranch || "", worktreeDirectory)) return remoteDefaultBranch!

    const worktreeBranch = typeof worktreeInfo?.branch === "string" ? worktreeInfo.branch.trim() : ""
    const localBranches = this.readLocalBranches(worktreeDirectory)
      .filter((branch) => branch !== worktreeBranch)
      .filter((branch) => !branch.startsWith("opencode/"))
    if (localBranches.length > 0) return localBranches[0]

    throw new Error("Could not determine target branch from git metadata")
  }

  private getTaskOrThrow(taskId: string, context: string, fallbackName?: string): Task {
    const currentTask = this.db.getTask(taskId)
    if (currentTask) return currentTask

    const taskLabel = fallbackName
      ? `Task "${fallbackName}" (${taskId})`
      : `Task ${taskId}`
    throw new Error(`${taskLabel} was removed while ${context}. Stop execution before modifying or deleting queued tasks.`)
  }

  private extractExecutionFailure(result: any): string | null {
    const parts = result?.parts
    if (!Array.isArray(parts)) return null

    for (const part of parts) {
      if (part?.type === "tool" && part?.state?.status === "error") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool"
        const error = typeof part.state.error === "string" ? part.state.error : JSON.stringify(part.state.error)
        return `${toolName} failed: ${error}`
      }

      if (part?.type === "retry" && part?.error) {
        return `Assistant retry failed: ${getAssistantErrorMessage(part.error)}`
      }

      if (part?.type === "step-finish" && typeof part.reason === "string") {
        const reason = part.reason.toLowerCase()
        if (reason.includes("error") || reason.includes("abort") || reason.includes("failed")) {
          return `Assistant step finished with failure reason: ${part.reason}`
        }
      }
    }

    const textFailure = this.extractTextualExecutionFailure(parts)
    if (textFailure) return textFailure

    return null
  }

  private extractTextualExecutionFailure(parts: any[]): string | null {
    const textParts = parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text.trim())
      .filter(Boolean)

    if (textParts.length === 0) return null

    const hasNonErrorToolWork = parts.some((part: any) =>
      part?.type === "tool" && part?.state?.status && part.state.status !== "error",
    )
    if (hasNonErrorToolWork) return null

    for (const text of textParts) {
      if (this.looksLikeExecutionFailureText(text)) {
        return text
      }
    }

    return null
  }

  private looksLikeExecutionFailureText(text: string): boolean {
    const normalized = text.trim().toLowerCase()
    if (!normalized) return false

    const directPatterns = [
      /requires more credits/,
      /can only afford/,
      /higher daily limit/,
      /insufficient (credits|balance)/,
      /quota exceeded/,
      /rate limit exceeded/,
      /maximum context length/,
      /context length exceeded/,
      /max[_ -]?tokens/,
      /token limit exceeded/,
    ]

    let matchCount = 0
    for (const pattern of directPatterns) {
      if (pattern.test(normalized)) matchCount++
    }

    if (matchCount >= 2) return true

    return normalized.startsWith("error:")
      || normalized.startsWith("request failed:")
      || normalized.startsWith("provider error:")
      || normalized.startsWith("assistant error:")
  }

  isExecuting() { return this.running }

  async start() {
    if (this.running) return

    const preflightError = this.preflightStartError()
    if (preflightError) {
      throw new Error(preflightError)
    }

    const initialTasks = resolveExecutionTasks(this.db.getTasks())

    if (initialTasks.length === 0) {
      throw new Error("No tasks in backlog")
    }

    this.running = true
    this.shouldStop = false
    this.providerCatalog = null
    let resolvedServerUrl = "unresolved"
    try {
      resolvedServerUrl = this.resolveServerUrl()
    } catch (resolveErr) {
      appendDebugLog("warn", "unable to resolve server URL during orchestrator start", {
        error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
      })
      // Keep unresolved marker; execution will fail with explicit error later.
    }
    appendDebugLog("info", "orchestrator starting", { taskCount: initialTasks.length, serverUrl: resolvedServerUrl })
    this.server.broadcast({ type: "execution_started", payload: {} })

    try {
      const options = this.db.getOptions()
      while (!this.shouldStop) {
        const executableTasks = resolveExecutionTasks(this.db.getTasks())
        if (executableTasks.length === 0) break

        const batches = resolveBatches(executableTasks, options.parallelTasks)

        for (const batch of batches) {
          if (this.shouldStop) break

          const settled = await Promise.allSettled(batch.map(t => this.executeTask(t, options)))
          const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
          if (rejected.length > 0) {
            this.shouldStop = true
            const firstReason = rejected[0].reason
            const message = firstReason instanceof Error ? firstReason.message : String(firstReason)
            throw new Error(message)
          }

          if (this.shouldStop) break
        }
      }

      this.server.broadcast({ type: "execution_complete", payload: {} })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      let resolvedServerUrl = "unresolved"
      try {
        resolvedServerUrl = this.resolveServerUrl()
      } catch (resolveErr) {
        appendDebugLog("warn", "unable to resolve server URL while handling execution error", {
          error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        })
        // Keep unresolved marker in logs.
      }
      appendDebugLog("error", "orchestrator execution failed", { error: msg, serverUrl: resolvedServerUrl })
      this.server.broadcast({ type: "error", payload: { message: msg } })
    } finally {
      this.running = false
      this.server.broadcast({ type: "execution_stopped", payload: {} })
    }
  }

  stop() {
    this.shouldStop = true
  }

  async startSingle(taskId: string) {
    if (this.running) return

    const preflightError = this.preflightStartError(taskId)
    if (preflightError) {
      throw new Error(preflightError)
    }

    const dependencyTasks = resolveExecutionTasks(this.db.getTasks(), taskId)
    const targetTask = this.db.getTask(taskId)
    if (!targetTask) {
      throw new Error(`Task "${taskId}" not found`)
    }

    this.running = true
    this.shouldStop = false
    this.providerCatalog = null
    let resolvedServerUrl = "unresolved"
    try {
      resolvedServerUrl = this.resolveServerUrl()
    } catch (resolveErr) {
      appendDebugLog("warn", "unable to resolve server URL during orchestrator start", {
        error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
      })
    }
    appendDebugLog("info", "orchestrator starting single task", {
      targetTaskId: taskId,
      targetTaskName: targetTask.name,
      dependencyCount: dependencyTasks.length,
      serverUrl: resolvedServerUrl,
    })
    this.server.broadcast({ type: "execution_started", payload: {} })

    try {
      const options = this.db.getOptions()
      const batches = resolveBatches(dependencyTasks, options.parallelTasks)

      for (const batch of batches) {
        if (this.shouldStop) break

        const settled = await Promise.allSettled(batch.map(t => this.executeTask(t, options)))
        const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        if (rejected.length > 0) {
          this.shouldStop = true
          const firstReason = rejected[0].reason
          const message = firstReason instanceof Error ? firstReason.message : String(firstReason)
          throw new Error(message)
        }

        if (this.shouldStop) break
      }

      this.server.broadcast({ type: "execution_complete", payload: {} })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      let resolvedServerUrl = "unresolved"
      try {
        resolvedServerUrl = this.resolveServerUrl()
      } catch (resolveErr) {
        appendDebugLog("warn", "unable to resolve server URL while handling execution error", {
          error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        })
      }
      appendDebugLog("error", "orchestrator execution failed", { error: msg, serverUrl: resolvedServerUrl })
      this.server.broadcast({ type: "error", payload: { message: msg } })
    } finally {
      this.running = false
      this.server.broadcast({ type: "execution_stopped", payload: {} })
    }
  }

  private async executeTask(task: Task, options: Options) {
    if (this.shouldStop) return

    if (task.executionStrategy === "best_of_n") {
      return this.executeBestOfNTask(task, options)
    }

    const isPlanImplementationResume = task.planmode && task.executionPhase === "implementation_pending"
    const isPlanRevisionResume = task.planmode && task.executionPhase === "plan_revision_pending"

    const planEligibility = getPlanExecutionEligibility(task)
    if (!planEligibility.ok) {
      throw new Error(`Task state is invalid: ${planEligibility.reason}`)
    }

    // Validate deps are done
    for (const depId of task.requirements) {
      const dep = this.db.getTask(depId)
      if (dep && dep.status !== "done") {
        const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
        this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
        const updated = this.db.getTask(task.id)!
        this.server.broadcast({ type: "task_updated", payload: updated })
        throw new Error(msg)
      }
    }

    // Mark executing
    this.db.updateTask(task.id, {
      status: "executing",
      errorMessage: null,
      ...(isPlanImplementationResume || isPlanRevisionResume ? {} : { agentOutput: "" }),
    })
    let currentTask = this.getTaskOrThrow(task.id, "marking the task as executing", task.name)
    let lastKnownTask: Task | null = currentTask
    this.server.broadcast({ type: "task_updated", payload: currentTask })

    let worktreeInfo: any = null
    let sessionId: string | null = null
    const resolvedServerUrl = this.resolveServerUrl()
    const client = this.getClient(undefined, resolvedServerUrl)

    try {
      // 1. Create worktree
      appendDebugLog("info", "creating worktree", { taskId: task.id, taskName: task.name, serverUrl: resolvedServerUrl })
      worktreeInfo = await this.createWorktree(`task-${task.id}`)
      if (!worktreeInfo?.directory) {
        throw new Error(`Worktree creation returned invalid response: ${JSON.stringify(worktreeInfo)}`)
      }
      this.db.updateTask(task.id, { worktreeDir: worktreeInfo.directory })
      writeRootOwnerPointerSafe(worktreeInfo.directory, this.ownerDirectory, join(this.ownerDirectory, ".opencode", "easy-workflow", "tasks.db"))
      currentTask = this.getTaskOrThrow(task.id, "saving the worktree location", task.name)
      lastKnownTask = currentTask
      this.server.broadcast({ type: "task_updated", payload: currentTask })

      // 2. Pre-execution command (using Bun shell directly)
      const command = options.command?.trim()
      if (command && worktreeInfo?.directory) {
        appendDebugLog("info", "running pre-execution command", { taskId: task.id, command })
        try {
          const proc = Bun.spawn(["sh", "-c", command], {
            cwd: worktreeInfo.directory,
            stdout: "pipe",
            stderr: "pipe",
          })
          const output = await new Response(proc.stdout).text()
          const error = await new Response(proc.stderr).text()
          const exitCode = await proc.exited
          
          if (output) {
            this.db.appendAgentOutput(task.id, `[command stdout] ${output}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[command stdout] ${output}\n` } })
          }
          if (error) {
            this.db.appendAgentOutput(task.id, `[command stderr] ${error}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[command stderr] ${error}\n` } })
          }
          if (exitCode !== 0) {
            throw new Error(`Command failed with exit code ${exitCode}`)
          }
        } catch (cmdErr) {
          const msg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr)
          appendDebugLog("error", "pre-execution command failed", { taskId: task.id, error: msg })
          this.db.appendAgentOutput(task.id, `[command error] ${msg}\n`)
          throw new Error(`Pre-execution command failed: ${msg}`)
        }
      }

      // 3. Create session
      const sessionResponse = await client.session.create({
        title: `Task: ${task.name}`,
      })
      const session = unwrapResponseDataOrThrow<any>(sessionResponse, "Session creation")
      sessionId = session?.id
      if (!sessionId) {
        throw new Error("Failed to create session: no ID returned")
      }
      const sessionUrl = buildSessionUrl(resolvedServerUrl, this.worktreeDir, sessionId)
      this.db.updateTask(task.id, { sessionId, sessionUrl })
      registerWorkflowSessionSafe(this.db, sessionId, task.id, "task", this.ownerDirectory, task.skipPermissionAsking)
      currentTask = this.getTaskOrThrow(task.id, "saving the session metadata", task.name)
      lastKnownTask = currentTask
      this.server.broadcast({ type: "task_updated", payload: currentTask })

      // 4. Determine model
      const executionModel = task.executionModel !== "default"
        ? task.executionModel
        : options.executionModel !== "default"
          ? options.executionModel
          : null

      const model = await this.resolveModelSelection(executionModel, client, "Execution")

      // 4b. Determine effective thinking level and agent
      const effectiveThinkingLevel = resolveThinkingLevel(task, options)
      const executionAgent = resolveExecutionAgent(task.skipPermissionAsking, effectiveThinkingLevel)
      if (effectiveThinkingLevel !== "default" || task.skipPermissionAsking) {
        appendDebugLog("info", "using thinking level", { taskId: task.id, level: effectiveThinkingLevel, agent: executionAgent, skipPermissionAsking: task.skipPermissionAsking })
      }

      // 5. Execute: plan mode or direct
      if (task.planmode) {
        const planModel = task.planModel !== "default"
          ? task.planModel
          : options.planModel !== "default"
            ? options.planModel
            : null

        const planModelParsed = await this.resolveModelSelection(planModel, client, "Plan")

        if (!isPlanImplementationResume && !isPlanRevisionResume) {
          appendDebugLog("info", "plan mode: sending planning prompt", { taskId: task.id })
          const planResponse = await client.session.prompt({
            sessionID: sessionId,
            agent: resolvePlanningAgent(task.skipPermissionAsking),
            model: planModelParsed,
            parts: [{ type: "text", text: `${AUTONOMY_INSTRUCTION}\n\n${task.prompt}` }],
          })
          const planResult = unwrapResponseDataOrThrow<any>(planResponse, "Planning prompt")
          const planFailure = this.extractExecutionFailure(planResult)
          if (planFailure) throw new Error(`Planning prompt failed: ${planFailure}`)
          const planOutput = this.extractTextOutput(planResult).trim()
          if (!planOutput) {
            throw new Error("Planning prompt failed: no plan output was captured")
          }
          if (planOutput) {
            this.db.appendAgentOutput(task.id, `[plan] ${planOutput}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[plan] ${planOutput}\n` } })
          }

          const shouldAutoApprovePlan = currentTask.autoApprovePlan === true
          if (shouldAutoApprovePlan) {
            this.db.updateTask(task.id, {
              awaitingPlanApproval: false,
              executionPhase: "implementation_pending",
            })
            currentTask = this.getTaskOrThrow(task.id, "transitioning auto-approved plan to implementation", task.name)
            lastKnownTask = currentTask
            this.server.broadcast({ type: "task_updated", payload: currentTask })
            appendDebugLog("info", "plan mode: plan auto-approved, continuing to implementation", { taskId: task.id })
          } else {
            const shouldDeletePausedWorktree = currentTask.deleteWorktree !== false
            if (worktreeInfo?.directory && shouldDeletePausedWorktree) {
              try {
                await this.removeWorktree(worktreeInfo.directory)
              } catch (cleanupErr) {
                appendDebugLog("warn", "plan mode worktree cleanup failed", { taskId: task.id, error: String(cleanupErr) })
              }
            }

            this.db.updateTask(task.id, {
              status: "review",
              awaitingPlanApproval: true,
              executionPhase: "plan_complete_waiting_approval",
              worktreeDir: shouldDeletePausedWorktree ? null : currentTask.worktreeDir,
            })
            currentTask = this.getTaskOrThrow(task.id, "saving the completed plan", task.name)
            lastKnownTask = currentTask
            this.server.broadcast({ type: "task_updated", payload: currentTask })
            appendDebugLog("info", "plan mode: plan complete, awaiting approval", { taskId: task.id })
            return
          }
        }

        if (isPlanRevisionResume) {
          appendDebugLog("info", "plan mode: sending revision prompt", { taskId: task.id })
          const latestRevisionRequest = getLatestTaggedOutput(task.agentOutput, "user-revision-request")
          const originalPlan = getLatestTaggedOutput(task.agentOutput, "plan")
          if (!latestRevisionRequest) {
            throw new Error("Revision prompt failed: no user revision request was captured")
          }
          if (!originalPlan) {
            throw new Error("Revision prompt failed: no captured plan output was found to revise")
          }
          const revisionPrompt = [
            AUTONOMY_INSTRUCTION,
            "",
            "The user has reviewed your plan and requested changes. Revise the plan based on their feedback.",
            `Original task:\n${task.prompt}`,
            originalPlan ? `Previous plan:\n${originalPlan}` : "",
            latestRevisionRequest ? `User feedback:\n${latestRevisionRequest}` : "",
            "Provide a revised plan that addresses the feedback. Output only the revised plan.",
          ].filter(Boolean).join("\n\n")
          const planResponse = await client.session.prompt({
            sessionID: sessionId,
            agent: resolvePlanningAgent(task.skipPermissionAsking),
            model: planModelParsed,
            parts: [{ type: "text", text: revisionPrompt }],
          })
          const planResult = unwrapResponseDataOrThrow<any>(planResponse, "Revision prompt")
          const planFailure = this.extractExecutionFailure(planResult)
          if (planFailure) throw new Error(`Revision prompt failed: ${planFailure}`)
          const revisedPlanOutput = this.extractTextOutput(planResult).trim()
          if (!revisedPlanOutput) {
            throw new Error("Revision prompt failed: no plan output was captured")
          }
          this.db.appendAgentOutput(task.id, `[plan] ${revisedPlanOutput}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[plan] ${revisedPlanOutput}\n` } })

          const shouldAutoApprovePlan = currentTask.autoApprovePlan === true
          if (shouldAutoApprovePlan) {
            this.db.updateTask(task.id, {
              awaitingPlanApproval: false,
              executionPhase: "implementation_pending",
            })
            currentTask = this.getTaskOrThrow(task.id, "transitioning revised auto-approved plan to implementation", task.name)
            lastKnownTask = currentTask
            this.server.broadcast({ type: "task_updated", payload: currentTask })
            appendDebugLog("info", "plan mode: revised plan auto-approved, continuing to implementation", { taskId: task.id })
          } else {
            const shouldDeletePausedWorktree = currentTask.deleteWorktree !== false
            if (worktreeInfo?.directory && shouldDeletePausedWorktree) {
              try {
                await this.removeWorktree(worktreeInfo.directory)
              } catch (cleanupErr) {
                appendDebugLog("warn", "plan revision worktree cleanup failed", { taskId: task.id, error: String(cleanupErr) })
              }
            }

            this.db.updateTask(task.id, {
              status: "review",
              awaitingPlanApproval: true,
              executionPhase: "plan_complete_waiting_approval",
              worktreeDir: shouldDeletePausedWorktree ? null : currentTask.worktreeDir,
            })
            currentTask = this.getTaskOrThrow(task.id, "saving the revised plan", task.name)
            lastKnownTask = currentTask
            this.server.broadcast({ type: "task_updated", payload: currentTask })
            appendDebugLog("info", "plan mode: revision complete, awaiting approval", { taskId: task.id })
            return
          }
        }

        appendDebugLog("info", "plan mode: sending execution prompt", { taskId: task.id })
        const executionTaskState = this.getTaskOrThrow(task.id, "loading approved plan context", task.name)
        const approvedPlanContext = getLatestTaggedOutput(executionTaskState.agentOutput, "plan")
        if (!approvedPlanContext) {
          throw new Error("Execution prompt failed: no approved [plan] block was captured")
        }
        const userApprovalNote = getLatestTaggedOutput(executionTaskState.agentOutput, "user-approval-note")
        const revisionRequests = executionTaskState.agentOutput
          .match(/\[user-revision-request\]\s*[\s\S]*?(?=\n\[[a-z0-9-]+\]|$)/g)?.map((entry) => entry.replace(/^\[user-revision-request\]\s*/, "").trim()).filter(Boolean) ?? []
        const allUserGuidance = [
          ...revisionRequests.map((r, i) => `Revision request ${i + 1}:\n${r}`),
          userApprovalNote ? `Final approval note:\n${userApprovalNote}` : "",
        ].filter(Boolean).join("\n\n")
        const execPromptOpts: any = {
          sessionID: sessionId,
          model,
          parts: [{
            type: "text",
            text: [
              AUTONOMY_INSTRUCTION,
              "",
              "The user has approved the plan below. Implement it now.",
              `Original task:\n${task.prompt}`,
              approvedPlanContext ? `Approved plan:\n${approvedPlanContext}` : "",
              allUserGuidance ? `User guidance:\n${allUserGuidance}` : "",
            ].filter(Boolean).join("\n\n"),
          }],
        }
        if (executionAgent) execPromptOpts.agent = executionAgent
        let execResult: any
        try {
          const execResponse = await client.session.prompt(execPromptOpts)
          execResult = unwrapResponseDataOrThrow<any>(execResponse, "Execution prompt")
        } catch (promptErr) {
          throw remapThinkingAgentError(promptErr, executionAgent)
        }
        const execFailure = this.extractExecutionFailure(execResult)
        if (execFailure) throw remapThinkingAgentError(new Error(`Execution prompt failed: ${execFailure}`), executionAgent)
        const execOutput = this.extractTextOutput(execResult)
        if (execOutput) {
          this.db.appendAgentOutput(task.id, `[exec] ${execOutput}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `[exec] ${execOutput}\n` } })
        }

        // Mark implementation as done
        this.db.updateTask(task.id, { executionPhase: "implementation_done" })
      } else {
        // Direct execution
        appendDebugLog("info", "sending task prompt", { taskId: task.id })
        const promptOpts: any = {
          sessionID: sessionId,
          model,
          parts: [{ type: "text", text: `${AUTONOMY_INSTRUCTION}\n\n${task.prompt}` }],
        }
        if (executionAgent) promptOpts.agent = executionAgent
        let result: any
        try {
          const response = await client.session.prompt(promptOpts)
          result = unwrapResponseDataOrThrow<any>(response, "Task prompt")
        } catch (promptErr) {
          throw remapThinkingAgentError(promptErr, executionAgent)
        }
        const taskFailure = this.extractExecutionFailure(result)
        if (taskFailure) throw remapThinkingAgentError(new Error(`Task prompt failed: ${taskFailure}`), executionAgent)
        const output = this.extractTextOutput(result)
        if (output) {
          this.db.appendAgentOutput(task.id, output)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output } })
        }
      }

      // Refresh task state
      currentTask = this.getTaskOrThrow(task.id, "refreshing task state after execution", task.name)
      lastKnownTask = currentTask
      // 6. Review loop
      if (currentTask.review) {
        const reviewConfig = loadReviewConfig()
        await this.runReviewLoop(currentTask, sessionId, reviewConfig, options)
        currentTask = this.getTaskOrThrow(task.id, "refreshing task state after review", task.name)
        lastKnownTask = currentTask
        if (currentTask.status === "stuck") {
          // Task is stuck - halt pipeline
          this.shouldStop = true
          return
        }
      }

      // 7. Commit via agent prompt (if enabled)
      if (currentTask.autoCommit && worktreeInfo) {
        try {
          appendDebugLog("info", "sending commit prompt to agent", { taskId: task.id })
          const baseRef = this.resolveTargetBranch(currentTask, options, worktreeInfo)
          let commitPromptText = options.commitPrompt.replace(/\{\{base_ref\}\}/g, baseRef)
          if (!currentTask.deleteWorktree) {
            commitPromptText += "\n\nImportant: do NOT delete the worktree at the end; keep it for manual follow-up."
          }
          
          const commitResponse = await client.session.prompt({
            sessionID: sessionId,
            parts: [{ type: "text", text: commitPromptText }],
          })
          const commitResult = unwrapResponseDataOrThrow<any>(commitResponse, "Commit prompt")
          const commitFailure = this.extractExecutionFailure(commitResult)
          if (commitFailure) throw new Error(`Commit prompt failed: ${commitFailure}`)
          const commitOutput = this.extractTextOutput(commitResult)
          if (commitOutput) {
            this.db.appendAgentOutput(task.id, `\n[commit] ${commitOutput}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[commit] ${commitOutput}\n` } })
          }
          appendDebugLog("info", "commit prompt completed", { taskId: task.id })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          appendDebugLog("error", "commit prompt failed", { taskId: task.id, error: message })
          this.db.appendAgentOutput(task.id, `\n[commit error] ${message}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[commit error] ${message}\n` } })
          throw new Error(`Commit prompt failed: ${message}`)
        }
      }

      // 8. Merge worktree
      if (worktreeInfo) {
        try {
          appendDebugLog("info", "merging worktree", { taskId: task.id, branch: worktreeInfo.branch })

          // Resolve merge target branch from task/options first, then git defaults.
          let mainBranch = this.resolveTargetBranch(currentTask, options, worktreeInfo)
          let hasTargetBranch = false
          if (mainBranch) {
            try {
              execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${mainBranch}`], {
                cwd: worktreeInfo.directory,
                stdio: "ignore",
              })
              hasTargetBranch = true
            } catch (showRefErr) {
              appendDebugLog("warn", "target branch lookup failed before fallback", {
                taskId: task.id,
                branch: mainBranch,
                error: showRefErr instanceof Error ? showRefErr.message : String(showRefErr),
              })
              hasTargetBranch = false
            }
          }

          if (!hasTargetBranch) {
            try {
              const defaultBranch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
                cwd: worktreeInfo.directory,
                encoding: "utf-8",
                stdio: "pipe",
              }).trim()
              if (defaultBranch.startsWith("origin/")) {
                mainBranch = defaultBranch.slice("origin/".length)
              } else if (defaultBranch) {
                mainBranch = defaultBranch
              }
            } catch (e) {
              appendDebugLog("warn", "could not resolve origin HEAD for merge target", {
                taskId: task.id,
                error: e instanceof Error ? e.message : String(e),
              })
            }

            if (!mainBranch) {
              try {
                mainBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                  cwd: worktreeInfo.directory,
                  encoding: "utf-8",
                  stdio: "pipe",
                }).trim()
              } catch (e) {
                throw new Error(`Failed to get current branch: ${e}`);
              }
            }
          }

          try {
            execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${mainBranch}`], {
              cwd: worktreeInfo.directory,
              stdio: "ignore",
            })
          } catch (e) {
            throw new Error(`Branch ${mainBranch} does not exist: ${e}`);
          }

          appendDebugLog("info", "merge target branch selected", { taskId: task.id, mainBranch })
          try {
            execFileSync("git", ["checkout", mainBranch], { cwd: worktreeInfo.directory, stdio: "ignore" })
          } catch (checkoutErr) {
            appendDebugLog("warn", "branch checkout skipped before merge", {
              taskId: task.id,
              branch: mainBranch,
              error: checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr),
            })
            // Branch may be checked out in another worktree.
          }
          execFileSync("git", ["merge", worktreeInfo.branch, "--no-edit"], {
            cwd: worktreeInfo.directory,
            encoding: "utf-8",
            stdio: "pipe",
          })
        } catch (mergeErr) {
          const msg = `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`
          throw new Error(msg)
        }
      }

      // 9. Delete worktree
      const shouldDeleteWorktree = currentTask.deleteWorktree !== false
      if (worktreeInfo?.directory && shouldDeleteWorktree) {
        try {
          await this.removeWorktree(worktreeInfo.directory)
        } catch (e) {
          appendDebugLog("warn", "worktree cleanup failed", { taskId: task.id, error: String(e) })
        }
      }

      // 10. Mark done
      const now = Math.floor(Date.now() / 1000)
      this.db.updateTask(task.id, {
        status: "done",
        completedAt: now,
        worktreeDir: shouldDeleteWorktree ? null : (worktreeInfo?.directory ?? currentTask.worktreeDir),
      })
      const doneTask = this.getTaskOrThrow(task.id, "marking the task as done", task.name)
      this.server.broadcast({ type: "task_updated", payload: doneTask })
      appendDebugLog("info", "task completed", { taskId: task.id, taskName: task.name })

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const contextMsg = msg.includes("fetch") || msg.includes("connect") || msg.includes("ECONNREFUSED")
        ? `${msg} (opencode server: ${resolvedServerUrl})`
        : msg
      appendDebugLog("error", "task execution failed", { taskId: task.id, error: contextMsg, serverUrl: resolvedServerUrl })
      const failedTask = this.db.updateTask(task.id, { status: "failed", errorMessage: contextMsg })
      if (failedTask) {
        lastKnownTask = failedTask
        this.server.broadcast({ type: "task_updated", payload: failedTask })
      } else {
        appendDebugLog("warn", "failed task record missing during error handling", { taskId: task.id })
      }
      this.server.broadcast({ type: "error", payload: { message: `Task \"${task.name}\" failed: ${contextMsg}` } })

      // Cleanup worktree on failure
      if (worktreeInfo?.directory && lastKnownTask?.deleteWorktree !== false) {
        try {
          await this.removeWorktree(worktreeInfo.directory)
        } catch (cleanupErr) {
          appendDebugLog("warn", "worktree cleanup on failure failed", {
            taskId: task.id,
            directory: worktreeInfo.directory,
            error: String(cleanupErr),
          })
        }
      }

      throw err
    } finally {
      if (options.autoDeleteNormalSessions && sessionId) {
        const deleted = await this.tryDeleteSession(client, sessionId, "normal", { taskId: task.id, taskName: task.name })
        if (deleted) {
          const clearedTask = this.db.updateTask(task.id, { sessionId: null, sessionUrl: null })
          if (clearedTask) {
            this.server.broadcast({ type: "task_updated", payload: clearedTask })
          }
        }
      }
    }
  }

  private async executeBestOfNTask(task: Task, options: Options) {
    if (this.shouldStop) return
    const resolvedServerUrl = this.resolveServerUrl()

    try {
      if (!task.bestOfNConfig) {
        throw new Error(`Task ${task.id} has best_of_n execution strategy but no bestOfNConfig`)
      }

      const config = task.bestOfNConfig

      for (const depId of task.requirements) {
        const dep = this.db.getTask(depId)
        if (dep && dep.status !== "done") {
          const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
          this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          throw new Error(msg)
        }
      }

      this.db.updateTask(task.id, {
        status: "executing",
        bestOfNSubstage: "workers_running",
        errorMessage: null,
        agentOutput: "",
      })
      const currentTask = this.getTaskOrThrow(task.id, "marking best-of-n task as executing", task.name)
      this.server.broadcast({ type: "task_updated", payload: currentTask })

      appendDebugLog("info", "starting best-of-n execution", { taskId: task.id, config })

      const workerRuns = this.expandBestOfNSlots(config.workers)
      for (const worker of workerRuns) {
        if (this.shouldStop) return
        const run = this.db.createTaskRun({
          taskId: task.id,
          phase: "worker",
          slotIndex: worker.slotIndex,
          attemptIndex: worker.attemptIndex,
          model: worker.model,
          taskSuffix: worker.taskSuffix ?? null,
          status: "pending",
        })
        this.server.broadcast({ type: "task_run_created", payload: run })
      }

      const runResult = await this.runBestOfNWorkers(task, options, resolvedServerUrl)
      if (runResult.shouldStop) {
        this.shouldStop = true
        return
      }

      const successfulWorkers = this.db.getTaskRunsByPhase(task.id, "worker").filter(w => w.status === "done")
      if (successfulWorkers.length < config.minSuccessfulWorkers) {
        const msg = `Best-of-n failed: only ${successfulWorkers.length} workers succeeded, but ${config.minSuccessfulWorkers} minimum required`
        this.db.updateTask(task.id, { status: "failed", bestOfNSubstage: "idle", errorMessage: msg })
        const updated = this.db.getTask(task.id)!
        this.server.broadcast({ type: "task_updated", payload: updated })
        this.emitError(`Task "${task.name}" failed: ${msg}`)
        appendDebugLog("error", "best-of-n workers failed threshold", { taskId: task.id, successful: successfulWorkers.length, required: config.minSuccessfulWorkers })
        this.shouldStop = true
        return
      }

      const candidates = this.db.getTaskCandidates(task.id)
      appendDebugLog("info", "best-of-n workers completed", { taskId: task.id, successfulWorkers: successfulWorkers.length, candidates: candidates.length })

      let reviewerResult: { halt: boolean; routeToReview?: boolean; error?: string; usableResults: ReviewerOutput[] } = {
        halt: false,
        usableResults: [],
      }

      if (config.reviewers.length > 0) {
        this.db.updateTask(task.id, { bestOfNSubstage: "reviewers_running" })
        const reviewerRuns = this.expandBestOfNSlots(config.reviewers)
        for (const reviewer of reviewerRuns) {
          if (this.shouldStop) return
          const run = this.db.createTaskRun({
            taskId: task.id,
            phase: "reviewer",
            slotIndex: reviewer.slotIndex,
            attemptIndex: reviewer.attemptIndex,
            model: reviewer.model,
            taskSuffix: reviewer.taskSuffix ?? null,
            status: "pending",
          })
          this.server.broadcast({ type: "task_run_created", payload: run })
        }

        reviewerResult = await this.runBestOfNReviewers(task, candidates, options, resolvedServerUrl)
        if (reviewerResult.halt) {
          if (reviewerResult.routeToReview) {
            this.db.updateTask(task.id, { status: "review", bestOfNSubstage: "blocked_for_manual_review", errorMessage: reviewerResult.error ?? null })
            const updated = this.db.getTask(task.id)!
            this.server.broadcast({ type: "task_updated", payload: updated })
            this.emitError(`Task "${task.name}" requires manual review: ${reviewerResult.error ?? "reviewer consensus was insufficient"}`)
          } else {
            this.db.updateTask(task.id, { status: "failed", bestOfNSubstage: "idle", errorMessage: reviewerResult.error })
            const updated = this.db.getTask(task.id)!
            this.server.broadcast({ type: "task_updated", payload: updated })
            this.emitError(`Task "${task.name}" failed: ${reviewerResult.error ?? "reviewer phase failed"}`)
          }
          this.shouldStop = true
          return
        }
      }

      const aggregatedReview = this.aggregateReviewerResults(reviewerResult.usableResults)
      const reviewerRequestedManual = reviewerResult.usableResults.some((result) => result.status === "needs_manual_review")

      if (config.reviewers.length > 0 && (reviewerRequestedManual || (!aggregatedReview.consensusReached && config.selectionMode === "pick_best"))) {
        const reason = reviewerRequestedManual
          ? "One or more reviewers requested manual review"
          : "Reviewers did not reach consensus for pick_best mode"
        this.db.updateTask(task.id, {
          status: "review",
          bestOfNSubstage: "blocked_for_manual_review",
          errorMessage: reason,
        })
        const updated = this.db.getTask(task.id)!
        this.server.broadcast({ type: "task_updated", payload: updated })
        this.emitError(`Task "${task.name}" requires manual review: ${reason}`)
        this.shouldStop = true
        return
      }

      this.db.updateTask(task.id, { bestOfNSubstage: "final_apply_running" })
      const finalApplierRun = this.db.createTaskRun({
        taskId: task.id,
        phase: "final_applier",
        slotIndex: 0,
        attemptIndex: 0,
        model: config.finalApplier.model,
        taskSuffix: config.finalApplier.taskSuffix ?? null,
        status: "pending",
      })
      this.server.broadcast({ type: "task_run_created", payload: finalApplierRun })

      const finalResult = await this.runBestOfNFinalApplier(task, candidates, aggregatedReview, config.selectionMode, options, resolvedServerUrl)
      if (finalResult.failed) {
        if (finalResult.routeToReview) {
          this.db.updateTask(task.id, { status: "review", bestOfNSubstage: "blocked_for_manual_review", errorMessage: finalResult.error })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          this.emitError(`Task "${task.name}" requires manual review: ${finalResult.error ?? "final applier outcome was ambiguous"}`)
        } else {
          this.db.updateTask(task.id, { status: "failed", bestOfNSubstage: "idle", errorMessage: finalResult.error })
          const updated = this.db.getTask(task.id)!
          this.server.broadcast({ type: "task_updated", payload: updated })
          this.emitError(`Task "${task.name}" failed: ${finalResult.error ?? "final applier failed"}`)
        }
        this.shouldStop = true
        return
      }

      const now = Math.floor(Date.now() / 1000)
      this.db.updateTask(task.id, {
        status: "done",
        bestOfNSubstage: "completed",
        completedAt: now,
      })
      const doneTask = this.db.getTask(task.id)!
      this.server.broadcast({ type: "task_updated", payload: doneTask })
      appendDebugLog("info", "best-of-n task completed", { taskId: task.id })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendDebugLog("error", "best-of-n task execution failed", { taskId: task.id, error: msg })
      const failedTask = this.db.updateTask(task.id, {
        status: "failed",
        bestOfNSubstage: "idle",
        errorMessage: msg,
      })
      if (failedTask) {
        this.server.broadcast({ type: "task_updated", payload: failedTask })
      }
      this.emitError(`Task "${task.name}" failed: ${msg}`)
      this.shouldStop = true
      throw err
    }
  }

  private expandBestOfNSlots(slots: BestOfNSlot[]): { model: string; taskSuffix?: string; slotIndex: number; attemptIndex: number }[] {
    const expanded: { model: string; taskSuffix?: string; slotIndex: number; attemptIndex: number }[] = []
    let globalSlotIdx = 0
    for (const slot of slots) {
      for (let i = 0; i < slot.count; i++) {
        expanded.push({
          model: slot.model,
          taskSuffix: slot.taskSuffix,
          slotIndex: globalSlotIdx,
          attemptIndex: i,
        })
        globalSlotIdx++
      }
    }
    return expanded
  }

  private async runBestOfNWorkers(task: Task, options: Options, serverUrl: string): Promise<{ shouldStop: boolean }> {
    const workers = this.db.getTaskRunsByPhase(task.id, "worker")
    const client = this.getClient(undefined, serverUrl)

    const pendingWorkers = workers.filter(w => w.status === "pending")
    await Promise.all(pendingWorkers.map(async (workerRun) => {
      if (this.shouldStop) return
      let sessionId: string | null = null
      try {
        this.db.updateTaskRun(workerRun.id, { status: "running" })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(workerRun.id) })

        const worktreeInfo = await this.createWorktree(`bon-worker-${workerRun.id}`)
        if (!worktreeInfo?.directory) {
          throw new Error(`Worktree creation failed for worker ${workerRun.id}`)
        }

        this.db.updateTaskRun(workerRun.id, { worktreeDir: worktreeInfo.directory, status: "running" })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(workerRun.id) })

        const sessionResponse = await client.session.create({ title: `Worker: ${task.name} (slot ${workerRun.slotIndex})` })
        const session = unwrapResponseDataOrThrow<any>(sessionResponse, "Worker session creation")
        sessionId = session?.id
        if (!sessionId) throw new Error("Failed to create worker session")

        const sessionUrl = buildSessionUrl(serverUrl, this.worktreeDir, sessionId)
        this.db.updateTaskRun(workerRun.id, { sessionId, sessionUrl })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(workerRun.id) })

        registerWorkflowSessionSafe(this.db, sessionId, task.id, "task_run_worker", this.ownerDirectory, task.skipPermissionAsking, workerRun.id)
        writeRootOwnerPointerSafe(worktreeInfo.directory, this.ownerDirectory, join(this.ownerDirectory, ".opencode", "easy-workflow", "tasks.db"))

        const workerPrompt = this.buildWorkerPrompt(task.prompt, workerRun.taskSuffix)
        const model = await this.resolveModelSelection(workerRun.model, client, "Worker")

        appendDebugLog("info", "running best-of-n worker", { taskId: task.id, workerRunId: workerRun.id, model: workerRun.model })

        const promptOpts: any = {
          sessionID: sessionId,
          model,
          parts: [{ type: "text", text: workerPrompt }],
        }
        const effectiveThinkingLevel = resolveThinkingLevel(task, options)
        const executionAgent = resolveExecutionAgent(task.skipPermissionAsking, effectiveThinkingLevel)
        if (executionAgent) promptOpts.agent = executionAgent

        let result: any
        try {
          const response = await client.session.prompt(promptOpts)
          result = unwrapResponseDataOrThrow<any>(response, "Worker prompt")
        } catch (promptErr) {
          throw remapThinkingAgentError(promptErr, executionAgent)
        }

        const failure = this.extractExecutionFailure(result)
        if (failure) throw remapThinkingAgentError(new Error(`Worker prompt failed: ${failure}`), executionAgent)

        const output = this.extractTextOutput(result)
        if (output) {
          this.db.appendAgentOutput(task.id, `\n[worker-${workerRun.slotIndex}] ${output}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[worker-${workerRun.slotIndex}] ${output}\n` } })
        }

        const verificationJson = await this.runVerificationCommand(
          task,
          `worker-${workerRun.slotIndex}`,
          worktreeInfo.directory,
          task.bestOfNConfig?.verificationCommand,
        )

        let candidateInput: ReturnType<Orchestrator["collectCandidateArtifacts"]>
        try {
          candidateInput = this.collectCandidateArtifacts(task, workerRun, output, worktreeInfo.directory, verificationJson)
        } catch (artifactErr) {
          const artifactErrorMessage = artifactErr instanceof Error ? artifactErr.message : String(artifactErr)
          appendDebugLog("warn", "failed to collect worker diff artifacts", {
            taskId: task.id,
            workerRunId: workerRun.id,
            error: artifactErrorMessage,
          })
          this.emitError(`Could not collect worker diff artifacts for task "${task.name}" (run ${workerRun.id}): ${artifactErrorMessage}`)
          const fallbackChangedFiles = this.extractChangedFiles(output)
          candidateInput = {
            taskId: task.id,
            workerRunId: workerRun.id,
            status: "available",
            changedFiles: fallbackChangedFiles,
            diffStats: this.computeFallbackDiffStats(fallbackChangedFiles),
            verificationJson: {
              ...verificationJson,
              artifactCollectionError: artifactErrorMessage,
            },
            summary: output.substring(0, 1000),
            errorMessage: null,
          }
        }

        const candidate = this.db.createTaskCandidate(candidateInput)
        this.server.broadcast({ type: "task_candidate_created", payload: candidate })

        const now = Math.floor(Date.now() / 1000)
        this.db.updateTaskRun(workerRun.id, {
          status: "done",
          summary: output.substring(0, 500),
          candidateId: candidate.id,
          metadataJson: {
            verificationJson,
          },
          completedAt: now,
        })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(workerRun.id) })

        if (task.deleteWorktree !== false && worktreeInfo?.directory) {
          try {
            await this.removeWorktree(worktreeInfo.directory)
          } catch (cleanupErr) {
            const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
            appendDebugLog("warn", "worker worktree cleanup failed", { taskId: task.id, workerRunId: workerRun.id, error: cleanupMessage })
            this.emitError(`Worker cleanup failed for task "${task.name}" (run ${workerRun.id}): ${cleanupMessage}. Worktree preserved at ${worktreeInfo.directory}.`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendDebugLog("error", "best-of-n worker failed", { taskId: task.id, workerRunId: workerRun.id, error: msg })
        const now = Math.floor(Date.now() / 1000)
        this.db.updateTaskRun(workerRun.id, { status: "failed", errorMessage: msg, completedAt: now })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(workerRun.id) })
        this.emitError(`Worker run failed for task "${task.name}" (run ${workerRun.id}): ${msg}`)
      } finally {
        if (options.autoDeleteNormalSessions && sessionId) {
          const deleted = await this.tryDeleteSession(client, sessionId, "normal", { taskId: task.id, taskRunId: workerRun.id, phase: "worker" })
          if (deleted) {
            this.db.updateTaskRun(workerRun.id, { sessionId: null, sessionUrl: null })
            this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(workerRun.id) })
          }
        }
      }
    }))

    return { shouldStop: this.shouldStop }
  }

  private buildWorkerPrompt(taskPrompt: string, taskSuffix: string | null): string {
    let prompt = `${AUTONOMY_INSTRUCTION}

You are one candidate implementation worker in a best-of-n workflow.
Produce the best complete solution you can in this worktree.

Task:
${taskPrompt}
`
    if (taskSuffix) {
      prompt += `\nAdditional instructions for this worker:
${taskSuffix}`
    }
    return prompt
  }

  private collectCandidateArtifacts(
    task: Task,
    workerRun: TaskRun,
    output: string,
    worktreeDir: string,
    verificationJson: Record<string, any>,
  ): {
    taskId: string
    workerRunId: string
    status: "available"
    changedFiles: string[]
    diffStats: Record<string, number>
    verificationJson: Record<string, any>
    summary: string | null
    errorMessage: string | null
  } {
    const artifacts = this.collectWorktreeDiffArtifacts(worktreeDir)
    const changedFiles = artifacts.changedFiles.length > 0 ? artifacts.changedFiles : this.extractChangedFiles(output)
    const diffStats = Object.keys(artifacts.diffStats).length > 0
      ? artifacts.diffStats
      : this.computeFallbackDiffStats(changedFiles)

    return {
      taskId: task.id,
      workerRunId: workerRun.id,
      status: "available",
      changedFiles,
      diffStats,
      verificationJson,
      summary: output.substring(0, 1000),
      errorMessage: null,
    }
  }

  private extractChangedFiles(output: string): string[] {
    const files: string[] = []
    const patterns = [
      /^[AMDRC]\s+(.+)$/gm,
      /^[\d]+\s+[\d]+\s+(.+)$/gm,
      /file[s]?:\s*(.+)/gi,
    ]
    for (const pattern of patterns) {
      const matches = output.matchAll(pattern)
      for (const match of matches) {
        const file = match[1]?.trim()
        if (file && !files.includes(file)) {
          files.push(file)
        }
      }
    }
    return files
  }

  private computeFallbackDiffStats(files: string[]): Record<string, number> {
    const stats: Record<string, number> = {}
    for (const file of files) {
      stats[file] = 0
    }
    return stats
  }

  private collectWorktreeDiffArtifacts(worktreeDir: string): { changedFiles: string[]; diffStats: Record<string, number> } {
    const changedFiles = this.collectChangedFilesFromGit(worktreeDir)
    const diffStats = this.collectDiffStatsFromGit(worktreeDir)
    return { changedFiles, diffStats }
  }

  private collectChangedFilesFromGit(worktreeDir: string): string[] {
    const result = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: worktreeDir,
      stdout: "pipe",
      stderr: "pipe",
    })

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(`Failed to collect changed files: ${stderr || `git exited with code ${result.exitCode}`}`)
    }

    const lines = result.stdout.toString().split("\n").map((line) => line.trimEnd()).filter(Boolean)
    const files: string[] = []

    for (const line of lines) {
      if (line.length < 3) continue
      const rawPath = line.slice(3).trim()
      if (!rawPath) continue
      const normalizedPath = rawPath.includes(" -> ")
        ? rawPath.split(" -> ").pop()!.trim()
        : rawPath
      if (normalizedPath && !files.includes(normalizedPath)) {
        files.push(normalizedPath)
      }
    }

    return files
  }

  private collectDiffStatsFromGit(worktreeDir: string): Record<string, number> {
    const stats = new Map<string, number>()
    for (const args of [["diff", "--numstat"], ["diff", "--numstat", "--cached"]]) {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: worktreeDir,
        stdout: "pipe",
        stderr: "pipe",
      })

      if (result.exitCode !== 0) {
        const stderr = result.stderr.toString().trim()
        throw new Error(`Failed to collect diff stats: ${stderr || `git exited with code ${result.exitCode}`}`)
      }

      const lines = result.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean)
      for (const line of lines) {
        const [insertionsRaw, deletionsRaw, filePath] = line.split("\t")
        if (!filePath) continue
        const insertions = Number.isFinite(Number(insertionsRaw)) ? Number(insertionsRaw) : 0
        const deletions = Number.isFinite(Number(deletionsRaw)) ? Number(deletionsRaw) : 0
        const total = insertions + deletions
        stats.set(filePath, (stats.get(filePath) || 0) + total)
      }
    }

    return Object.fromEntries(stats.entries())
  }

  private async runVerificationCommand(
    task: Task,
    label: string,
    worktreeDir: string,
    verificationCommand?: string,
  ): Promise<Record<string, any>> {
    const command = verificationCommand?.trim()
    if (!command) {
      return { status: "skipped", reason: "No verification command configured" }
    }

    appendDebugLog("info", "running verification command", { taskId: task.id, label, command })
    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd: worktreeDir,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      const status = exitCode === 0 ? "passed" : "failed"
      const output = [`\n[verification ${label}] status=${status} exitCode=${exitCode}`]
      if (stdout.trim()) output.push(`[verification stdout]\n${stdout.trim()}`)
      if (stderr.trim()) output.push(`[verification stderr]\n${stderr.trim()}`)
      output.push("")
      const combinedOutput = `${output.join("\n")}\n`
      this.db.appendAgentOutput(task.id, combinedOutput)
      this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: combinedOutput } })

      if (exitCode !== 0) {
        this.emitError(`Verification failed for task "${task.name}" (${label}) with exit code ${exitCode}.`)
      }

      return {
        status,
        exitCode,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 8000),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitError(`Verification command error for task "${task.name}" (${label}): ${msg}`)
      return { status: "error", message: msg }
    }
  }

  private async runBestOfNReviewers(task: Task, candidates: TaskCandidate[], options: Options, serverUrl: string): Promise<{ halt: boolean; routeToReview?: boolean; error?: string; usableResults: ReviewerOutput[] }> {
    const reviewers = this.db.getTaskRunsByPhase(task.id, "reviewer")
    const client = this.getClient(undefined, serverUrl)

    const pendingReviewers = reviewers.filter(r => r.status === "pending")
    await Promise.all(pendingReviewers.map(async (reviewerRun) => {
      if (this.shouldStop) return
      let sessionId: string | null = null
      try {
        this.db.updateTaskRun(reviewerRun.id, { status: "running" })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(reviewerRun.id) })

        const sessionResponse = await client.session.create({ title: `Reviewer: ${task.name} (slot ${reviewerRun.slotIndex})` })
        const session = unwrapResponseDataOrThrow<any>(sessionResponse, "Reviewer session creation")
        sessionId = session?.id
        if (!sessionId) throw new Error("Failed to create reviewer session")

        const sessionUrl = buildSessionUrl(serverUrl, this.worktreeDir, sessionId)
        this.db.updateTaskRun(reviewerRun.id, { sessionId, sessionUrl })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(reviewerRun.id) })

        registerWorkflowSessionSafe(this.db, sessionId, task.id, "task_run_reviewer", this.ownerDirectory, task.skipPermissionAsking, reviewerRun.id)

        const reviewerPrompt = this.buildReviewerPrompt(task.prompt, candidates, reviewerRun.taskSuffix)
        const model = await this.resolveModelSelection(reviewerRun.model, client, "Reviewer")

        appendDebugLog("info", "running best-of-n reviewer", { taskId: task.id, reviewerRunId: reviewerRun.id, model: reviewerRun.model })

        const response = await client.session.prompt({
          sessionID: sessionId,
          model,
          parts: [{ type: "text", text: reviewerPrompt }],
        })
        const result = unwrapResponseDataOrThrow<any>(response, "Reviewer prompt")
        const failure = this.extractExecutionFailure(result)
        if (failure) throw new Error(`Reviewer prompt failed: ${failure}`)

        const output = this.extractTextOutput(result)
        const reviewerOutput = this.parseReviewerOutput(output)

        const now = Math.floor(Date.now() / 1000)
        this.db.updateTaskRun(reviewerRun.id, {
          status: "done",
          summary: output.substring(0, 500),
          metadataJson: { reviewerOutput },
          completedAt: now,
        })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(reviewerRun.id) })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendDebugLog("error", "best-of-n reviewer failed", { taskId: task.id, reviewerRunId: reviewerRun.id, error: msg })
        const now = Math.floor(Date.now() / 1000)
        this.db.updateTaskRun(reviewerRun.id, { status: "failed", errorMessage: msg, completedAt: now })
        this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(reviewerRun.id) })
        this.emitError(`Reviewer run failed for task "${task.name}" (run ${reviewerRun.id}): ${msg}`)
      } finally {
        if (options.autoDeleteReviewSessions && sessionId) {
          const deleted = await this.tryDeleteSession(client, sessionId, "review", { taskId: task.id, taskRunId: reviewerRun.id, phase: "reviewer" })
          if (deleted) {
            this.db.updateTaskRun(reviewerRun.id, { sessionId: null, sessionUrl: null })
            this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(reviewerRun.id) })
          }
        }
      }
    }))

    const usableResults = this.collectUsableReviewerResults(task.id)
    if (usableResults.length === 0) {
      return { halt: true, routeToReview: true, error: "No usable reviewer results - route to manual review", usableResults }
    }

    return { halt: false, usableResults }
  }

  private stringifyVerificationSummary(verificationJson: Record<string, any>): string {
    if (!verificationJson || typeof verificationJson !== "object") {
      return "No verification data"
    }
    if (typeof verificationJson.status === "string") {
      const status = verificationJson.status
      const exitCode = typeof verificationJson.exitCode === "number" ? ` (exit ${verificationJson.exitCode})` : ""
      return `${status}${exitCode}`
    }
    return JSON.stringify(verificationJson)
  }

  private buildReviewerPrompt(taskPrompt: string, candidates: TaskCandidate[], taskSuffix?: string | null): string {
    let prompt = `You are a reviewer in a best-of-n workflow.
Your job is to evaluate the candidate implementations and provide structured guidance.

Original Task:
${taskPrompt}

Candidate Implementations:
${candidates.map((c, i) => `
Candidate ${i + 1} (${c.id}):
${c.summary || "No summary available"}
Changed files: ${c.changedFilesJson.join(", ") || "None"}
Verification: ${this.stringifyVerificationSummary(c.verificationJson)}
`).join("\n")}

Please provide your review in the following format:
STATUS: pass | needs_manual_review
SUMMARY: <short summary of your evaluation>
BEST_CANDIDATES:
- <candidate-id-1>
- <candidate-id-2>
GAPS:
- <issue 1>
- <issue 2>
RECOMMENDED_FINAL_STRATEGY: pick_best | synthesize
RECOMMENDED_PROMPT:
<optional instructions for the final applier>
`
    if (taskSuffix?.trim()) {
      prompt += `\nAdditional instructions for this reviewer:\n${taskSuffix.trim()}\n`
    }
    return prompt
  }

  private parseReviewerOutput(output: string): ReviewerOutput {
    const statusMatch = output.match(/STATUS:\s*(\w+)/i)
    const summaryMatch = output.match(/SUMMARY:\s*([\s\S]+?)(?=\nBEST_CANDIDATES:|$)/i)
    const bestMatch = output.match(/BEST_CANDIDATES:\s*([\s\S]+?)(?=\nGAPS:|$)/i)
    const gapsMatch = output.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_FINAL_STRATEGY:|$)/i)
    const strategyMatch = output.match(/RECOMMENDED_FINAL_STRATEGY:\s*(\w+)/i)
    const promptMatch = output.match(/RECOMMENDED_PROMPT:\s*([\s\S]+?)$/i)

    const statusRaw = statusMatch?.[1]?.toLowerCase().trim() || "needs_manual_review"
    const status: ReviewerOutput["status"] = statusRaw === "pass" ? "pass" : "needs_manual_review"

    const summary = summaryMatch?.[1]?.trim() || "No summary provided"

    const bestText = bestMatch?.[1] || ""
    const bestCandidateIds = bestText
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("- "))
      .map(l => l.replace(/^-\s*/, "").trim())
      .filter(l => l.length > 0)

    const gapsText = gapsMatch?.[1] || ""
    const gaps = gapsText
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("- ") || l.startsWith("* "))
      .map(l => l.replace(/^[-*]\s*/, "").trim())
      .filter(g => g.length > 0 && g.toLowerCase() !== "none")

    const strategyRaw = strategyMatch?.[1]?.toLowerCase().trim() || "synthesize"
    const recommendedFinalStrategy: SelectionMode =
      strategyRaw === "pick_best" ? "pick_best" :
      strategyRaw === "pick_or_synthesize" ? "pick_or_synthesize" : "synthesize"

    const recommendedPrompt = promptMatch?.[1]?.trim() || null

    return {
      status,
      summary,
      bestCandidateIds,
      gaps,
      recommendedFinalStrategy,
      recommendedPrompt,
    }
  }

  private collectUsableReviewerResults(taskId: string): ReviewerOutput[] {
    const reviewerRuns = this.db.getTaskRunsByPhase(taskId, "reviewer")
    const usable: ReviewerOutput[] = []
    for (const run of reviewerRuns) {
      if (run.status === "done" && run.metadataJson?.reviewerOutput) {
        usable.push(run.metadataJson.reviewerOutput as ReviewerOutput)
      }
    }
    return usable
  }

  private aggregateReviewerResults(reviewerOutputs: ReviewerOutput[]): AggregatedReviewResult {
    const candidateVoteCounts: Record<string, number> = {}
    const recurringRisks: string[] = []
    const recurringGaps: string[] = []
    let consensusReached = false
    let topVoteCount = 0

    for (const output of reviewerOutputs) {
      for (const candidateId of output.bestCandidateIds) {
        candidateVoteCounts[candidateId] = (candidateVoteCounts[candidateId] || 0) + 1
        if (candidateVoteCounts[candidateId] > topVoteCount) {
          topVoteCount = candidateVoteCounts[candidateId]
        }
      }
      for (const gap of output.gaps) {
        if (!recurringGaps.includes(gap)) {
          recurringGaps.push(gap)
        }
      }
    }

    const totalUsable = reviewerOutputs.length
    for (const count of Object.values(candidateVoteCounts)) {
      if (count === totalUsable && totalUsable > 0) {
        consensusReached = true
        break
      }
    }

    const recommendedFinalStrategy = reviewerOutputs[0]?.recommendedFinalStrategy || "synthesize"

    return {
      candidateVoteCounts,
      recurringRisks,
      recurringGaps,
      consensusReached,
      recommendedFinalStrategy,
      usableResults: reviewerOutputs,
    }
  }

  private async runBestOfNFinalApplier(
    task: Task,
    candidates: TaskCandidate[],
    aggregatedReview: AggregatedReviewResult,
    selectionMode: SelectionMode,
    options: Options,
    serverUrl: string
  ): Promise<{ failed: boolean; routeToReview?: boolean; error?: string }> {
    const finalApplierRuns = this.db.getTaskRunsByPhase(task.id, "final_applier")
    const finalApplierRun = finalApplierRuns.find(r => r.status === "pending")
    if (!finalApplierRun) {
      return { failed: true, routeToReview: false, error: "No final applier run found" }
    }

    const client = this.getClient(undefined, serverUrl)
    let sessionId: string | null = null

    try {
      this.db.updateTaskRun(finalApplierRun.id, { status: "running" })
      this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(finalApplierRun.id) })

      const worktreeInfo = await this.createWorktree(`bon-final-${finalApplierRun.id}`)
      if (!worktreeInfo?.directory) {
        throw new Error(`Worktree creation failed for final applier ${finalApplierRun.id}`)
      }

      this.db.updateTaskRun(finalApplierRun.id, { worktreeDir: worktreeInfo.directory })
      this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(finalApplierRun.id) })

      const sessionResponse = await client.session.create({ title: `Final Applier: ${task.name}` })
      const session = unwrapResponseDataOrThrow<any>(sessionResponse, "Final applier session creation")
      sessionId = session?.id
      if (!sessionId) throw new Error("Failed to create final applier session")

      const sessionUrl = buildSessionUrl(serverUrl, this.worktreeDir, sessionId)
      this.db.updateTaskRun(finalApplierRun.id, { sessionId, sessionUrl })
      this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(finalApplierRun.id) })

      registerWorkflowSessionSafe(this.db, sessionId, task.id, "task_run_final_applier", this.ownerDirectory, task.skipPermissionAsking, finalApplierRun.id)
      writeRootOwnerPointerSafe(worktreeInfo.directory, this.ownerDirectory, join(this.ownerDirectory, ".opencode", "easy-workflow", "tasks.db"))

      const finalPrompt = this.buildFinalApplierPrompt(task.prompt, candidates, aggregatedReview, selectionMode, task.bestOfNConfig?.finalApplier?.taskSuffix)
      const model = await this.resolveModelSelection(finalApplierRun.model, client, "Final Applier")

      appendDebugLog("info", "running best-of-n final applier", { taskId: task.id, finalApplierRunId: finalApplierRun.id, model: finalApplierRun.model })

      const effectiveThinkingLevel = resolveThinkingLevel(task, options)
      const executionAgent = resolveExecutionAgent(task.skipPermissionAsking, effectiveThinkingLevel)

      const promptOpts: any = {
        sessionID: sessionId,
        model,
        parts: [{ type: "text", text: finalPrompt }],
      }
      if (executionAgent) promptOpts.agent = executionAgent

      let result: any
      try {
        const response = await client.session.prompt(promptOpts)
        result = unwrapResponseDataOrThrow<any>(response, "Final applier prompt")
      } catch (promptErr) {
        throw remapThinkingAgentError(promptErr, executionAgent)
      }

      const failure = this.extractExecutionFailure(result)
      if (failure) throw remapThinkingAgentError(new Error(`Final applier prompt failed: ${failure}`), executionAgent)

      const output = this.extractTextOutput(result)
      if (output) {
        this.db.appendAgentOutput(task.id, `\n[final-applier] ${output}\n`)
        this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[final-applier] ${output}\n` } })
      }

      const finalVerificationJson = await this.runVerificationCommand(
        task,
        "final-applier",
        worktreeInfo.directory,
        task.bestOfNConfig?.verificationCommand,
      )

      appendDebugLog("info", "best-of-n final applier completed, starting merge", { taskId: task.id })

      if (task.autoCommit && worktreeInfo) {
        try {
          const baseRef = this.resolveTargetBranch(task, options, worktreeInfo)
          let commitPromptText = options.commitPrompt.replace(/\{\{base_ref\}\}/g, baseRef)
          if (!task.deleteWorktree) {
            commitPromptText += "\n\nImportant: do NOT delete the worktree at the end; keep it for manual follow-up."
          }

          const commitResponse = await client.session.prompt({
            sessionID: sessionId,
            parts: [{ type: "text", text: commitPromptText }],
          })
          const commitResult = unwrapResponseDataOrThrow<any>(commitResponse, "Commit prompt")
          const commitFailure = this.extractExecutionFailure(commitResult)
          if (commitFailure) throw new Error(`Commit prompt failed: ${commitFailure}`)
        } catch (e) {
          const commitErrorMessage = e instanceof Error ? e.message : String(e)
          appendDebugLog("error", "commit prompt failed during best-of-n final apply", { taskId: task.id, error: commitErrorMessage })
          this.db.appendAgentOutput(task.id, `\n[final-applier commit error] ${commitErrorMessage}\n`)
          this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[final-applier commit error] ${commitErrorMessage}\n` } })
          throw new Error(`Final applier commit step failed for task "${task.name}": ${commitErrorMessage}`)
        }
      }

      if (worktreeInfo) {
        try {
          const { execFileSync } = await import("child_process")
          let mainBranch = this.resolveTargetBranch(task, options, worktreeInfo)

          try {
            execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${mainBranch}`], {
              cwd: worktreeInfo.directory,
              stdio: "ignore",
            })
          } catch (branchErr) {
            const branchErrorMessage = branchErr instanceof Error ? branchErr.message : String(branchErr)
            appendDebugLog("warn", "final applier target branch not found, falling back to main", {
              taskId: task.id,
              attemptedBranch: mainBranch,
              error: branchErrorMessage,
            })
            mainBranch = "main"
          }

          try {
            execFileSync("git", ["checkout", mainBranch], { cwd: worktreeInfo.directory, stdio: "ignore" })
          } catch (checkoutErr) {
            appendDebugLog("warn", "final applier branch checkout skipped", {
              taskId: task.id,
              branch: mainBranch,
              error: checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr),
            })
          }

          execFileSync("git", ["merge", worktreeInfo.branch, "--no-edit"], {
            cwd: worktreeInfo.directory,
            encoding: "utf-8",
            stdio: "pipe",
          })
          appendDebugLog("info", "best-of-n final merge completed", { taskId: task.id, branch: mainBranch })
        } catch (mergeErr) {
          const msg = `Merge failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`
          throw new Error(msg)
        }
      }

      if (task.deleteWorktree !== false && worktreeInfo?.directory) {
        try {
          await this.removeWorktree(worktreeInfo.directory)
        } catch (cleanupErr) {
          const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          appendDebugLog("warn", "final applier worktree cleanup failed", { taskId: task.id, error: cleanupMessage })
          this.emitError(`Final applier cleanup failed for task "${task.name}": ${cleanupMessage}. Worktree preserved at ${worktreeInfo.directory}.`)
        }
      }

      const now = Math.floor(Date.now() / 1000)
      this.db.updateTaskRun(finalApplierRun.id, {
        status: "done",
        summary: output.substring(0, 500),
        metadataJson: {
          verificationJson: finalVerificationJson,
        },
        completedAt: now,
      })
      this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(finalApplierRun.id) })

      return { failed: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendDebugLog("error", "best-of-n final applier failed", { taskId: task.id, finalApplierRunId: finalApplierRun.id, error: msg })
      const now = Math.floor(Date.now() / 1000)
      this.db.updateTaskRun(finalApplierRun.id, { status: "failed", errorMessage: msg, completedAt: now })
      this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(finalApplierRun.id) })
      this.emitError(`Final applier run failed for task "${task.name}": ${msg}`)

      if (msg.includes("ambiguous") || msg.includes("consensus")) {
        return { failed: true, routeToReview: true, error: msg }
      }
      return { failed: true, routeToReview: false, error: msg }
    } finally {
      if (options.autoDeleteNormalSessions && sessionId) {
        const deleted = await this.tryDeleteSession(client, sessionId, "normal", { taskId: task.id, taskRunId: finalApplierRun.id, phase: "final_applier" })
        if (deleted) {
          this.db.updateTaskRun(finalApplierRun.id, { sessionId: null, sessionUrl: null })
          this.server.broadcast({ type: "task_run_updated", payload: this.db.getTaskRun(finalApplierRun.id) })
        }
      }
    }
  }

  private buildFinalApplierPrompt(
    taskPrompt: string,
    candidates: TaskCandidate[],
    aggregatedReview: AggregatedReviewResult,
    selectionMode: SelectionMode,
    taskSuffix?: string | null
  ): string {
    let prompt = `${AUTONOMY_INSTRUCTION}

You are the final applier in a best-of-n workflow.
Your job is to produce the final implementation based on the original task and the evaluated candidates.

Original Task:
${taskPrompt}

`
    if (selectionMode === "pick_best") {
      const topCandidate = Object.entries(aggregatedReview.candidateVoteCounts)
        .sort(([, a], [, b]) => b - a)[0]
      if (topCandidate) {
        const candidate = candidates.find(c => c.id === topCandidate[0])
        if (candidate) {
          prompt += `Recommended Best Candidate (${topCandidate[0]}) - vote count: ${topCandidate[1]}:
${candidate.summary || "No summary available"}
Changed files: ${candidate.changedFilesJson.join(", ") || "None"}
`
        }
      }
    } else {
      prompt += `All Candidate Summaries:\n${candidates.map((c, i) => `${i + 1}. ${c.summary || "No summary"}`).join("\n")}\n`
    }

    if (aggregatedReview.recurringGaps.length > 0) {
      prompt += `\nRecurring gaps identified by reviewers:
${aggregatedReview.recurringGaps.map(g => `- ${g}`).join("\n")}
`
    }

    const recommendedPrompts = aggregatedReview.usableResults
      .map((result) => result.recommendedPrompt?.trim())
      .filter((value): value is string => Boolean(value))
    if (recommendedPrompts.length > 0) {
      prompt += `\nReviewer recommended prompts:\n${recommendedPrompts.map((value) => `- ${value}`).join("\n")}\n`
    }

    prompt += `\nReviewer consensus reached: ${aggregatedReview.consensusReached ? "yes" : "no"}\n`

    prompt += `\nSelection Mode: ${selectionMode}
`
    if (taskSuffix) {
      prompt += `\nAdditional instructions for the final applier:\n${taskSuffix}\n`
    }

    prompt += `\nProduce the final implementation now.`
    return prompt
  }

  private async runReviewLoop(task: Task, sessionId: string, config: ReviewConfig, options: Options) {
    if (!config.reviewAgent) {
      appendDebugLog("warn", "no review agent configured, skipping review", { taskId: task.id })
      return
    }

    const maxRuns = config.maxReviewRuns
    let reviewCount = task.reviewCount
    const client = this.getClient()

    // Create a temporary review file for this task
    const reviewFilePath = join(WORKFLOW_ROOT, "easy-workflow", `review-${task.id}.md`)
    const goalsContent = `## Task Goals\n\n${task.prompt}\n\n## Task Name\n\n${task.name}`
    const reviewContent = readFileSync(TEMPLATE_PATH, "utf-8")
      .replace("[REPLACE THIS WITH THE TASK GOALS]", goalsContent)

    try {
      writeFileSync(reviewFilePath, reviewContent, "utf-8")

      while (reviewCount < maxRuns) {
        // Move to review column
        this.db.updateTask(task.id, { status: "review", reviewCount })
        const reviewTask = this.db.getTask(task.id)!
        this.server.broadcast({ type: "task_updated", payload: reviewTask })

        appendDebugLog("info", "running review", { taskId: task.id, reviewCount, maxRuns })

        let reviewSessionId: string | null = null
        try {
          // Run review in a scratch session
          const reviewSessionResponse = await client.session.create({
            title: `Review: ${task.name}`,
          })
          const reviewSession = unwrapResponseDataOrThrow<any>(reviewSessionResponse, "Review session creation")
          reviewSessionId = reviewSession?.id

          if (reviewSessionId) {
            registerWorkflowSessionSafe(this.db, reviewSessionId, task.id, "review_scratch", this.ownerDirectory, task.skipPermissionAsking)
          }

          const reviewAgentName = task.skipPermissionAsking ? "workflow-review-autonomous" : config.reviewAgent
          const promptText = [
            `@${reviewAgentName}`,
            "",
            "Review the current repository state against the task below.",
            "Use the task goals as the only source of truth.",
            "Do not rely on prior session history.",
            "Inspect the current codebase and branch state.",
            "",
            `Task: ${task.name}`,
            `Goals: ${task.prompt}`,
          ].join("\n")

          const response = await client.session.prompt({
            sessionID: reviewSessionId,
            agent: reviewAgentName,
            parts: [{ type: "text", text: promptText }],
          })

          const result = unwrapResponseDataOrThrow<any>(response, "Review prompt")
          const reviewFailure = this.extractExecutionFailure(result)
          if (reviewFailure) throw new Error(`Review prompt failed: ${reviewFailure}`)
          const reviewResult = this.parseReviewResponse(result)

          appendDebugLog("info", "review result", {
            taskId: task.id,
            status: reviewResult.status,
            gaps: reviewResult.gaps,
          })

          if (reviewResult.status === "pass") {
            // Review passed
            this.db.updateTask(task.id, { status: "executing", reviewCount })
            const updated = this.db.getTask(task.id)!
            this.server.broadcast({ type: "task_updated", payload: updated })
            return
          }

          if (reviewResult.status === "blocked") {
            // Review blocked
            this.db.updateTask(task.id, {
              status: "stuck",
              reviewCount,
              errorMessage: `Review blocked: ${reviewResult.summary}`,
            })
            const updated = this.db.getTask(task.id)!
            this.server.broadcast({ type: "task_updated", payload: updated })
            return
          }

          // gaps_found - try to fix
          reviewCount++
          this.db.updateTask(task.id, { reviewCount })

          if (reviewCount >= maxRuns) {
            // Max reviews reached - stuck
            this.db.updateTask(task.id, {
              status: "stuck",
              reviewCount,
              errorMessage: `Max reviews (${maxRuns}) reached. Gaps: ${reviewResult.gaps.join("; ")}`,
            })
            const updated = this.db.getTask(task.id)!
            this.server.broadcast({ type: "task_updated", payload: updated })
            return
          }

          // Send fix prompt to the task session
          const fixPrompt = reviewResult.recommendedPrompt
            || `Fix the following issues found during review:\n${reviewResult.gaps.map(g => `- ${g}`).join("\n")}`

          appendDebugLog("info", "sending fix prompt after review", { taskId: task.id, reviewCount })
          const fixResponse = await client.session.prompt({
            sessionID: sessionId,
            parts: [{ type: "text", text: fixPrompt }],
          })
          const fixResult = unwrapResponseDataOrThrow<any>(fixResponse, "Review fix prompt")
          const fixFailure = this.extractExecutionFailure(fixResult)
          if (fixFailure) throw new Error(`Review fix prompt failed: ${fixFailure}`)
          const fixOutput = this.extractTextOutput(fixResult)
          if (fixOutput) {
            this.db.appendAgentOutput(task.id, `\n[review-fix-${reviewCount}] ${fixOutput}\n`)
            this.server.broadcast({ type: "agent_output", payload: { taskId: task.id, output: `\n[review-fix-${reviewCount}] ${fixOutput}\n` } })
          }
        } finally {
          if (options.autoDeleteReviewSessions && reviewSessionId) {
            await this.tryDeleteSession(client, reviewSessionId, "review", { taskId: task.id, taskName: task.name, phase: "review_loop" })
          }
        }
      }
    } finally {
      // Cleanup review file
      try {
        unlinkSync(reviewFilePath)
      } catch (cleanupErr) {
        appendDebugLog("warn", "review file cleanup failed", { taskId: task.id, reviewFilePath, error: String(cleanupErr) })
      }
    }
  }

  private extractTextOutput(result: any): string {
    const parts = result?.parts
    if (!Array.isArray(parts)) return ""
    return parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
  }

  private parseReviewResponse(result: any): ReviewResult {
    const textPart = result?.parts?.find(
      (p: any) => p?.type === "text" && typeof p.text === "string"
    )
    const text = textPart?.text ?? ""

    const statusMatch = text.match(/STATUS:\s*(\w+)/i)
    const summaryMatch = text.match(/SUMMARY:\s*([\s\S]+?)(?=\nGAPS:|$)/i)
    const gapsMatch = text.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_PROMPT:|$)/i)
    const recommendedMatch = text.match(/RECOMMENDED_PROMPT:\s*([\s\S]+?)$/i)

    const statusRaw = statusMatch?.[1]?.toLowerCase().trim() || "blocked"
    const status: ReviewResult["status"] =
      statusRaw === "pass" ? "pass" :
      statusRaw === "gaps_found" ? "gaps_found" : "blocked"

    const summary = summaryMatch?.[1]?.trim() || "Review could not be completed"

    const gapsText = gapsMatch?.[1] || ""
    const gaps = gapsText
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith("- ") || l.startsWith("* "))
      .map((l: string) => l.replace(/^[-*]\s+/, "").trim())
      .filter((g: string) => g.length > 0 && g.toLowerCase() !== "none")

    const recommendedPrompt = recommendedMatch?.[1]?.trim() || ""
    return {
      status,
      summary,
      gaps,
      recommendedPrompt: recommendedPrompt.toLowerCase() === "none" ? "" : recommendedPrompt,
    }
  }
}
