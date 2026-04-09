import { existsSync } from "fs"
import type { PiKanbanDB } from "../db.ts"
import type { WSMessage } from "../types.ts"
import { chooseDeterministicRepairAction } from "../task-state.ts"
import { SmartRepairService, type SmartRepairDecision } from "../runtime/smart-repair.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function log(line: string): void {
  console.log(`[startup-recovery] ${line}`)
}

function needsTaskRecovery(task: { status: string; reviewActivity: string }): boolean {
  return task.status === "executing" || (task.status === "review" && task.reviewActivity === "running")
}

export async function runStartupRecovery(args: {
  db: PiKanbanDB
  broadcast: (message: WSMessage) => void
}): Promise<void> {
  const { db, broadcast } = args
  const repair = new SmartRepairService(db)
  const recoveryStartedAt = nowUnix()

  const staleTasks = db.getTasks().filter(needsTaskRecovery)
  for (const task of staleTasks) {
    try {
      let decision: SmartRepairDecision
      if (task.status === "executing" && (!task.worktreeDir || !existsSync(task.worktreeDir))) {
        decision = {
          action: "reset_backlog",
          reason: "Startup recovery: task was executing without a valid worktree directory",
        }
      } else {
        const deterministic = chooseDeterministicRepairAction(task)
        decision = {
          action: deterministic.action,
          reason: `Startup recovery: ${deterministic.reason}`,
        }
      }

      const updated = repair.applyAction(task.id, decision)
      broadcast({ type: "task_updated", payload: updated })
      log(`Recovered task ${task.id} with action=${decision.action}`)
    } catch (error) {
      log(`Failed to recover task ${task.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const orphanSessions = db
    .getActiveWorkflowSessions()
    .filter((session) => {
      if (session.status !== "starting" && session.status !== "active") return false
      return session.startedAt < (recoveryStartedAt - 3600)
    })

  for (const session of orphanSessions) {
    db.updateWorkflowSession(session.id, {
      status: "failed",
      errorMessage: "Server restarted during execution",
      finishedAt: recoveryStartedAt,
    })
    db.appendSessionIO({
      sessionId: session.id,
      stream: "server",
      recordType: "lifecycle",
      payloadJson: {
        type: "startup_recovery_session_failed",
        reason: "Server restarted during execution",
      },
    })
    log(`Marked orphaned session ${session.id} as failed`)
  }
}
