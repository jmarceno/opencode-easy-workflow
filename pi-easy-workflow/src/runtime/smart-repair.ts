import { existsSync } from "fs"
import { execFileSync } from "child_process"
import type { PiKanbanDB } from "../db.ts"
import type { Task } from "../types.ts"
import type { TaskRepairAction } from "../task-state.ts"
import { chooseDeterministicRepairAction } from "../task-state.ts"
import { buildRepairVariables } from "../prompts/index.ts"
import { PiSessionManager } from "./session-manager.ts"
import { parseStrictJsonObject } from "./strict-json.ts"

export type SmartRepairAction = TaskRepairAction

export interface SmartRepairDecision {
  action: SmartRepairAction
  reason: string
  errorMessage?: string
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function trimForContext(value: string, max = 1200): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}...`
}

function getGitStatusPorcelain(worktreeDir: string | null): string {
  if (!worktreeDir || !existsSync(worktreeDir)) return "(no worktree available)"
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreeDir,
      encoding: "utf-8",
      stdio: "pipe",
    })
    return status.trim() || "(clean)"
  } catch (error) {
    return `(failed to read git status: ${error instanceof Error ? error.message : String(error)})`
  }
}

function buildSessionHistoryText(db: PiKanbanDB, taskId: string): string {
  const sessions = db.getWorkflowSessionsByTask(taskId)
  if (sessions.length === 0) return "(none)"
  return sessions
    .map((session) => {
      const started = new Date(session.startedAt * 1000).toISOString()
      const finished = session.finishedAt ? new Date(session.finishedAt * 1000).toISOString() : "ongoing"
      return `${session.id}: kind=${session.sessionKind}, status=${session.status}, started=${started}, finished=${finished}, model=${session.model}`
    })
    .join("\n")
}

function buildRecentMessagesText(db: PiKanbanDB, taskId: string): string {
  const messages = db.getSessionMessageViewsByTask(taskId)
  if (messages.length === 0) return "(none)"
  return messages
    .slice(-12)
    .map((message) => {
      const content = typeof message.contentJson?.text === "string"
        ? message.contentJson.text
        : JSON.stringify(message.contentJson)
      return `${message.sessionId} [${message.role}/${message.messageType}]: ${trimForContext(content, 320)}`
    })
    .join("\n")
}

function buildLatestTaggedOutputText(task: Task): string {
  const lines = task.agentOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return "(none)"
  return trimForContext(lines.slice(-30).join("\n"), 3000)
}

function parseRepairDecision(responseText: string): SmartRepairDecision {
  const parsed = parseStrictJsonObject(responseText, "Repair response")
  const action = parsed.action
  if (
    action !== "queue_implementation"
    && action !== "restore_plan_approval"
    && action !== "reset_backlog"
    && action !== "mark_done"
    && action !== "fail_task"
    && action !== "continue_with_more_reviews"
  ) {
    throw new Error("Repair response JSON contains unsupported action")
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim()
    : "No reason provided"
  const errorMessage = typeof parsed.errorMessage === "string" && parsed.errorMessage.trim()
    ? parsed.errorMessage.trim()
    : undefined

  return { action, reason, errorMessage }
}

export class SmartRepairService {
  private readonly sessions: PiSessionManager

  constructor(private readonly db: PiKanbanDB) {
    this.sessions = new PiSessionManager(db)
  }

  async decide(taskId: string): Promise<SmartRepairDecision> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error("Task not found")

    const options = this.db.getOptions()
    const worktreeStatus = getGitStatusPorcelain(task.worktreeDir)
    const sessionHistory = [
      "Workflow sessions:",
      buildSessionHistoryText(this.db, task.id),
      "",
      "Recent session messages:",
      buildRecentMessagesText(this.db, task.id),
      task.smartRepairHints?.trim() ? `\nUser hints:\n${task.smartRepairHints.trim()}` : "",
    ].join("\n")

    const latestOutput = buildLatestTaggedOutputText(task)
    const promptVars = buildRepairVariables(task, worktreeStatus, sessionHistory, latestOutput)
    const prompt = this.db.renderPrompt("repair", promptVars)

    const session = await this.sessions.executePrompt({
      taskId: task.id,
      sessionKind: "repair",
      cwd: task.worktreeDir ?? process.cwd(),
      worktreeDir: task.worktreeDir,
      branch: task.branch,
      model: options.repairModel,
      thinkingLevel: task.thinkingLevel,
      promptText: prompt.renderedText,
    })

    return parseRepairDecision(session.responseText)
  }

  applyAction(taskId: string, decision: SmartRepairDecision): Task {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error("Task not found")

    const now = nowUnix()
    const reasonNote = `[repair] action=${decision.action} reason=${decision.reason}\n`
    let update: Record<string, unknown>

    if (decision.action === "queue_implementation") {
      update = {
        status: "executing",
        executionPhase: "implementation_pending",
        awaitingPlanApproval: false,
        errorMessage: null,
      }
    } else if (decision.action === "restore_plan_approval") {
      update = {
        status: "review",
        awaitingPlanApproval: true,
        executionPhase: "plan_complete_waiting_approval",
        errorMessage: null,
      }
    } else if (decision.action === "mark_done") {
      update = {
        status: "done",
        completedAt: now,
        errorMessage: null,
        awaitingPlanApproval: false,
        reviewActivity: "idle",
      }
    } else if (decision.action === "fail_task") {
      update = {
        status: "failed",
        errorMessage: decision.errorMessage || decision.reason,
        awaitingPlanApproval: false,
        reviewActivity: "idle",
      }
    } else if (decision.action === "continue_with_more_reviews") {
      update = {
        status: "backlog",
        reviewCount: 0,
        errorMessage: null,
        reviewActivity: "idle",
      }
    } else {
      update = {
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
        reviewActivity: "idle",
      }
    }

    const updated = this.db.updateTask(taskId, update)
    if (!updated) throw new Error("Task not found")
    this.db.appendAgentOutput(taskId, reasonNote)
    return this.db.getTask(taskId) ?? updated
  }

  async repair(taskId: string, smartRepairHints?: string): Promise<SmartRepairDecision & { task: Task }> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error("Task not found")

    if (typeof smartRepairHints === "string") {
      this.db.updateTask(taskId, { smartRepairHints })
    }

    let decision: SmartRepairDecision
    try {
      decision = await this.decide(taskId)
    } catch (error) {
      const fallback = chooseDeterministicRepairAction(this.db.getTask(taskId) ?? task)
      decision = {
        action: fallback.action,
        reason: `${fallback.reason} (smart repair fallback: ${error instanceof Error ? error.message : String(error)})`,
      }
    }

    const updated = this.applyAction(taskId, decision)
    return { ...decision, task: updated }
  }
}
