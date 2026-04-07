import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"
import type { WSMessage, ThinkingLevel, ExecutionStrategy, BestOfNConfig, SelectionMode } from "./types"
import { KanbanDB } from "./db"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { buildExecutionGraph, getExecutableTasks, isTaskExecutable } from "./execution-plan"
import { chooseDeterministicRepairAction, getLatestTaggedOutput, getPlanExecutionEligibility, hasCapturedPlanOutput, isTaskAwaitingPlanApproval, type TaskRepairAction } from "./task-state"
import { sendTelegramNotificationWithMetadata, sendWorkflowCompletionNotification } from "./telegram"
import { MessageLogger, createMessageLogger } from "./message-logger"

const MAX_EXPANDED_WORKER_RUNS = 8
const MAX_EXPANDED_REVIEWER_RUNS = 4
const MAX_TOTAL_INTERNAL_RUNS = 12

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENCODE_DIR = join(homedir(), ".config", "opencode")
const WORKFLOW_ROOT = OPENCODE_DIR
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

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

const TASK_BOOLEAN_FIELDS = ["planmode", "autoApprovePlan", "review", "autoCommit", "deleteWorktree", "skipPermissionAsking"] as const

function getInvalidTaskBooleanField(body: any): string | null {
  for (const field of TASK_BOOLEAN_FIELDS) {
    if (body?.[field] !== undefined && !isBoolean(body[field])) {
      return field
    }
  }
  return null
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
  return getExecutableTasks(db.getTasks()).length > 0
}

function getExecutionMutationError(): string {
  return "Cannot modify workflow tasks while execution is running. Stop execution first."
}

function isTaskActionableWhileExecutionRuns(status: string): boolean {
  return status === "template" || status === "review" || status === "failed" || status === "stuck"
}

