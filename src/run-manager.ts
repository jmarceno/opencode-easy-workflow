import { buildExecutionGraph, isTaskExecutable, resolveExecutionTasks } from "./execution-plan"
import { KanbanDB } from "./db"
import { Orchestrator } from "./orchestrator"
import { KanbanServer } from "./server"
import type { WorkflowRun } from "./types"

export class WorkflowRunManager {
  private db: KanbanDB
  private server: KanbanServer
  private serverUrl: string | (() => string | null)
  private ownerDirectory: string
  private activeRuns = new Map<string, Promise<void>>()

  constructor(db: KanbanDB, server: KanbanServer, serverUrl: string | (() => string | null), ownerDirectory: string) {
    this.db = db
    this.server = server
    this.serverUrl = serverUrl
    this.ownerDirectory = ownerDirectory
  }

  hasRunningRuns(): boolean {
    return this.db.countConsumedWorkflowSlots() > 0
  }

  private getSlotCapacityError(): string | null {
    const options = this.db.getOptions()
    if (this.db.countConsumedWorkflowSlots() >= options.parallelTasks) {
      return `All ${options.parallelTasks} workflow slot${options.parallelTasks === 1 ? " is" : "s are"} in use`
    }
    return null
  }

  getRunStartError(taskId?: string): string | null {
    const slotError = this.getSlotCapacityError()
    if (slotError) return slotError

    const taskIds = taskId
      ? this.resolveSingleTaskOrder(taskId)
      : this.resolveWorkflowTaskOrder()

    if (taskIds.length === 0) {
      return "No tasks in backlog"
    }

    for (const candidateTaskId of taskIds) {
      const activeRun = this.db.getActiveWorkflowRunForTask(candidateTaskId)
      if (activeRun) {
        const task = this.db.getTask(candidateTaskId)
        const label = task?.name ?? candidateTaskId
        return `Task \"${label}\" is already executing in run ${activeRun.id}`
      }
    }

    return null
  }

  startAll(): WorkflowRun {
    const taskIds = this.resolveWorkflowTaskOrder()
    const run = this.db.createWorkflowRun({
      kind: "all_tasks",
      displayName: `Workflow run (${taskIds.length} task${taskIds.length === 1 ? "" : "s"})`,
      taskOrder: taskIds,
      color: this.db.getNextRunColor(),
    })
    this.server.broadcast({ type: "run_created", payload: run })
    void this.ensureRunProcessing(run.id)
    return run
  }

  startSingle(taskId: string): WorkflowRun {
    const taskIds = this.resolveSingleTaskOrder(taskId)
    const targetTask = this.db.getTask(taskId)
    const run = this.db.createWorkflowRun({
      kind: "single_task",
      displayName: targetTask ? `Task run: ${targetTask.name}` : `Task run: ${taskId}`,
      targetTaskId: taskId,
      taskOrder: taskIds,
      color: this.db.getNextRunColor(),
    })
    this.server.broadcast({ type: "run_created", payload: run })
    void this.ensureRunProcessing(run.id)
    return run
  }

  pauseRun(runId: string): WorkflowRun | null {
    const run = this.db.getWorkflowRun(runId)
    if (!run) return null
    if (run.status !== "running" && run.status !== "stopping") return run
    const updated = this.db.updateWorkflowRun(runId, { pauseRequested: true })
    if (updated) this.server.broadcast({ type: "run_updated", payload: updated })
    return updated
  }

  stopRun(runId: string): WorkflowRun | null {
    const run = this.db.getWorkflowRun(runId)
    if (!run) return null
    if (run.status === "paused") {
      const updated = this.finishRun(runId, "failed", "Run stopped by user")
      return updated
    }
    if (run.status !== "running" && run.status !== "stopping") return run
    const updated = this.db.updateWorkflowRun(runId, {
      status: "stopping",
      stopRequested: true,
    })
    if (updated) this.server.broadcast({ type: "run_updated", payload: updated })
    return updated
  }

  resumeRun(runId: string): WorkflowRun | null {
    const run = this.db.getWorkflowRun(runId)
    if (!run) return null
    if (run.status !== "paused") return run
    const slotError = this.getSlotCapacityError()
    if (slotError) {
      throw new Error(slotError)
    }
    const updated = this.db.updateWorkflowRun(runId, {
      status: "running",
      pauseRequested: false,
      stopRequested: false,
      errorMessage: null,
      finishedAt: null,
    })
    if (updated) {
      this.server.broadcast({ type: "run_updated", payload: updated })
      void this.ensureRunProcessing(runId)
    }
    return updated
  }

