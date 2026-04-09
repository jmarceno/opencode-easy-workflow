import type { PiKanbanDB } from "../db.ts"
import {
  buildBestOfNFinalApplierVariables,
  buildBestOfNReviewerVariables,
  buildBestOfNWorkerVariables,
} from "../prompts/index.ts"
import type {
  AggregatedReviewResult,
  Options,
  ReviewerOutput,
  SelectionMode,
  Task,
  TaskCandidate,
  TaskRun,
  WSMessage,
} from "../types.ts"
import { parseStrictJsonObject } from "./strict-json.ts"
import { PiSessionManager } from "./session-manager.ts"
import { getChangedFiles, getDiffStats, resolveTargetBranch, WorktreeLifecycle } from "./worktree.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function appendTaggedOutput(db: PiKanbanDB, taskId: string, tag: string, text: string): string {
  const output = trimText(text)
  if (!output) return ""
  const chunk = `\n[${tag}]\n${output}\n`
  db.appendAgentOutput(taskId, chunk)
  return chunk
}

function summaryText(value: string, maxLength: number): string {
  if (!value) return ""
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}

function toReviewerOutput(text: string): ReviewerOutput {
  const parsed = parseStrictJsonObject(text, "Best-of-n reviewer response")

  const status = parsed.status === "pass" || parsed.status === "needs_manual_review"
    ? parsed.status
    : "needs_manual_review"

  const bestCandidateIds = Array.isArray(parsed.bestCandidateIds)
    ? parsed.bestCandidateIds.map((item) => String(item)).filter(Boolean)
    : []

  const gaps = Array.isArray(parsed.gaps)
    ? parsed.gaps.map((item) => String(item)).filter(Boolean)
    : []

  const recommendedFinalStrategy = parsed.recommendedFinalStrategy === "pick_best"
    || parsed.recommendedFinalStrategy === "synthesize"
    || parsed.recommendedFinalStrategy === "pick_or_synthesize"
    ? parsed.recommendedFinalStrategy
    : "synthesize"

  return {
    status,
    summary: trimText(parsed.summary) || "No summary provided",
    bestCandidateIds,
    gaps,
    recommendedFinalStrategy,
    recommendedPrompt: trimText(parsed.recommendedPrompt) || null,
  }
}

function aggregateReviewerOutputs(outputs: ReviewerOutput[]): AggregatedReviewResult {
  const candidateVoteCounts: Record<string, number> = {}
  const recurringGaps: string[] = []
  const recurringRisks: string[] = []
  const strategyVotes: Record<SelectionMode, number> = {
    pick_best: 0,
    synthesize: 0,
    pick_or_synthesize: 0,
  }

  for (const output of outputs) {
    strategyVotes[output.recommendedFinalStrategy] += 1
    for (const candidateId of output.bestCandidateIds) {
      candidateVoteCounts[candidateId] = (candidateVoteCounts[candidateId] || 0) + 1
    }
    for (const gap of output.gaps) {
      if (!recurringGaps.includes(gap)) recurringGaps.push(gap)
    }
  }

  const voteEntries = Object.entries(candidateVoteCounts)
  const topVote = voteEntries.sort(([, left], [, right]) => right - left)[0]
  const consensusReached = Boolean(topVote && topVote[1] === outputs.length && outputs.length > 0)

  const recommendedFinalStrategy = (Object.entries(strategyVotes)
    .sort(([, left], [, right]) => right - left)[0]?.[0] as SelectionMode | undefined)
    ?? "synthesize"

  return {
    candidateVoteCounts,
    recurringRisks,
    recurringGaps,
    consensusReached,
    recommendedFinalStrategy,
    usableResults: outputs,
  }
}