function isTaskMutationLockedWhileExecuting(executing: boolean, status: string): boolean {
  return executing && !isTaskActionableWhileExecutionRuns(status)
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
  private ownerDirectory: string
  private messageLoggers: Map<string, MessageLogger> = new Map()

  constructor(
    db: KanbanDB,
    opts: { onStart: StartFn; onStartSingle: StartSingleFn; onStop: StopFn; getExecuting: () => boolean; getStartError?: StartPreflightFn; getServerUrl?: ServerUrlFn; ownerDirectory?: string }
  ) {
    this.db = db
    this.onStart = opts.onStart
    this.onStartSingle = opts.onStartSingle
    this.onStop = opts.onStop
    this.getExecuting = opts.getExecuting
    this.getStartError = opts.getStartError || (() => null)
    this.getServerUrl = opts.getServerUrl || (() => null)
    this.ownerDirectory = opts.ownerDirectory || process.cwd()

    // Register Telegram notification listener for task status changes
    this.db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = this.db.getTask(taskId)
      if (!task) return
      const opts = this.db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return
      sendTelegramNotificationWithMetadata(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus,
        opts.port,
        (msg: string) => console.debug(msg)
      ).catch((err: unknown) => {
        console.error("[telegram] notification failed:", err)
      })
    })
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

  handleWorkflowComplete(): void {
    const opts = this.db.getOptions()
    if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) {
      return
    }
    const completedCount = this.db.getTasksByStatus("done").filter(t => !t.isArchived).length
    sendWorkflowCompletionNotification(
      { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
      completedCount,
      opts.port,
      (msg: string) => console.debug(msg)
    ).catch((err: unknown) => {
      console.error("[telegram] workflow completion notification failed:", err)
    })
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

  private async maybeAutoStartExecution(): Promise<void> {
    if (this.getExecuting()) return
    const preflightError = this.getStartError()
    if (preflightError) return
    this.onStart().catch((err) => this.reportExecutionStartFailure(err))
  }

  private async applyRepairAction(taskId: string, action: TaskRepairAction, reason: string, errorMessage?: string) {
    const task = this.db.getTask(taskId)
    if (!task) {
      throw new Error("Task not found")
    }

    const hasPlan = hasCapturedPlanOutput(task.agentOutput)
    const eligibility = getPlanExecutionEligibility(task)
    const now = Math.floor(Date.now() / 1000)
    const repairNote = `[repair] action=${action} reason=${reason}\n`

    switch (action) {
      case "queue_implementation": {
        if (!task.planmode || !hasPlan) {
          throw new Error("Task cannot be sent to execution because no captured [plan] block exists")
        }
        const updated = this.db.updateTask(taskId, {
          status: "backlog",
          awaitingPlanApproval: false,
          executionPhase: task.executionPhase === "plan_revision_pending" ? "plan_revision_pending" : "implementation_pending",
          errorMessage: null,
          completedAt: null,
        })
        this.db.appendAgentOutput(taskId, repairNote)
        return updated
      }
      case "restore_plan_approval": {
        if (!task.planmode || !hasPlan) {
          throw new Error("Task cannot return to plan approval because no captured [plan] block exists")
        }
        const updated = this.db.updateTask(taskId, {
          status: "review",
          awaitingPlanApproval: true,
          executionPhase: "plan_complete_waiting_approval",
          errorMessage: null,
          completedAt: null,
        })
        this.db.appendAgentOutput(taskId, repairNote)
        return updated
      }
      case "mark_done": {
        // Cleanup worktree if deleteWorktree is enabled
        let worktreeDirToClear: string | null = null
        if (task.worktreeDir && task.deleteWorktree !== false) {
          try {
            await this.removeWorktree(task.worktreeDir)
            worktreeDirToClear = null
          } catch (cleanupErr) {
            console.error(`[server] worktree cleanup on mark_done failed for task ${taskId}:`, cleanupErr)
            // Preserve worktreeDir in DB if cleanup failed but deleteWorktree was true
            worktreeDirToClear = task.worktreeDir
          }
        } else {
          worktreeDirToClear = task.deleteWorktree === false ? task.worktreeDir : null
        }
        const updated = this.db.updateTask(taskId, {
          status: "done",
          awaitingPlanApproval: false,
          executionPhase: task.planmode && hasPlan ? "implementation_done" : task.executionPhase,
          errorMessage: null,
          completedAt: now,
          worktreeDir: worktreeDirToClear,
        })
        this.db.appendAgentOutput(taskId, repairNote)
        return updated
      }
      case "reset_backlog": {
        // Cleanup worktree if deleteWorktree is enabled (user wants to start fresh)
        if (task.worktreeDir && task.deleteWorktree !== false) {
          try {
            await this.removeWorktree(task.worktreeDir)
          } catch (cleanupErr) {
            console.error(`[server] worktree cleanup on reset_backlog failed for task ${taskId}:`, cleanupErr)
            // Continue with reset even if cleanup fails - worktree will be orphaned but DB is cleared
          }
        }
        const updated = this.db.updateTask(taskId, {
          status: "backlog",
          reviewCount: 0,
          agentOutput: "",
          errorMessage: null,
          completedAt: null,
          sessionId: null,
          sessionUrl: null,
          worktreeDir: null,
          executionPhase: "not_started",
          awaitingPlanApproval: false,
          planRevisionCount: 0,
          bestOfNSubstage: "idle",
        })
        return updated
      }
      case "fail_task": {
        const updated = this.db.updateTask(taskId, {
          status: "failed",
          awaitingPlanApproval: false,
          executionPhase: eligibility.ok ? "not_started" : task.executionPhase === "plan_complete_waiting_approval" ? "not_started" : task.executionPhase,
          errorMessage: errorMessage || reason,
          completedAt: null,
        })
        this.db.appendAgentOutput(taskId, repairNote)
        return updated
      }
      default:
        throw new Error(`Unsupported repair action: ${String(action)}`)
    }
  }

  private async fetchSessionMessages(client: ReturnType<typeof createV2Client>, sessionId: string | null): Promise<string[]> {
    if (!sessionId) return []
    try {
      const messagesResponse = await client.session.messages({ path: { id: sessionId } })
      const messagesData = messagesResponse?.data ?? messagesResponse
      const messages = Array.isArray(messagesData) ? messagesData : (messagesData?.info ? [messagesData] : [])
      return messages.map((m: any) => {
        const role = m?.info?.role || "unknown"
        const content = m?.parts?.map((p: any) => p?.type === "text" ? p.text : "").join("") || "(no content)"
        const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content
        return `[${role}] ${truncated}`
      })
    } catch {
      return []
    }
  }

  private async getWorktreeGitInfo(worktreeDir: string | null): Promise<{ status: string; diff: string } | null> {
    if (!worktreeDir) return null
    try {
      const statusOutput = execFileSync("git", ["status", "--porcelain"], {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
      const status = statusOutput.trim() || "(clean - no changes)"
      let diff = ""
      try {
        const diffOutput = execFileSync("git", ["diff", "--stat"], {
          cwd: worktreeDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        })
        diff = diffOutput.trim()
      } catch {
        // no diff available
      }
      return { status, diff }
    } catch {
      return null
    }
  }

  private async removeWorktree(directory: string): Promise<void> {
    const serverUrl = this.getServerUrl()
    if (!serverUrl) {
      throw new Error("OpenCode server URL is not configured")
    }
    const client = createV2Client(serverUrl)
    const response = await client.worktree.remove({
      worktreeRemoveInput: { directory },
    })
    if (response.error) {
      const error = response.error as any
      throw new Error(`Worktree removal failed: ${error?.message ?? JSON.stringify(error)}`)
    }
  }

  private async runSmartRepair(taskId: string): Promise<{ action: TaskRepairAction; reason: string; errorMessage?: string }> {
    const task = this.db.getTask(taskId)
    if (!task) {
      throw new Error("Task not found")
    }

    const serverUrl = this.getServerUrl()
    if (!serverUrl) {
      throw new Error("OpenCode server URL is not configured")
    }

    const options = this.db.getOptions()
    if (!options.repairModel || options.repairModel === "default") {
      throw new Error("Repair model is not configured. Please set a Repair Model in options before running the workflow.")
    }
    const client = createV2Client(serverUrl)
    const defaultMaxReviewRuns = options.maxReviews
    const effectiveMaxReviewRuns = task.maxReviewRunsOverride ?? defaultMaxReviewRuns
    const reviewLimitExceeded = task.reviewCount >= effectiveMaxReviewRuns

    // Gather rich context for smart repair decision
    const [sessionMessages, worktreeStatus, workflowSessions, taskRuns] = await Promise.all([
      this.fetchSessionMessages(client, task.sessionId),
      this.getWorktreeGitInfo(task.worktreeDir),
      Promise.resolve(this.db.getWorkflowSessionsByTask(taskId)),
      Promise.resolve(task.planmode ? this.db.getTaskRuns(taskId) : []),
    ])

    const promptParts: string[] = [
      "You repair workflow task states. Your job is to understand what ACTUALLY happened and choose the right repair action.",
      "Choose exactly one action from this list and return JSON only:",
      "queue_implementation, restore_plan_approval, reset_backlog, mark_done, fail_task, continue_with_more_reviews",
      "",
      "## Decision Guidelines",
      "Prefer queue_implementation when a usable [plan] exists AND the worktree shows real code changes (files modified). This means implementation actually happened.",
      "Prefer mark_done only when the task output AND worktree both confirm the work is complete. An empty worktree with just a 'done' plan is NOT sufficient.",
      "Use restore_plan_approval when the task should go back for human plan review.",
      "Use reset_backlog when the worktree has no meaningful changes and the task should start fresh.",
      "Use fail_task when the state is invalid and should stay visible with an actionable error.",
      "Use continue_with_more_reviews when stuck due to review limits but the gaps appear fixable.",
      "",
      "## Critical Verification Steps",
      "You MUST check the following BEFORE deciding:",
      "1. Look at 'Worktree git status' - if empty (no files modified), the task likely did nothing",
      "2. Look at 'OpenCode session messages' - understand where the session stopped and what it was doing",
      "3. Look at 'Workflow session history' - see the pattern of sessions for this task",
      "4. Compare 'Latest captured output' with worktree changes - do they match what was promised?",
      "",
      `Current review status: reviewCount=${task.reviewCount}, maxReviewRuns=${effectiveMaxReviewRuns}${reviewLimitExceeded ? " (LIMIT EXCEEDED)" : ""}`,
    ]

    if (task.worktreeDir) {
      promptParts.push("", `Worktree directory: ${task.worktreeDir}`)
    }

    if (worktreeStatus) {
      promptParts.push("", `## Worktree git status\n${worktreeStatus.status}`)
      if (worktreeStatus.diff) {
        promptParts.push("", `## Worktree git diff (changed files summary)\n${worktreeStatus.diff}`)
      }
    } else {
      promptParts.push("", "## Worktree git status\n<no worktree directory on record>")
    }

    if (sessionMessages.length > 0) {
      const lastFew = sessionMessages.slice(-5)
      promptParts.push("", `## OpenCode session history (last ${lastFew.length} messages from task session)\n${lastFew.join("\n---\n")}`)
      if (sessionMessages.length > 5) {
        promptParts.push(`...(${sessionMessages.length - 5} more messages in session)`)
      }
    } else {
      promptParts.push("", "## OpenCode session history\n<no session messages found>")
    }

    if (workflowSessions.length > 0) {
      const sessionSummary = workflowSessions.map(s => {
        const created = new Date(s.createdAt * 1000).toISOString()
        return `[${s.sessionKind}] ${s.status} - created ${created} (session: ${s.sessionId.slice(0, 12)}...)`
      }).join("\n")
      promptParts.push("", `## Workflow session history for this task\n${sessionSummary}`)
    }

    if (taskRuns.length > 0) {
      const runsSummary = taskRuns.map(r => {
        return `[${r.phase}] slot=${r.slotIndex} attempt=${r.attemptIndex} status=${r.status} model=${r.model} session=${r.sessionId?.slice(0, 12) ?? "none"}...`
      }).join("\n")
      promptParts.push("", `## Task runs (best-of-n)\n${runsSummary}`)
    }

    promptParts.push(
      "",
      `## Latest captured plan (from agentOutput)\n${getLatestTaggedOutput(task.agentOutput, "plan") || "<none>"}`,
      "",
      `## Latest revision request (from agentOutput)\n${getLatestTaggedOutput(task.agentOutput, "user-revision-request") || "<none>"}`,
      "",
      `## Latest execution output (from agentOutput)\n${getLatestTaggedOutput(task.agentOutput, "exec") || "<none>"}`,
      "",
      `## Full task state\n${JSON.stringify(task, null, 2)}`,
    )

    if (task.smartRepairHints) {
      promptParts.push("", `★★★ HIGH PRIORITY - Additional user instructions (MUST prioritize these):\n${task.smartRepairHints}`)
    }

    promptParts.push(
      "",
      "IMPORTANT: If choosing mark_done and task.autoCommit is true, you MUST also merge the worktree into the target branch and commit the work.",
      "  - Use the commit prompt template to drive the commit: stage changes, commit in worktree, cherry-pick to base branch, delete worktree.",
      "  - Use {{base_ref}} as the placeholder in the commit prompt (will be replaced at runtime).",
      "  - Include the full commit result (hash, message, stash/conflict status) in the errorMessage field if merge/commit succeeds, or the error reason if it fails.",
      "Return strict JSON with keys action, reason, and optional errorMessage.",
    )

    const prompt = promptParts.join("\n")

    const sessionResponse = await client.session.create({
      title: `Repair task state: ${task.name}`,
    })
    const session = sessionResponse?.data ?? sessionResponse
    const repairSessionId = session?.id

    if (repairSessionId) {
      try {
        this.db.registerWorkflowSession({
          sessionId: repairSessionId,
          taskId,
          taskRunId: null,
          sessionKind: "repair",
          ownerDirectory: this.ownerDirectory,
          skipPermissionAsking: task.skipPermissionAsking,
        })
      } catch (regErr) {
        console.error("[repair] failed to register session:", regErr)
      }
    }

    const repairAgent = task.skipPermissionAsking ? "workflow-repair" : "build-fast"
    const response = await client.session.prompt({
      sessionID: session?.id,
      agent: repairAgent,
      ...(options.repairModel !== "default" ? { model: options.repairModel } : {}),
      parts: [{ type: "text", text: prompt }],
    })
    const result = response?.data ?? response
    const text = result?.parts?.find((part: any) => part?.type === "text" && typeof part.text === "string")?.text?.trim() || ""
    const normalized = text.startsWith("```")
      ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      : text
    const parsed = JSON.parse(normalized) as { action?: TaskRepairAction; reason?: string; errorMessage?: string }
    if (!parsed.action || !parsed.reason) {
      throw new Error("Smart repair returned incomplete output")
    }
    if (!["queue_implementation", "restore_plan_approval", "reset_backlog", "mark_done", "fail_task", "continue_with_more_reviews"].includes(parsed.action)) {
      throw new Error(`Smart repair returned unsupported action: ${parsed.action}`)
    }
    return {
      action: parsed.action,
      reason: parsed.reason.trim(),
      errorMessage: typeof parsed.errorMessage === "string" && parsed.errorMessage.trim() ? parsed.errorMessage.trim() : undefined,
    }
  }

  start(): number {
    const port = this.db.getOptions().port
    let server: ReturnType<typeof Bun.serve>
    try {
      server = Bun.serve({
        port,
        hostname: "0.0.0.0",
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
    } catch (err: any) {
      if (err?.code === "EADDRINUSE" || err?.message?.includes("address already in use")) {
        throw new Error(`Port ${port} is already in use. Is another server running?`)
      }
      throw err
    }

    this.server = server
    console.log(`[kanban] server started on http://0.0.0.0:${server.port} (accessible on all network interfaces)`)
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
        const invalidBooleanField = getInvalidTaskBooleanField(body)
        if (invalidBooleanField) {
          return this.json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
        }
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

        if (method === "GET") {
          const task = this.db.getTask(taskId)
          if (!task) return this.json({ error: "Task not found" }, 404)
          return this.json(task)
        }

        if (method === "PATCH") {
          const existingTask = this.db.getTask(taskId)
          if (!existingTask) return this.json({ error: "Task not found" }, 404)
          if (isTaskMutationLockedWhileExecuting(this.getExecuting(), existingTask.status)) {
            return this.json({ error: getExecutionMutationError() }, 409)
          }

          const body = await req.json()
          const invalidBooleanField = getInvalidTaskBooleanField(body)
          if (invalidBooleanField) {
            return this.json({ error: `Invalid ${invalidBooleanField}. Expected boolean.` }, 400)
          }
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
          if (isTaskMutationLockedWhileExecuting(this.getExecuting(), existingTask.status)) {
            return this.json({ error: getExecutionMutationError() }, 409)
          }

          // Check if task has execution history - if so, archive instead of delete
          const hasHistory = this.db.hasTaskExecutionHistory(taskId)
          if (hasHistory) {
            // Archive the task (soft delete) to preserve history
            const archived = this.db.archiveTask(taskId)
            if (!archived) return this.json({ error: "Task not found" }, 404)
            this.broadcast({ type: "task_archived", payload: { id: taskId } })
            return this.json({ id: taskId, archived: true })
          } else {
            // Hard delete for tasks without any execution history
            const deleted = this.db.hardDeleteTask(taskId)
            if (!deleted) return this.json({ error: "Task not found" }, 404)
            this.broadcast({ type: "task_deleted", payload: { id: taskId } })
            return new Response(null, { status: 204 })
          }
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

      // Archive/Delete all done tasks
      if (method === "DELETE" && url.pathname === "/api/tasks/done/all") {
        const doneTasks = this.db.getTasksByStatus("done")
        let archived = 0
        let deleted = 0

        for (const task of doneTasks) {
          const hasHistory = this.db.hasTaskExecutionHistory(task.id)
          if (hasHistory) {
            this.db.archiveTask(task.id)
            this.broadcast({ type: "task_archived", payload: { id: task.id } })
            archived++
          } else {
            this.db.hardDeleteTask(task.id)
            this.broadcast({ type: "task_deleted", payload: { id: task.id } })
            deleted++
          }
        }

        return this.json({ archived, deleted })
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
        if (body?.autoDeleteNormalSessions !== undefined && !isBoolean(body.autoDeleteNormalSessions)) {
          return this.json({ error: "Invalid autoDeleteNormalSessions. Expected boolean." }, 400)
        }
        if (body?.autoDeleteReviewSessions !== undefined && !isBoolean(body.autoDeleteReviewSessions)) {
          return this.json({ error: "Invalid autoDeleteReviewSessions. Expected boolean." }, 400)
        }
        if (body?.showExecutionGraph !== undefined && !isBoolean(body.showExecutionGraph)) {
          return this.json({ error: "Invalid showExecutionGraph. Expected boolean." }, 400)
        }
        if (body?.reviewModel !== undefined) {
          if (typeof body.reviewModel !== "string" || !body.reviewModel.trim() || body.reviewModel === "default") {
            return this.json({ error: "Invalid reviewModel. Select a concrete provider/model value." }, 400)
          }

          const serverUrl = this.getServerUrl()
          if (!serverUrl) {
            return this.json({ error: "OpenCode server URL is not configured" }, 500)
          }

          try {
            const client = createV2Client(serverUrl)
            const providersResponse = await client.config.providers()
            const catalog = providersResponse?.data ?? providersResponse
            const canonicalReviewModel = resolveCatalogModel(body.reviewModel, catalog, "Review")
            body.reviewModel = canonicalReviewModel
            this.updateReviewAgentModel(canonicalReviewModel)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error("[Kanban Server] Failed to fetch providers for review model update:", msg)
            return this.json({ error: `OpenCode server unavailable. Please try again later. Details: ${msg}` }, 503)
          }
        }
        if (body?.repairModel !== undefined) {
          if (typeof body.repairModel !== "string" || !body.repairModel.trim() || body.repairModel === "default") {
            return this.json({ error: "Invalid repairModel. Select a concrete provider/model value." }, 400)
          }

          const serverUrl = this.getServerUrl()
          if (!serverUrl) {
            return this.json({ error: "OpenCode server URL is not configured" }, 500)
          }

          try {
            const client = createV2Client(serverUrl)
            const providersResponse = await client.config.providers()
            const catalog = providersResponse?.data ?? providersResponse
            const canonicalRepairModel = resolveCatalogModel(body.repairModel, catalog, "Repair")
            body.repairModel = canonicalRepairModel
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error("[Kanban Server] Failed to fetch providers for repair model update:", msg)
            return this.json({ error: `OpenCode server unavailable. Please try again later. Details: ${msg}` }, 503)
          }
        }
        if (body?.telegramBotToken !== undefined && typeof body.telegramBotToken !== "string") {
          return this.json({ error: "Invalid telegramBotToken. Expected a string." }, 400)
        }
        if (body?.telegramChatId !== undefined && typeof body.telegramChatId !== "string") {
          return this.json({ error: "Invalid telegramChatId. Expected a string." }, 400)
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

        // Helper to extract meaningful error message
        const extractErrorMessage = (err: unknown): string => {
          if (err instanceof Error) return err.message
          if (typeof err === "string") return err
          if (err && typeof err === "object") {
            // Try to extract message from common error object shapes
            const e = err as Record<string, unknown>
            if (typeof e.message === "string") return e.message
            if (typeof e.error === "string") return e.error
            if (typeof e.error === "object" && e.error) {
              const inner = e.error as Record<string, unknown>
              if (typeof inner.message === "string") return inner.message
            }
            // Return JSON representation for debugging instead of [object Object]
            try {
              return JSON.stringify(err)
            } catch {
              return "Unknown error (failed to serialize)"
            }
          }
          return String(err)
        }

        // Retry with exponential backoff
        const maxRetries = 3
        let lastError: unknown

        for (let attempt = 0; attempt < maxRetries; attempt++) {
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
            lastError = err
            // Wait before retrying (exponential backoff: 500ms, 1000ms, 2000ms)
            if (attempt < maxRetries - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)))
            }
          }
        }

        // All retries failed - return empty catalog with warning instead of error
        console.error("[Kanban Server] Failed to fetch model catalog after", maxRetries, "attempts:", extractErrorMessage(lastError))
        return this.json({
          providers: [],
          defaults: {},
          warning: "Model catalog temporarily unavailable. Models will load when OpenCode server is ready."
        }, 200)
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

          const pendingApprovalTasks = tasks.filter(t => isTaskAwaitingPlanApproval(t))
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
        if (!isTaskExecutable(task)) {
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
        if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }
        if (!hasCapturedPlanOutput(task.agentOutput)) {
          return this.json({ error: "Task has no captured plan output to approve. Reset it to backlog and rerun planning." }, 400)
        }
        if (task.planmode && (task.executionPhase === "implementation_pending" || task.executionPhase === "implementation_done")) {
          return this.json({ ok: true, message: "Plan already approved" })
        }
        if (!isTaskAwaitingPlanApproval(task)) {
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
          status: "executing",
        })
        const updated = this.db.getTask(taskId)!
        this.broadcast({ type: "task_updated", payload: updated })
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
        if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }
        if (!hasCapturedPlanOutput(task.agentOutput)) {
          return this.json({ error: "Task has no captured plan output to revise" }, 400)
        }
        if (!isTaskAwaitingPlanApproval(task)) {
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
          awaitingPlanApproval: false,
          status: "backlog",
        })
        const updated = this.db.getTask(taskId)!
        this.broadcast({ type: "plan_revision_requested", payload: updated })
        this.broadcast({ type: "task_updated", payload: updated })
        await this.maybeAutoStartExecution()
        return this.json({ ok: true })
      }

      const repairMatch = method === "POST"
        ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/repair-state$/)
        : null
      if (repairMatch) {
        const taskId = repairMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) {
          return this.json({ error: "Task not found" }, 404)
        }
        if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }

        let requestedAction: TaskRepairAction | "smart" | "continue_with_more_reviews" | undefined
        let additionalReviewCount = 2
        let smartRepairHints: string | undefined
        try {
          const body = await req.json()
          if (body && typeof body.action === "string") {
            requestedAction = body.action as TaskRepairAction | "smart" | "continue_with_more_reviews"
          }
          if (typeof body.additionalReviewCount === "number" && body.additionalReviewCount >= 1) {
            additionalReviewCount = Math.floor(body.additionalReviewCount)
          }
          if (typeof body.smartRepairHints === "string" && body.smartRepairHints.trim()) {
            smartRepairHints = body.smartRepairHints.trim()
          }
        } catch {
          // action is optional
        }

        let action: TaskRepairAction
        let reason: string
        let errorMessage: string | undefined

        // Special handling for continue_with_more_reviews action
        if (requestedAction === "continue_with_more_reviews") {
          const currentMax = task.maxReviewRunsOverride ?? this.db.getOptions().maxReviews
          const newMaxReviewRunsOverride = task.reviewCount + additionalReviewCount
          const repairNote = `[repair] action=continue_with_more_reviews reason=User increased review limit to allow more review cycles\n`

          const updated = this.db.updateTask(taskId, {
            status: "executing",
            reviewCount: 0,
            maxReviewRunsOverride: newMaxReviewRunsOverride,
            errorMessage: null,
            completedAt: null,
            ...(smartRepairHints !== undefined ? { smartRepairHints } : {}),
          })
          if (!updated) {
            return this.json({ error: "Task not found" }, 404)
          }
          this.db.appendAgentOutput(taskId, repairNote)
          if (smartRepairHints) {
            this.db.appendAgentOutput(taskId, `[repair-hints] ${smartRepairHints}\n`)
          }
          this.broadcast({ type: "task_updated", payload: updated })
          await this.maybeAutoStartExecution()
          return this.json({ ok: true, action: "continue_with_more_reviews", reason: `Increased review limit from ${currentMax} to ${newMaxReviewRunsOverride} and resumed execution`, task: this.db.getTask(taskId) })
        }

        if (!requestedAction || requestedAction === "smart") {
          const eligibility = getPlanExecutionEligibility(task)
          if (!eligibility.ok) {
            action = "fail_task"
            reason = eligibility.reason || "Task state is invalid"
            errorMessage = reason
          } else if (task.status === "review" || task.status === "executing") {
            try {
              const smart = await this.runSmartRepair(taskId)
              action = smart.action
              reason = smart.reason
              errorMessage = smart.errorMessage
            } catch (smartErr) {
              const fallback = chooseDeterministicRepairAction(task)
              action = fallback.action
              reason = `${fallback.reason} Smart repair fallback: ${smartErr instanceof Error ? smartErr.message : String(smartErr)}`
            }
          } else {
            const deterministic = chooseDeterministicRepairAction(task)
            action = deterministic.action
            reason = deterministic.reason
          }
        } else {
          action = requestedAction
          reason = `User requested repair action: ${requestedAction}`
        }

        const updated = await this.applyRepairAction(taskId, action, reason, errorMessage)
        if (!updated) {
          return this.json({ error: "Task not found" }, 404)
        }
        this.broadcast({ type: "task_updated", payload: updated })
        if (updated.agentOutput !== task.agentOutput) {
          const appended = updated.agentOutput.slice(task.agentOutput.length)
          if (appended) {
            this.broadcast({ type: "agent_output", payload: { taskId, output: appended } })
          }
        }
        if (action === "queue_implementation") {
          await this.maybeAutoStartExecution()
        }
        return this.json({ ok: true, action, reason, task: this.db.getTask(taskId) })
      }

      // Task review limits override
      const reviewLimitsMatch = method === "PATCH"
        ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/review-limits$/)
        : null
      if (reviewLimitsMatch) {
        const taskId = reviewLimitsMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) {
          return this.json({ error: "Task not found" }, 404)
        }
        if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
          return this.json({ error: getExecutionMutationError() }, 409)
        }

        const body = await req.json().catch(() => ({}))
        const maxReviewRunsOverride = body.maxReviewRunsOverride === null
          ? null
          : typeof body.maxReviewRunsOverride === "number"
            ? Math.max(1, body.maxReviewRunsOverride)
            : undefined
        const smartRepairHints = typeof body.smartRepairHints === "string" ? body.smartRepairHints : undefined

        const updates: Partial<{
          maxReviewRunsOverride: number | null
          smartRepairHints: string | null
        }> = {}
        if (maxReviewRunsOverride !== undefined) updates.maxReviewRunsOverride = maxReviewRunsOverride
        if (smartRepairHints !== undefined) updates.smartRepairHints = smartRepairHints

        if (Object.keys(updates).length === 0) {
          return this.json({ error: "No valid fields to update" }, 400)
        }

        const updated = this.db.updateTask(taskId, updates)
        if (!updated) {
          return this.json({ error: "Task not found" }, 404)
        }
        this.broadcast({ type: "task_updated", payload: updated })
        return this.json({ ok: true, task: updated })
      }

      // Task review status
      const reviewStatusMatch = method === "GET"
        ? url.pathname.match(/^\/api\/tasks\/([a-z0-9]+)\/review-status$/)
        : null
      if (reviewStatusMatch) {
        const taskId = reviewStatusMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) {
          return this.json({ error: "Task not found" }, 404)
        }

        const defaultMaxReviewRuns = this.db.getOptions().maxReviews
        const effectiveMaxReviewRuns = task.maxReviewRunsOverride ?? defaultMaxReviewRuns
        const reviewLimitExceeded = task.reviewCount >= effectiveMaxReviewRuns

        // Parse review history from agentOutput
        const reviewHistory: Array<{
          cycle: number
          status: string
          gaps: string[]
          recommendedPrompt: string | null
        }> = []
        const reviewFixPattern = /\[review-fix-(\d+)\]\s*([\s\S]*?)(?=\n\[review-fix-\d+\]|\n\[exec\]|\n\[plan\]|$)/g
        let match
        while ((match = reviewFixPattern.exec(task.agentOutput)) !== null) {
          const cycle = parseInt(match[1], 10)
          const content = match[2] || ""

          // Try to extract status and gaps from review-fix content
          const statusMatch = content.match(/STATUS:\s*(\w+)/i)
          const gapsMatch = content.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_PROMPT:|$)/i)
          const recommendedMatch = content.match(/RECOMMENDED_PROMPT:\s*([\s\S]+?)$/i)

          const status = statusMatch?.[1]?.toLowerCase() || "unknown"
          const gapsText = gapsMatch?.[1] || ""
          const gaps = gapsText
            .split("\n")
            .map((l: string) => l.trim())
            .filter((l: string) => l.startsWith("- ") || l.startsWith("* "))
            .map((l: string) => l.replace(/^[-*]\s+/, "").trim())
            .filter((g: string) => g.length > 0 && g.toLowerCase() !== "none")
          const recommendedPrompt = recommendedMatch?.[1]?.trim() || null

          reviewHistory.push({ cycle, status, gaps, recommendedPrompt })
        }

        // Sort by cycle number
        reviewHistory.sort((a, b) => a.cycle - b.cycle)

        return this.json({
          reviewCount: task.reviewCount,
          maxReviewRuns: defaultMaxReviewRuns,
          maxReviewRunsOverride: task.maxReviewRunsOverride,
          effectiveMaxReviewRuns,
          reviewLimitExceeded,
          smartRepairHints: task.smartRepairHints,
          reviewHistory,
        })
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

      // Bridge Events - from the minimal bridge plugin
      if (method === "POST" && url.pathname === "/api/events/bridge") {
        const body = await req.json()
        await this.handleBridgeEvent(body)
        return this.json({ ok: true })
      }

      // Session Messages API - for timeline reconstruction
      const sessionMessagesMatch = method === "GET" ? url.pathname.match(/^\/api\/sessions\/([^\/]+)\/messages$/) : null
      if (sessionMessagesMatch) {
        const sessionId = sessionMessagesMatch[1]
        const messages = this.db.getSessionTimeline(sessionId)
        return this.json(messages)
      }

      const sessionTimelineMatch = method === "GET" ? url.pathname.match(/^\/api\/sessions\/([^\/]+)\/timeline$/) : null
      if (sessionTimelineMatch) {
        const sessionId = sessionTimelineMatch[1]
        const messages = this.db.getSessionTimeline(sessionId)
        
        // Get first message timestamp for relative time calculation
        const firstTimestamp = messages.length > 0 ? messages[0].timestamp : Date.now()
        
        // Format as timeline entries
        const timeline = messages.map(m => ({
          id: m.id,
          timestamp: m.timestamp,
          relativeTime: m.timestamp - firstTimestamp,
          role: m.role,
          messageType: m.messageType,
          summary: this.summarizeMessage(m),
          hasToolCalls: !!m.toolName,
          hasEdits: !!m.editDiff,
          modelProvider: m.modelProvider,
          modelId: m.modelId,
          agentName: m.agentName,
        }))
        
        return this.json({
          sessionId,
          messageCount: messages.length,
          startTime: firstTimestamp,
          endTime: messages.length > 0 ? messages[messages.length - 1].timestamp : firstTimestamp,
          timeline,
        })
      }

      const taskMessagesMatch = method === "GET" ? url.pathname.match(/^\/api\/tasks\/([^\/]+)\/messages$/) : null
      if (taskMessagesMatch) {
        const taskId = taskMessagesMatch[1]
        const task = this.db.getTask(taskId)
        if (!task) return this.json({ error: "Task not found" }, 404)
        
        const messages = this.db.getSessionMessagesByTask(taskId)
        return this.json(messages)
      }

      const taskRunMessagesMatch = method === "GET" ? url.pathname.match(/^\/api\/task-runs\/([^\/]+)\/messages$/) : null
      if (taskRunMessagesMatch) {
        const taskRunId = taskRunMessagesMatch[1]
        const taskRun = this.db.getTaskRun(taskRunId)
        if (!taskRun) return this.json({ error: "Task run not found" }, 404)
        
        const messages = this.db.getSessionMessagesByTaskRun(taskRunId)
        return this.json(messages)
      }

      // Workflow Session lookup - for permission auto-reply
      const workflowSessionMatch = method === "GET" ? url.pathname.match(/^\/api\/workflow-session\/([^\/]+)$/) : null
      if (workflowSessionMatch) {
        const sessionId = workflowSessionMatch[1]
        const session = this.db.getWorkflowSession(sessionId)
        if (!session) {
          return this.json({ error: "Session not found" }, 404)
        }
        return this.json({
          sessionId: session.sessionId,
          taskId: session.taskId,
          sessionKind: session.sessionKind,
          skipPermissionAsking: session.skipPermissionAsking,
        })
      }

      return this.json({ error: "Not found" }, 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return this.json({ error: message }, 500)
    }
  }

  // ---- Bridge Event Handling ----

  private async handleBridgeEvent(body: any): Promise<void> {
    const { type, payload } = body

    if (type === "chat.message") {
      await this.handleWorkflowActivation(payload)
    } else if (type === "event") {
      await this.handleOpencodeEvent(payload.event)
    } else if (type === "message.updated") {
      await this.handleMessageEvent(payload)
    } else if (type === "tool.execute.after") {
      await this.handleToolExecuteEvent(payload)
    } else if (type === "session.updated") {
      await this.handleSessionUpdateEvent(payload)
    } else if (type === "session.idle") {
      await this.handleSessionIdleEvent(payload)
    } else if (type === "message.part.added") {
      await this.handleMessagePartAddedEvent(payload)
    } else if (type === "message.part.updated") {
      await this.handleMessagePartUpdatedEvent(payload)
    } else if (type === "session.created") {
      await this.handleSessionCreatedEvent(payload)
    } else if (type === "session.error") {
      await this.handleSessionErrorEvent(payload)
    } else if (type === "permission.asked") {
      await this.handlePermissionAskedEvent(payload)
    } else if (type === "permission.replied") {
      await this.handlePermissionRepliedEvent(payload)
    }
  }

  private async handleWorkflowActivation(payload: any): Promise<void> {
    const { cleanedPrompt, normalizedPrompt, directory, agent, model } = payload

    console.log("[bridge] Workflow activation requested:", normalizedPrompt.substring(0, 50) + "...")

    // This is a placeholder - the full workflow run logic would need to be ported
    // from the original plugin. For now, we just log it.
    // TODO: Port workflow run creation logic from easy-workflow.ts

    // Create a simple workflow run file
    const { createHash } = await import("crypto")
    const { appendFileSync, existsSync, mkdirSync, writeFileSync } = await import("fs")
    const { join } = await import("path")

    const WORKFLOW_ROOT = join(OPENCODE_DIR, "easy-workflow")
    const RUNS_DIR = join(directory, ".opencode", "easy-workflow", "runs")
    const TEMPLATE_PATH = join(WORKFLOW_ROOT, "workflow.md")

    // Ensure directories exist
    mkdirSync(RUNS_DIR, { recursive: true })

    // Check if template exists
    if (!existsSync(TEMPLATE_PATH)) {
      console.error("[bridge] Workflow template not found:", TEMPLATE_PATH)
      return
    }

    // Create run file
    const createdAt = new Date().toISOString()
    const promptHash = createHash("md5").update(normalizedPrompt + createdAt).digest("hex")
    const runPath = join(RUNS_DIR, `${promptHash}.md`)

    // Read template
    const template = readFileSync(TEMPLATE_PATH, "utf-8")

    // Extract review agent from template
    const frontmatterMatch = template.match(/^---\n([\s\S]*?)\n---/)
    let reviewAgent = "workflow-review"
    if (frontmatterMatch) {
      const modelMatch = frontmatterMatch[1].match(/reviewAgent:\s*(\S+)/)
      if (modelMatch) {
        reviewAgent = modelMatch[1]
      }
    }

    // Create initial state
    const state = {
      reviewAgent,
      runreview: true,
      running: false,
      status: "pending",
      reviewCount: 0,
      maxReviewRuns: this.db.getOptions().maxReviews,
      createdAt,
      updatedAt: createdAt,
      sessionId: null,
      promptHash,
      lastReviewedAt: null,
      lastReviewFingerprint: null,
      version: 1,
    }

    // Write run file
    const frontmatter = Object.entries(state)
      .map(([k, v]) => `${k}: ${v === null ? "null" : typeof v === "string" ? JSON.stringify(v) : v}`)
      .join("\n")

    const body = template.replace(/^---[\s\S]*?---\n?/, "")
    const runContent = `---\n${frontmatter}\n---\n${body}`

    writeFileSync(runPath, runContent, "utf-8")
    console.log("[bridge] Created workflow run:", runPath)

    // Append to per-project debug log
    const DEBUG_LOG_PATH = join(directory, ".opencode", "easy-workflow", "debug.log")
    mkdirSync(join(directory, ".opencode", "easy-workflow"), { recursive: true })
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] info: Workflow run created via bridge: ${runPath}\n`, "utf-8")

    // Note: Goal extraction and full workflow orchestration would need to be
    // fully ported from the original plugin. This is a minimal implementation
    // to demonstrate the bridge pattern.
  }

  private async handleOpencodeEvent(event: any): Promise<void> {
    if (event?.type === "session.idle") {
      // Handle session idle - trigger reviews
      const sessionId = this.extractSessionIdFromEvent(event)
      if (sessionId) {
        await this.handleSessionIdle(sessionId)
      }
    }
    // permission.asked is handled via the /api/workflow-session endpoint
    // which the bridge queries before auto-replying
  }

  private extractSessionIdFromEvent(event: any): string | null {
    const candidates = [
      event?.properties?.sessionId,
      event?.properties?.sessionID,
      event?.sessionId,
      event?.sessionID,
    ]
    return candidates.find((c) => typeof c === "string" && c.trim().length > 0) || null
  }

  private async handleSessionIdle(sessionId: string): Promise<void> {
    // Find active workflow runs for this session
    const { readdirSync } = await import("fs")
    const { join } = await import("path")

    // This would check workflow runs directory for runs associated with this session
    // and trigger reviews. For now, this is a placeholder.
    console.log("[bridge] Session idle:", sessionId)
  }

  // ---- Message Logging Handlers ----

  private getOrCreateMessageLogger(sessionId: string): MessageLogger {
    if (!this.messageLoggers.has(sessionId)) {
      // Look up task info from workflow_sessions
      const workflowSession = this.db.getWorkflowSession(sessionId)
      
      const logger = createMessageLogger({
        db: this.db,
        taskId: workflowSession?.taskId ?? null,
        taskRunId: workflowSession?.taskRunId ?? null,
        workflowPhase: workflowSession?.sessionKind ?? null,
        sessionStatus: workflowSession?.status ?? null,
      })
      
      this.messageLoggers.set(sessionId, logger)
    }
    return this.messageLoggers.get(sessionId)!
  }

  private async handleMessageEvent(payload: any): Promise<void> {
    try {
      const sessionId = payload?.sessionId
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logMessageUpdated({
        properties: payload?.output,
        parts: payload?.output?.parts,
        ...payload?.output,
      })
    } catch (err) {
      console.error("[message-logger] Error handling message event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleToolExecuteEvent(payload: any): Promise<void> {
    try {
      const sessionId = payload?.sessionId
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logToolExecuteAfter(payload?.input, payload?.output)
    } catch (err) {
      console.error("[message-logger] Error handling tool execute event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSessionUpdateEvent(payload: any): Promise<void> {
    try {
      const sessionId = payload?.sessionId
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logSessionUpdated({
        properties: payload?.output,
        ...payload?.output,
      })
    } catch (err) {
      console.error("[message-logger] Error handling session update event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSessionIdleEvent(payload: any): Promise<void> {
    try {
      const sessionId = payload?.sessionId
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logSessionIdle({
        properties: payload?.event,
        ...payload?.event,
      })

      // Clean up the logger for this session
      this.messageLoggers.delete(sessionId)
    } catch (err) {
      console.error("[message-logger] Error handling session idle event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleMessagePartAddedEvent(payload: any): Promise<void> {
    try {
      const sessionId = payload?.sessionId
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logMessagePartAdded(payload?.input, payload?.output)
    } catch (err) {
      console.error("[message-logger] Error handling message part added event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleMessagePartUpdatedEvent(payload: any): Promise<void> {
    try {
      const sessionId = payload?.sessionId
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logMessagePartUpdated(payload?.input, payload?.output)
    } catch (err) {
      console.error("[message-logger] Error handling message part updated event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSessionCreatedEvent(payload: any): Promise<void> {
    try {
      const sessionId = this.extractSessionIdFromEvent(payload)
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logSessionCreated(payload)
    } catch (err) {
      console.error("[message-logger] Error handling session created event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handleSessionErrorEvent(payload: any): Promise<void> {
    try {
      const sessionId = this.extractSessionIdFromEvent(payload)
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logSessionError(payload)
    } catch (err) {
      console.error("[message-logger] Error handling session error event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handlePermissionAskedEvent(payload: any): Promise<void> {
    try {
      const sessionId = this.extractSessionIdFromEvent(payload)
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logPermissionEvent(payload, 'asked')
    } catch (err) {
      console.error("[message-logger] Error handling permission asked event:", err instanceof Error ? err.message : String(err))
    }
  }

  private async handlePermissionRepliedEvent(payload: any): Promise<void> {
    try {
      const sessionId = this.extractSessionIdFromEvent(payload)
      if (!sessionId) return

      const logger = this.getOrCreateMessageLogger(sessionId)
      await logger.logPermissionEvent(payload, 'replied')
    } catch (err) {
      console.error("[message-logger] Error handling permission replied event:", err instanceof Error ? err.message : String(err))
    }
  }

  private summarizeMessage(message: import("./types").SessionMessage): string {
    const maxLength = 100
    
    if (message.toolName) {
      if (message.editFilePath) {
        return `Edited ${message.editFilePath}`
      }
      return `Called ${message.toolName}`
    }
    
    const content = message.contentJson
    let text = ""
    
    if (typeof content.text === "string") {
      text = content.text
    } else if (Array.isArray(content.text)) {
      text = content.text.join(" ")
    } else if (content.stepFinish) {
      return `Step finished: ${content.stepFinish.reason || "completed"}`
    } else if (content.retry) {
      return `Retry attempt ${content.retry.attempt || 1}`
    }
    
    if (text.length > maxLength) {
      return text.slice(0, maxLength) + "..."
    }
    
    return text || `[${message.messageType}]`
  }
}