  async recoverStaleRuns(onRepairTask: (taskId: string) => Promise<void>): Promise<WorkflowRun[]> {
    const staleRuns = this.db.failStaleWorkflowRuns()
    for (const run of staleRuns) {
      this.server.broadcast({ type: "run_updated", payload: run })
      if (run.currentTaskId) {
        await onRepairTask(run.currentTaskId)
      }
    }
    return staleRuns
  }

  async stopAllActiveRuns(): Promise<void> {
    const runs = this.db.getActiveWorkflowRuns()
    for (const run of runs) {
      this.stopRun(run.id)
    }
  }

  private resolveWorkflowTaskOrder(): string[] {
    const tasks = this.db.getTasks()
    const graph = buildExecutionGraph(tasks, 1)
    return graph.batches.flatMap((batch) => batch.taskIds)
  }

  private resolveSingleTaskOrder(taskId: string): string[] {
    return resolveExecutionTasks(this.db.getTasks(), taskId).map((task) => task.id)
  }

  private async ensureRunProcessing(runId: string): Promise<void> {
    if (this.activeRuns.has(runId)) {
      return this.activeRuns.get(runId)!
    }

    const promise = this.processRun(runId)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        this.finishRun(runId, "failed", message)
      })
      .finally(() => {
        this.activeRuns.delete(runId)
      })

    this.activeRuns.set(runId, promise)
    await promise
  }

  private async processRun(runId: string): Promise<void> {
    while (true) {
      const run = this.db.getWorkflowRun(runId)
      if (!run) return
      if (run.status === "completed" || run.status === "failed" || run.status === "paused") return

      const nextTaskId = run.taskOrder[run.currentTaskIndex]
      if (!nextTaskId) {
        this.finishRun(runId, "completed", null)
        this.server.handleWorkflowComplete()
        return
      }

      const task = this.db.getTask(nextTaskId)
      if (!task) {
        throw new Error(`Task ${nextTaskId} was removed before execution could start`)
      }

      if (task.status === "done") {
        const advanced = this.db.updateWorkflowRun(runId, {
          currentTaskIndex: run.currentTaskIndex + 1,
          currentTaskId: null,
        })
        if (advanced) this.server.broadcast({ type: "run_updated", payload: advanced })
        continue
      }

      if (!isTaskExecutable(task)) {
        throw new Error(`Task \"${task.name}\" is no longer executable from status \"${task.status}\"`)
      }

      const conflictingRun = this.db.getActiveWorkflowRunForTask(task.id)
      if (conflictingRun && conflictingRun.id !== runId) {
        throw new Error(`Task \"${task.name}\" is already executing in run ${conflictingRun.id}`)
      }

      const runningState = this.db.updateWorkflowRun(runId, {
        status: run.stopRequested ? "stopping" : "running",
        currentTaskId: task.id,
        errorMessage: null,
      })
      if (runningState) this.server.broadcast({ type: "run_updated", payload: runningState })

      const orchestrator = new Orchestrator(this.db, this.server, this.serverUrl, this.ownerDirectory, this.ownerDirectory)
      await orchestrator.runTaskSequence([task.id], false)

      const latestRun = this.db.getWorkflowRun(runId)
      if (!latestRun) return
      const nextIndex = latestRun.currentTaskIndex + 1

      if (latestRun.stopRequested) {
        this.finishRun(runId, "failed", "Run stopped by user", nextIndex)
        return
      }

      if (latestRun.pauseRequested) {
        const paused = this.db.updateWorkflowRun(runId, {
          status: "paused",
          currentTaskId: null,
          currentTaskIndex: nextIndex,
          pauseRequested: false,
          errorMessage: null,
        })
        if (paused) this.server.broadcast({ type: "run_updated", payload: paused })
        return
      }

      const advanced = this.db.updateWorkflowRun(runId, {
        status: "running",
        currentTaskId: null,
        currentTaskIndex: nextIndex,
      })
      if (advanced) this.server.broadcast({ type: "run_updated", payload: advanced })
    }
  }

  private finishRun(runId: string, status: "completed" | "failed", errorMessage: string | null, currentTaskIndex?: number): WorkflowRun | null {
    const run = this.db.getWorkflowRun(runId)
    if (!run) return null
    const finishedAt = Math.floor(Date.now() / 1000)
    const updated = this.db.updateWorkflowRun(runId, {
      status,
      currentTaskId: null,
      currentTaskIndex: currentTaskIndex ?? run.currentTaskIndex,
      pauseRequested: false,
      stopRequested: false,
      errorMessage,
      finishedAt,
    })
    if (updated) this.server.broadcast({ type: "run_updated", payload: updated })
    return updated
  }
}