function expandSlots(slots: Array<{ model: string; count: number; taskSuffix?: string }>): Array<{
  slotIndex: number
  attemptIndex: number
  model: string
  taskSuffix?: string
}> {
  const expanded: Array<{ slotIndex: number; attemptIndex: number; model: string; taskSuffix?: string }> = []
  let slotIndex = 0
  for (const slot of slots) {
    for (let attemptIndex = 0; attemptIndex < slot.count; attemptIndex++) {
      expanded.push({ slotIndex, attemptIndex, model: slot.model, taskSuffix: slot.taskSuffix })
      slotIndex++
    }
  }
  return expanded
}

export class BestOfNRunner {
  private readonly sessions: PiSessionManager

  constructor(private readonly deps: {
    db: PiKanbanDB
    projectRoot: string
    worktree: WorktreeLifecycle
    broadcast: (message: WSMessage) => void
    sessionUrlFor: (sessionId: string) => string
  }) {
    this.sessions = new PiSessionManager(this.deps.db)
  }

  async run(task: Task, options: Options): Promise<void> {
    if (!task.bestOfNConfig) {
      throw new Error(`Task ${task.id} has executionStrategy=best_of_n but missing bestOfNConfig`)
    }

    this.deps.db.updateTask(task.id, {
      status: "executing",
      bestOfNSubstage: "workers_running",
      errorMessage: null,
      agentOutput: "",
    })
    this.broadcastTask(task.id)

    const workerRuns = expandSlots(task.bestOfNConfig.workers)
    for (const worker of workerRuns) {
      const run = this.deps.db.createTaskRun({
        taskId: task.id,
        phase: "worker",
        slotIndex: worker.slotIndex,
        attemptIndex: worker.attemptIndex,
        model: worker.model,
        taskSuffix: worker.taskSuffix ?? null,
        status: "pending",
      })
      this.deps.broadcast({ type: "task_run_created", payload: run })
    }

    await Promise.all(this.deps.db.getTaskRunsByPhase(task.id, "worker").map((run) => this.runWorker(task.id, run, options)))

    const successfulWorkers = this.deps.db.getTaskRunsByPhase(task.id, "worker").filter((run) => run.status === "done")
    if (successfulWorkers.length < task.bestOfNConfig.minSuccessfulWorkers) {
      throw new Error(`Best-of-n failed: ${successfulWorkers.length} successful workers < required ${task.bestOfNConfig.minSuccessfulWorkers}`)
    }

    const candidates = this.deps.db.getTaskCandidates(task.id)
    let aggregatedReview: AggregatedReviewResult = {
      candidateVoteCounts: {},
      recurringRisks: [],
      recurringGaps: [],
      consensusReached: false,
      recommendedFinalStrategy: task.bestOfNConfig.selectionMode,
      usableResults: [],
    }

    if (task.bestOfNConfig.reviewers.length > 0) {
      this.deps.db.updateTask(task.id, { bestOfNSubstage: "reviewers_running" })
      this.broadcastTask(task.id)

      const reviewerRuns = expandSlots(task.bestOfNConfig.reviewers)
      for (const reviewer of reviewerRuns) {
        const run = this.deps.db.createTaskRun({
          taskId: task.id,
          phase: "reviewer",
          slotIndex: reviewer.slotIndex,
          attemptIndex: reviewer.attemptIndex,
          model: reviewer.model,
          taskSuffix: reviewer.taskSuffix ?? null,
          status: "pending",
        })
        this.deps.broadcast({ type: "task_run_created", payload: run })
      }

      await Promise.all(this.deps.db.getTaskRunsByPhase(task.id, "reviewer").map((run) => this.runReviewer(task.id, run, candidates, options)))

      const usableResults = this.deps.db
        .getTaskRunsByPhase(task.id, "reviewer")
        .filter((run) => run.status === "done" && Boolean(run.metadataJson?.reviewerOutput))
        .map((run) => run.metadataJson?.reviewerOutput as ReviewerOutput)

      if (usableResults.length === 0) {
        this.deps.db.updateTask(task.id, {
          status: "review",
          bestOfNSubstage: "blocked_for_manual_review",
          errorMessage: "No usable reviewer results available",
        })
        this.broadcastTask(task.id)
        return
      }

      aggregatedReview = aggregateReviewerOutputs(usableResults)

      const reviewerRequestedManual = usableResults.some((result) => result.status === "needs_manual_review")
      if (reviewerRequestedManual || (!aggregatedReview.consensusReached && task.bestOfNConfig.selectionMode === "pick_best")) {
        this.deps.db.updateTask(task.id, {
          status: "review",
          bestOfNSubstage: "blocked_for_manual_review",
          errorMessage: reviewerRequestedManual
            ? "One or more reviewers requested manual review"
            : "Reviewer consensus missing for pick_best mode",
        })
        this.broadcastTask(task.id)
        return
      }
    }

    this.deps.db.updateTask(task.id, { bestOfNSubstage: "final_apply_running" })
    this.broadcastTask(task.id)

    const finalRun = this.deps.db.createTaskRun({
      taskId: task.id,
      phase: "final_applier",
      slotIndex: 0,
      attemptIndex: 0,
      model: task.bestOfNConfig.finalApplier.model,
      taskSuffix: task.bestOfNConfig.finalApplier.taskSuffix ?? null,
      status: "pending",
    })
    this.deps.broadcast({ type: "task_run_created", payload: finalRun })

    await this.runFinalApplier(task.id, finalRun.id, candidates, aggregatedReview, options)

    this.deps.db.updateTask(task.id, {
      status: "done",
      bestOfNSubstage: "completed",
      completedAt: nowUnix(),
      errorMessage: null,
    })
    this.broadcastTask(task.id)
  }

