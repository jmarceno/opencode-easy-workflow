import type { Task } from "./types"

export type TaskRepairAction = "queue_implementation" | "restore_plan_approval" | "reset_backlog" | "mark_done" | "fail_task"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function getTaggedOutputEntries(agentOutput: string, tag: string): string[] {
  if (!agentOutput.trim()) return []

  const pattern = new RegExp(`\\[${escapeRegExp(tag)}\\]\\s*([\\s\\S]*?)(?=\\n\\[[a-z0-9-]+\\]|$)`, "g")
  const entries: string[] = []
  let match: RegExpExecArray | null = null
  while ((match = pattern.exec(agentOutput)) !== null) {
    const value = match[1]?.trim()
    if (value) entries.push(value)
  }
  return entries
}

export function getLatestTaggedOutput(agentOutput: string, tag: string): string | null {
  const entries = getTaggedOutputEntries(agentOutput, tag)
  return entries.length > 0 ? entries[entries.length - 1] : null
}

export function hasCapturedPlanOutput(agentOutput: string): boolean {
  return getLatestTaggedOutput(agentOutput, "plan") !== null
}

export function hasCapturedRevisionRequest(agentOutput: string): boolean {
  return getLatestTaggedOutput(agentOutput, "user-revision-request") !== null
}

export function hasExecutionOutput(agentOutput: string): boolean {
  return getLatestTaggedOutput(agentOutput, "exec") !== null
}

export function hasAnyAgentOutput(agentOutput: string): boolean {
  return agentOutput.trim().length > 0
}

export function isTaskAwaitingPlanApproval(task: Task): boolean {
  return task.planmode
    && task.status === "review"
    && task.awaitingPlanApproval === true
    && task.executionPhase === "plan_complete_waiting_approval"
    && hasCapturedPlanOutput(task.agentOutput)
}

export function getPlanExecutionEligibility(task: Task): { ok: boolean; reason?: string } {
  if (!task.planmode) return { ok: true }

  if (task.executionPhase === "implementation_pending") {
    if (!hasCapturedPlanOutput(task.agentOutput)) {
      return { ok: false, reason: "approved implementation is missing a captured [plan] block" }
    }
  }

  if (task.executionPhase === "plan_revision_pending") {
    if (!hasCapturedPlanOutput(task.agentOutput)) {
      return { ok: false, reason: "plan revision is missing a captured [plan] block" }
    }
    if (!hasCapturedRevisionRequest(task.agentOutput)) {
      return { ok: false, reason: "plan revision is missing a captured [user-revision-request] block" }
    }
  }

  if (task.executionPhase === "plan_complete_waiting_approval" && !hasCapturedPlanOutput(task.agentOutput)) {
    return { ok: false, reason: "plan approval is missing a captured [plan] block" }
  }

  return { ok: true }
}

export function chooseDeterministicRepairAction(task: Task): { action: TaskRepairAction; reason: string } {
  const hasPlan = hasCapturedPlanOutput(task.agentOutput)
  const hasExec = hasExecutionOutput(task.agentOutput)
  const hasOutput = hasAnyAgentOutput(task.agentOutput)

  if (task.planmode && task.awaitingPlanApproval) {
    if (hasPlan) {
      return {
        action: "queue_implementation",
        reason: "Task is stranded while awaiting plan approval, but a captured plan exists and can be resumed.",
      }
    }
    return {
      action: "fail_task",
      reason: "Task is awaiting plan approval without a captured [plan] block.",
    }
  }

  if (task.planmode && task.executionPhase === "implementation_pending" && hasPlan) {
    return {
      action: "queue_implementation",
      reason: "Task already has an approved plan and should be returned to implementation.",
    }
  }

  if (task.planmode && task.executionPhase === "plan_revision_pending") {
    if (hasPlan) {
      return {
        action: "queue_implementation",
        reason: "Task is stuck in plan revision flow; resume execution so the revision can be processed.",
      }
    }
    return {
      action: "reset_backlog",
      reason: "Task is in plan revision flow without a captured plan to revise.",
    }
  }

  if (task.executionPhase === "implementation_done" || hasExec) {
    return {
      action: "mark_done",
      reason: "Task already appears to have completed implementation output and can be closed.",
    }
  }

  if (!task.planmode && hasOutput && task.status === "review") {
    return {
      action: "mark_done",
      reason: "Standard task is stranded in review with output and no pending automated step.",
    }
  }

  return {
    action: "reset_backlog",
    reason: "Task should be reset to backlog so it can run again from a clean state.",
  }
}