  private async runWorker(taskId: string, workerRun: TaskRun, options: Options): Promise<void> {
    const task = this.deps.db.getTask(taskId)
    if (!task || !task.bestOfNConfig) return

    let worktreeDir: string | null = null
    try {
      this.deps.db.updateTaskRun(workerRun.id, { status: "running" })
      this.broadcastRun(workerRun.id)

      const worktreeInfo = await this.deps.worktree.createForRun(workerRun.id, "bon-worker")
      worktreeDir = worktreeInfo.directory
      this.deps.db.updateTaskRun(workerRun.id, { worktreeDir })
      this.broadcastRun(workerRun.id)

      const prompt = this.deps.db.renderPrompt(
        "best_of_n_worker",
        buildBestOfNWorkerVariables(task, workerRun.slotIndex, workerRun.model, options.extraPrompt, workerRun.taskSuffix ?? undefined),
      )
      const outputChunks: string[] = []
      const response = await this.sessions.executePrompt({
        taskId,
        taskRunId: workerRun.id,
        sessionKind: "task_run_worker",
        cwd: worktreeDir,
        worktreeDir,
        branch: worktreeInfo.branch,
        model: workerRun.model,
        thinkingLevel: task.thinkingLevel,
        promptText: prompt.renderedText,
        onOutput: (chunk) => {
          if (!trimText(chunk)) return
          outputChunks.push(chunk)
          const tagged = appendTaggedOutput(this.deps.db, taskId, `worker-${workerRun.slotIndex}`, chunk)
          if (tagged) this.deps.broadcast({ type: "agent_output", payload: { taskId, output: tagged } })
        },
      })

      this.deps.db.updateTaskRun(workerRun.id, {
        sessionId: response.session.id,
        sessionUrl: this.deps.sessionUrlFor(response.session.id),
      })
      this.broadcastRun(workerRun.id)

      const verificationJson = await this.runVerificationCommand(
        trimText(task.bestOfNConfig.verificationCommand),
        worktreeDir,
      )

      const changedFiles = await getChangedFiles(worktreeDir)
      const diff = await getDiffStats(worktreeDir)
      const diffStatsJson: Record<string, number> = {}
      for (const [filePath, stat] of Object.entries(diff.fileStats)) {
        diffStatsJson[filePath] = stat.insertions + stat.deletions
      }

      const summary = trimText(response.responseText) || summaryText(outputChunks.join("\n"), 1000)
      const candidate = this.deps.db.createTaskCandidate({
        taskId,
        workerRunId: workerRun.id,
        status: "available",
        changedFilesJson: changedFiles,
        diffStatsJson,
        verificationJson,
        summary: summaryText(summary, 1000) || null,
        errorMessage: null,
      })
      this.deps.broadcast({ type: "task_candidate_created", payload: candidate })

      this.deps.db.updateTaskRun(workerRun.id, {
        status: "done",
        summary: summaryText(summary, 500) || null,
        candidateId: candidate.id,
        metadataJson: {
          verificationJson,
          changedFiles,
          diff,
        },
        completedAt: nowUnix(),
      })
      this.broadcastRun(workerRun.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.db.updateTaskRun(workerRun.id, {
        status: "failed",
        errorMessage: message,
        completedAt: nowUnix(),
      })
      this.broadcastRun(workerRun.id)
    } finally {
      if (worktreeDir && task.deleteWorktree !== false) {
        await this.deps.worktree.complete(worktreeDir, {
          branch: "",
          targetBranch: "",
          shouldMerge: false,
          shouldRemove: true,
        }).catch(() => undefined)
      }
    }
  }

  private async runReviewer(taskId: string, reviewerRun: TaskRun, candidates: TaskCandidate[], options: Options): Promise<void> {
    const task = this.deps.db.getTask(taskId)
    if (!task) return

    try {
      this.deps.db.updateTaskRun(reviewerRun.id, { status: "running" })
      this.broadcastRun(reviewerRun.id)

      const prompt = this.deps.db.renderPrompt(
        "best_of_n_reviewer",
        buildBestOfNReviewerVariables(task, candidates, options.extraPrompt, reviewerRun.taskSuffix ?? undefined),
      )

      const response = await this.sessions.executePrompt({
        taskId,
        taskRunId: reviewerRun.id,
        sessionKind: "task_run_reviewer",
        cwd: this.deps.projectRoot,
        model: reviewerRun.model,
        thinkingLevel: task.thinkingLevel,
        promptText: prompt.renderedText,
      })

      const reviewerOutput = toReviewerOutput(response.responseText)
      this.deps.db.updateTaskRun(reviewerRun.id, {
        status: "done",
        sessionId: response.session.id,
        sessionUrl: this.deps.sessionUrlFor(response.session.id),
        summary: summaryText(reviewerOutput.summary, 500),
        metadataJson: { reviewerOutput },
        completedAt: nowUnix(),
      })
      this.broadcastRun(reviewerRun.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.db.updateTaskRun(reviewerRun.id, {
        status: "failed",
        errorMessage: message,
        completedAt: nowUnix(),
      })
      this.broadcastRun(reviewerRun.id)
    }
  }

  private async runFinalApplier(
    taskId: string,
    finalRunId: string,
    candidates: TaskCandidate[],
    aggregatedReview: AggregatedReviewResult,
    options: Options,
  ): Promise<void> {
    const task = this.deps.db.getTask(taskId)
    if (!task || !task.bestOfNConfig) return

    const finalRun = this.deps.db.getTaskRun(finalRunId)
    if (!finalRun) throw new Error("Final applier run not found")

    let worktreeDir: string | null = null
    try {
      this.deps.db.updateTaskRun(finalRun.id, { status: "running" })
      this.broadcastRun(finalRun.id)

      const worktreeInfo = await this.deps.worktree.createForRun(finalRun.id, "bon-final")
      worktreeDir = worktreeInfo.directory
      this.deps.db.updateTaskRun(finalRun.id, { worktreeDir })
      this.broadcastRun(finalRun.id)

      const selectionMode: SelectionMode = task.bestOfNConfig.selectionMode === "pick_or_synthesize"
        ? (aggregatedReview.recommendedFinalStrategy || "pick_or_synthesize")
        : task.bestOfNConfig.selectionMode

      const prompt = this.deps.db.renderPrompt(
        "best_of_n_final_applier",
        buildBestOfNFinalApplierVariables(
          task,
          candidates,
          aggregatedReview,
          selectionMode,
          options.extraPrompt,
          finalRun.taskSuffix ?? undefined,
        ),
      )

      const outputChunks: string[] = []
      const response = await this.sessions.executePrompt({
        taskId,
        taskRunId: finalRun.id,
        sessionKind: "task_run_final_applier",
        cwd: worktreeDir,
        worktreeDir,
        branch: worktreeInfo.branch,
        model: finalRun.model,
        thinkingLevel: task.thinkingLevel,
        promptText: prompt.renderedText,
        onOutput: (chunk) => {
          if (!trimText(chunk)) return
          outputChunks.push(chunk)
          const tagged = appendTaggedOutput(this.deps.db, taskId, "final-applier", chunk)
          if (tagged) this.deps.broadcast({ type: "agent_output", payload: { taskId, output: tagged } })
        },
      })

      this.deps.db.updateTaskRun(finalRun.id, {
        sessionId: response.session.id,
        sessionUrl: this.deps.sessionUrlFor(response.session.id),
      })
      this.broadcastRun(finalRun.id)

      const verificationJson = await this.runVerificationCommand(trimText(task.bestOfNConfig.verificationCommand), worktreeDir)

      if (Object.keys(aggregatedReview.candidateVoteCounts).length > 0) {
        const votedCandidateId = Object.entries(aggregatedReview.candidateVoteCounts)
          .sort(([, left], [, right]) => right - left)[0]?.[0]
        const selectedCandidateId = candidates.some((candidate) => candidate.id === votedCandidateId)
          ? votedCandidateId
          : candidates[0]?.id
        if (selectedCandidateId) {
          for (const candidate of candidates) {
            const nextStatus = candidate.id === selectedCandidateId ? "selected" : "rejected"
            const updated = this.deps.db.updateTaskCandidate(candidate.id, { status: nextStatus })
            if (updated) this.deps.broadcast({ type: "task_candidate_updated", payload: updated })
          }
        }
      }

      const targetBranch = await resolveTargetBranch({
        baseDirectory: this.deps.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      })
      await this.deps.worktree.complete(worktreeDir, {
        branch: worktreeInfo.branch,
        targetBranch,
        shouldMerge: true,
        shouldRemove: task.deleteWorktree !== false,
      })

      const summary = trimText(response.responseText) || summaryText(outputChunks.join("\n"), 1000)
      this.deps.db.updateTaskRun(finalRun.id, {
        status: "done",
        summary: summaryText(summary, 500),
        metadataJson: { verificationJson },
        completedAt: nowUnix(),
      })
      this.broadcastRun(finalRun.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.db.updateTaskRun(finalRun.id, {
        status: "failed",
        errorMessage: message,
        completedAt: nowUnix(),
      })
      this.broadcastRun(finalRun.id)
      throw new Error(`Best-of-n final applier failed: ${message}`)
    }
  }

  private async runVerificationCommand(command: string, cwd: string): Promise<Record<string, unknown>> {
    if (!command) return { status: "skipped", reason: "No verification command configured" }

    try {
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      return {
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        stdout: summaryText(stdout, 8_000),
        stderr: summaryText(stderr, 8_000),
      }
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private broadcastTask(taskId: string): void {
    const task = this.deps.db.getTask(taskId)
    if (!task) return
    this.deps.broadcast({ type: "task_updated", payload: task })
  }

  private broadcastRun(taskRunId: string): void {
    const run = this.deps.db.getTaskRun(taskRunId)
    if (!run) return
    this.deps.broadcast({ type: "task_run_updated", payload: run })
  }
}
