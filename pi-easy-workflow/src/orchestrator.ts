import { randomUUID } from "crypto"
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { buildExecutionVariables, buildPlanningVariables, buildPlanRevisionVariables, buildCommitVariables, buildReviewFixVariables } from "./prompts/index.ts"
import { getLatestTaggedOutput, getPlanExecutionEligibility } from "./task-state.ts"
import type { PiKanbanDB } from "./db.ts"
import type { PiSessionKind, PiWorkflowSession } from "./db/types.ts"
import type { Options, Task, WSMessage, WorkflowRun } from "./types.ts"
import { resolveExecutionTasks, getExecutionGraphTasks } from "./execution-plan.ts"
import { PiSessionManager } from "./runtime/session-manager.ts"
import { PiReviewSessionRunner } from "./runtime/review-session.ts"
import { BestOfNRunner } from "./runtime/best-of-n.ts"
import { WorktreeLifecycle, resolveTargetBranch, listWorktrees, type WorktreeInfo } from "./runtime/worktree.ts"

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

function stripAndNormalize(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n")
}

function tagOutput(tag: string, text: string): string {
  return text.trim() ? `\n[${tag}]\n${text.trim()}\n` : ""
}

async function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
  return { stdout, stderr, exitCode }
}

export class PiOrchestrator {
  private running = false
  private shouldStop = false
  private currentRunId: string | null = null
  private readonly sessionManager: PiSessionManager
  private readonly reviewRunner: PiReviewSessionRunner
  private readonly worktree: WorktreeLifecycle

  constructor(
    private readonly db: PiKanbanDB,
    private readonly broadcast: (message: WSMessage) => void,
    private readonly sessionUrlFor: (sessionId: string) => string,
    private readonly projectRoot = process.cwd(),
  ) {
    this.sessionManager = new PiSessionManager(db)
    this.reviewRunner = new PiReviewSessionRunner(db)
    this.worktree = new WorktreeLifecycle({ baseDirectory: this.projectRoot })
  }

  async startAll(): Promise<WorkflowRun> {
    if (this.running) throw new Error("Already executing")

    // Use getExecutionGraphTasks to get ALL tasks that will run,
    // including those whose dependencies will be satisfied during this run
    const tasks = getExecutionGraphTasks(this.db.getTasks())

    if (tasks.length === 0) throw new Error("No tasks in backlog")

    const run = this.db.createWorkflowRun({
      id: randomUUID().slice(0, 8),
      kind: "all_tasks",
      status: "running",
      displayName: "Workflow run",
      taskOrder: tasks.map((task) => task.id),
      currentTaskId: tasks[0]?.id ?? null,
      currentTaskIndex: 0,
    })

    this.currentRunId = run.id
    this.running = true
    this.shouldStop = false
    this.broadcast({ type: "run_created", payload: run })
    this.broadcast({ type: "execution_started", payload: {} })

    void this.runInBackground(run.id, tasks.map((task) => task.id))
    return run
  }

  async startSingle(taskId: string): Promise<WorkflowRun> {
    if (this.running) throw new Error("Already executing")
    const chain = resolveExecutionTasks(this.db.getTasks(), taskId)
    if (chain.length === 0) throw new Error("No tasks in backlog")
    const target = this.db.getTask(taskId)
    if (!target) throw new Error("Task not found")

    const run = this.db.createWorkflowRun({
      id: randomUUID().slice(0, 8),
      kind: "single_task",
      status: "running",
      displayName: `Single task: ${target.name}`,
      targetTaskId: target.id,
      taskOrder: chain.map((task) => task.id),
      currentTaskId: chain[0]?.id ?? null,
      currentTaskIndex: 0,
    })

    this.currentRunId = run.id
    this.running = true
    this.shouldStop = false
    this.broadcast({ type: "run_created", payload: run })

    void this.runInBackground(run.id, chain.map((task) => task.id))
    return run
  }

  async stop(): Promise<void> {
    this.shouldStop = true
    if (!this.currentRunId) return
    const updated = this.db.updateWorkflowRun(this.currentRunId, {
      status: "stopping",
      stopRequested: true,
    })
    if (updated) this.broadcast({ type: "run_updated", payload: updated })
  }

  private async runInBackground(runId: string, taskIds: string[]): Promise<void> {
    const executedTaskIds = new Set<string>()

    try {
      for (let index = 0; index < taskIds.length; index++) {
        if (this.shouldStop) break

        const taskId = taskIds[index]
        const task = this.db.getTask(taskId)
        if (!task) continue

        // Validate dependencies are satisfied (either already done or executed in this run)
        for (const depId of task.requirements) {
          const dep = this.db.getTask(depId)
          if (dep && dep.status !== "done" && !executedTaskIds.has(depId)) {
            const msg = `Dependency "${dep.name}" is not done (status: ${dep.status})`
            this.db.updateTask(task.id, { status: "failed", errorMessage: msg })
            this.broadcastTask(task.id)
            throw new Error(msg)
          }
        }

        const updatedRun = this.db.updateWorkflowRun(runId, {
          currentTaskId: task.id,
          currentTaskIndex: index,
        })
        if (updatedRun) this.broadcast({ type: "run_updated", payload: updatedRun })

        await this.executeTask(task, this.db.getOptions())
        executedTaskIds.add(taskId)
      }

      const finalRun = this.db.updateWorkflowRun(runId, {
        status: this.shouldStop ? "completed" : "completed",
        stopRequested: this.shouldStop,
        finishedAt: nowUnix(),
      })
      if (finalRun) this.broadcast({ type: "run_updated", payload: finalRun })
      this.broadcast({ type: "execution_complete", payload: {} })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed = this.db.updateWorkflowRun(runId, {
        status: "failed",
        errorMessage: message,
        finishedAt: nowUnix(),
      })
      if (failed) this.broadcast({ type: "run_updated", payload: failed })
      this.broadcast({ type: "error", payload: { message } })
    } finally {
      this.running = false
      this.currentRunId = null
      this.broadcast({ type: "execution_stopped", payload: {} })
    }
  }

  private async executeTask(task: Task, options: Options): Promise<void> {
    const eligibility = getPlanExecutionEligibility(task)
    if (!eligibility.ok) throw new Error(`Task state is invalid: ${eligibility.reason}`)

    for (const depId of task.requirements) {
      const dep = this.db.getTask(depId)
      if (dep && dep.status !== "done") {
        throw new Error(`Dependency "${dep.name}" is not done (status: ${dep.status})`)
      }
    }

    if (task.executionStrategy === "best_of_n") {
      const command = options.command.trim()
      if (command) {
        const commandResult = await runShellCommand(command, this.projectRoot)
        if (commandResult.stdout.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stdout]\n${commandResult.stdout.trim()}\n`)
        }
        if (commandResult.stderr.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stderr]\n${commandResult.stderr.trim()}\n`)
        }
        this.broadcastTask(task.id)
        if (commandResult.exitCode !== 0) {
          throw new Error(`Pre-execution command failed with exit code ${commandResult.exitCode}`)
        }
      }

      const bestOfNRunner = new BestOfNRunner({
        db: this.db,
        projectRoot: this.projectRoot,
        worktree: this.worktree,
        broadcast: this.broadcast,
        sessionUrlFor: this.sessionUrlFor,
      })
      await bestOfNRunner.run(task, options)
      return
    }

    const isPlanResume = task.planmode && (task.executionPhase === "implementation_pending" || task.executionPhase === "plan_revision_pending")
    this.db.updateTask(task.id, {
      status: "executing",
      errorMessage: null,
      ...(isPlanResume ? {} : { agentOutput: "" }),
    })
    this.broadcastTask(task.id)

    let worktreeInfo: WorktreeInfo | null = null
    try {
      // Check if task already has an existing worktree (e.g., from smart repair or previous run)
      // Reuse it if it exists and is still valid
      if (task.worktreeDir && existsSync(task.worktreeDir)) {
        try {
          // Verify it's still a tracked git worktree
          const worktrees = await listWorktrees(this.projectRoot)
          const existingWorktree = worktrees.find(w => w.directory === task.worktreeDir)
          if (existingWorktree) {
            worktreeInfo = existingWorktree
          }
        } catch {
          // If verification fails, fall through to create new worktree
        }
      }
      
      // Create new worktree if we don't have a valid existing one
      if (!worktreeInfo) {
        worktreeInfo = await this.worktree.createForTask(task.id)
        this.db.updateTask(task.id, { worktreeDir: worktreeInfo.directory })
      }
      this.broadcastTask(task.id)

      const command = options.command.trim()
      if (command) {
        const commandResult = await runShellCommand(command, worktreeInfo.directory)
        if (commandResult.stdout.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stdout]\n${commandResult.stdout.trim()}\n`)
        }
        if (commandResult.stderr.trim()) {
          this.db.appendAgentOutput(task.id, `\n[command stderr]\n${commandResult.stderr.trim()}\n`)
        }
        this.broadcastTask(task.id)
        if (commandResult.exitCode !== 0) {
          throw new Error(`Pre-execution command failed with exit code ${commandResult.exitCode}`)
        }
      }

      if (task.planmode) {
        const planContinue = await this.runPlanMode(task.id, task, options, worktreeInfo)
        if (!planContinue) return
      } else {
        await this.runStandardPrompt(task.id, task, options, worktreeInfo)
      }

      if (task.review) {
        const reviewPassed = await this.runReviewLoop(task.id, options, worktreeInfo)
        if (!reviewPassed) return
      }

      if (task.autoCommit) {
        await this.runCommitPrompt(task.id, task, options, worktreeInfo)
      }

      const targetBranch = await resolveTargetBranch({
        baseDirectory: this.projectRoot,
        taskBranch: task.branch,
        optionBranch: options.branch,
      })
      await this.worktree.complete(worktreeInfo.directory, {
        branch: worktreeInfo.branch,
        targetBranch,
        shouldMerge: true,
        shouldRemove: task.deleteWorktree !== false,
      })

      this.db.updateTask(task.id, {
        status: "done",
        completedAt: nowUnix(),
        worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
        executionPhase: task.planmode ? "implementation_done" : undefined,
      })
      this.broadcastTask(task.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.updateTask(task.id, {
        status: "failed",
        errorMessage: message,
        worktreeDir: worktreeInfo?.directory ?? task.worktreeDir,
      })
      this.broadcastTask(task.id)
      throw error
    }
  }

  private buildReviewFile(task: Task, worktreeDir: string): string {
    const reviewDir = join(worktreeDir, ".pi", "easy-workflow")
    mkdirSync(reviewDir, { recursive: true })
    const reviewFilePath = join(reviewDir, `review-${task.id}.md`)
    const reviewContent = [
      `# Review Task: ${task.name}`,
      "",
      "## Goals",
      task.prompt,
      "",
      "## Review Instructions",
      "- Validate implementation completeness against goals.",
      "- Identify bugs, security issues, edge cases, and missing tests.",
      "- Return strict JSON only as instructed by prompt contract.",
    ].join("\n")
    writeFileSync(reviewFilePath, reviewContent, "utf-8")
    return reviewFilePath
  }

  private async runReviewLoop(taskId: string, options: Options, worktreeInfo: WorktreeInfo): Promise<boolean> {
    const originalTask = this.db.getTask(taskId)
    if (!originalTask) return false

    let reviewCount = originalTask.reviewCount
    const maxRuns = originalTask.maxReviewRunsOverride ?? options.maxReviews
    const reviewFilePath = this.buildReviewFile(originalTask, worktreeInfo.directory)

    try {
      while (reviewCount < maxRuns) {
        const task = this.db.getTask(taskId)
        if (!task) return false

        this.db.updateTask(taskId, {
          status: "review",
          reviewCount,
          reviewActivity: "running",
        })
        this.broadcastTask(taskId)

        const reviewRun = await this.reviewRunner.run({
          task,
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          reviewFilePath,
          model: options.reviewModel,
          thinkingLevel: task.thinkingLevel,
        })

        this.db.updateTask(taskId, {
          sessionId: reviewRun.sessionId,
          sessionUrl: this.sessionUrlFor(reviewRun.sessionId),
          reviewActivity: "idle",
        })
        this.broadcastTask(taskId)

        if (reviewRun.reviewResult.status === "pass") {
          this.db.updateTask(taskId, { status: "executing", reviewActivity: "idle" })
          this.broadcastTask(taskId)
          return true
        }

        if (reviewRun.reviewResult.status === "blocked") {
          this.db.updateTask(taskId, {
            status: "stuck",
            reviewCount,
            reviewActivity: "idle",
            errorMessage: `Review blocked: ${reviewRun.reviewResult.summary}`,
          })
          this.broadcastTask(taskId)
          return false
        }

        reviewCount += 1
        this.db.updateTask(taskId, { reviewCount, reviewActivity: "idle" })
        this.broadcastTask(taskId)

        if (reviewCount >= maxRuns) {
          this.db.updateTask(taskId, {
            status: "stuck",
            reviewCount,
            reviewActivity: "idle",
            errorMessage: `Max reviews (${maxRuns}) reached. Gaps: ${reviewRun.reviewResult.gaps.join("; ") || reviewRun.reviewResult.summary}`,
          })
          this.broadcastTask(taskId)
          return false
        }

        const currentTask = this.db.getTask(taskId)
        if (!currentTask) return false
        const fixPromptRendered = this.db.renderPrompt(
          "review_fix",
          buildReviewFixVariables(currentTask, reviewRun.reviewResult.summary, reviewRun.reviewResult.gaps),
        )
        const fixPrompt = reviewRun.reviewResult.recommendedPrompt
          ? `${fixPromptRendered.renderedText}\n\nReviewer recommended prompt:\n${reviewRun.reviewResult.recommendedPrompt}`
          : fixPromptRendered.renderedText

        const fixSession = await this.sessionManager.executePrompt({
          taskId,
          sessionKind: "task",
          cwd: worktreeInfo.directory,
          worktreeDir: worktreeInfo.directory,
          branch: worktreeInfo.branch,
          model: currentTask.executionModel !== "default" ? currentTask.executionModel : options.executionModel,
          thinkingLevel: currentTask.thinkingLevel,
          promptText: fixPrompt,
        })

        this.db.updateTask(taskId, {
          status: "executing",
          sessionId: fixSession.session.id,
          sessionUrl: this.sessionUrlFor(fixSession.session.id),
        })
        if (fixSession.responseText.trim()) {
          this.db.appendAgentOutput(taskId, tagOutput(`review-fix-${reviewCount}`, fixSession.responseText))
          this.broadcast({
            type: "agent_output",
            payload: {
              taskId,
              output: tagOutput(`review-fix-${reviewCount}`, fixSession.responseText),
            },
          })
        }
        this.broadcastTask(taskId)
      }

      return true
    } finally {
      this.db.updateTask(taskId, { reviewActivity: "idle" })
      this.broadcastTask(taskId)
      try {
        unlinkSync(reviewFilePath)
      } catch {
        // best-effort cleanup
      }
    }
  }

  private async runStandardPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<void> {
    const prompt = this.db.renderPrompt("execution", buildExecutionVariables(task, options, worktreeInfo.directory, { isPlanMode: false }))
    const execution = await this.runSessionPrompt({
      task,
      sessionKind: "task",
      cwd: worktreeInfo.directory,
      worktreeDir: worktreeInfo.directory,
      branch: worktreeInfo.branch,
      model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
      promptText: prompt.renderedText,
    })

    if (execution.responseText.trim()) {
      this.db.appendAgentOutput(taskId, `${execution.responseText.trim()}\n`)
      this.broadcastTask(taskId)
    }
  }

  private async runPlanMode(taskId: string, originalTask: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<boolean> {
    let task = this.db.getTask(taskId) ?? originalTask
    const isImplementationResume = task.executionPhase === "implementation_pending"
    const isRevisionResume = task.executionPhase === "plan_revision_pending"

    const planModel = task.planModel !== "default" ? task.planModel : options.planModel

    if (!isImplementationResume && !isRevisionResume) {
      const planningPrompt = this.db.renderPrompt("planning", buildPlanningVariables(task, options))
      const planning = await this.runSessionPrompt({
        task,
        sessionKind: "plan",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: planModel,
        promptText: planningPrompt.renderedText,
      })

      this.db.appendAgentOutput(taskId, tagOutput("plan", planning.responseText))
      this.broadcastTask(taskId)

      task = this.db.getTask(taskId) ?? task
      if (!task.autoApprovePlan) {
        if (task.deleteWorktree !== false) {
          await this.worktree.complete(worktreeInfo.directory, {
            branch: worktreeInfo.branch,
            targetBranch: worktreeInfo.baseRef,
            shouldMerge: false,
            shouldRemove: true,
          })
        }
        this.db.updateTask(taskId, {
          status: "review",
          awaitingPlanApproval: true,
          executionPhase: "plan_complete_waiting_approval",
          worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
        })
        this.broadcastTask(taskId)
        return false
      }

      this.db.updateTask(taskId, {
        awaitingPlanApproval: false,
        executionPhase: "implementation_pending",
      })
      this.broadcastTask(taskId)
      task = this.db.getTask(taskId) ?? task
    }

    if (isRevisionResume) {
      const currentPlan = getLatestTaggedOutput(task.agentOutput, "plan")
      const revisionFeedback = getLatestTaggedOutput(task.agentOutput, "user-revision-request")
      if (!currentPlan || !revisionFeedback) {
        throw new Error("Plan revision is missing captured [plan] or [user-revision-request] data")
      }

      const revisionPrompt = this.db.renderPrompt("plan_revision", buildPlanRevisionVariables(task, currentPlan, revisionFeedback, options))
      const revised = await this.runSessionPrompt({
        task,
        sessionKind: "plan_revision",
        cwd: worktreeInfo.directory,
        worktreeDir: worktreeInfo.directory,
        branch: worktreeInfo.branch,
        model: planModel,
        promptText: revisionPrompt.renderedText,
      })

      this.db.appendAgentOutput(taskId, tagOutput("plan", revised.responseText))
      this.broadcastTask(taskId)

      task = this.db.getTask(taskId) ?? task
      if (!task.autoApprovePlan) {
        if (task.deleteWorktree !== false) {
          await this.worktree.complete(worktreeInfo.directory, {
            branch: worktreeInfo.branch,
            targetBranch: worktreeInfo.baseRef,
            shouldMerge: false,
            shouldRemove: true,
          })
        }
        this.db.updateTask(taskId, {
          status: "review",
          awaitingPlanApproval: true,
          executionPhase: "plan_complete_waiting_approval",
          worktreeDir: task.deleteWorktree !== false ? null : worktreeInfo.directory,
        })
        this.broadcastTask(taskId)
        return false
      }

      this.db.updateTask(taskId, {
        awaitingPlanApproval: false,
        executionPhase: "implementation_pending",
      })
      this.broadcastTask(taskId)
      task = this.db.getTask(taskId) ?? task
    }

    const approvedPlan = getLatestTaggedOutput(task.agentOutput, "plan")
    if (!approvedPlan) {
      throw new Error("Execution prompt failed: no approved [plan] block found")
    }
    const revisionRequests = task.agentOutput
      .match(/\[user-revision-request\]\s*[\s\S]*?(?=\n\[[a-z0-9-]+\]|$)/g)
      ?.map((item) => item.replace(/^\[user-revision-request\]\s*/i, "").trim())
      .filter(Boolean) ?? []
    const approvalNote = getLatestTaggedOutput(task.agentOutput, "user-approval-note")
    const userGuidance = [
      ...revisionRequests.map((value, idx) => `Revision request ${idx + 1}:\n${value}`),
      approvalNote ? `Final approval note:\n${approvalNote}` : "",
    ].filter(Boolean).join("\n\n")

    const executionPrompt = this.db.renderPrompt(
      "execution",
      buildExecutionVariables(task, options, worktreeInfo.directory, {
        approvedPlan,
        userGuidance,
        isPlanMode: true,
      }),
    )

    const execution = await this.runSessionPrompt({
      task,
      sessionKind: "task",
      cwd: worktreeInfo.directory,
      worktreeDir: worktreeInfo.directory,
      branch: worktreeInfo.branch,
      model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
      promptText: executionPrompt.renderedText,
    })

    this.db.appendAgentOutput(taskId, tagOutput("exec", execution.responseText))
    this.db.updateTask(taskId, { executionPhase: "implementation_done" })
    this.broadcastTask(taskId)
    return true
  }

  private async runCommitPrompt(taskId: string, task: Task, options: Options, worktreeInfo: WorktreeInfo): Promise<void> {
    const targetBranch = await resolveTargetBranch({
      baseDirectory: this.projectRoot,
      taskBranch: task.branch,
      optionBranch: options.branch,
    })
    const commitPrompt = this.db.renderPrompt("commit", buildCommitVariables(targetBranch, task.deleteWorktree !== false))

    const commit = await this.runSessionPrompt({
      task,
      sessionKind: "task",
      cwd: worktreeInfo.directory,
      worktreeDir: worktreeInfo.directory,
      branch: worktreeInfo.branch,
      model: task.executionModel !== "default" ? task.executionModel : options.executionModel,
      promptText: commitPrompt.renderedText,
    })
    if (commit.responseText.trim()) {
      this.db.appendAgentOutput(taskId, tagOutput("commit", commit.responseText))
      this.broadcastTask(taskId)
    }
  }

  private async runSessionPrompt(input: {
    task: Task
    sessionKind: PiSessionKind
    cwd: string
    worktreeDir?: string | null
    branch?: string | null
    model?: string
    promptText: string
  }): Promise<{ session: PiWorkflowSession; responseText: string }> {
    const session = await this.sessionManager.executePrompt({
      taskId: input.task.id,
      sessionKind: input.sessionKind,
      cwd: input.cwd,
      worktreeDir: input.worktreeDir,
      branch: input.branch,
      model: input.model,
      thinkingLevel: input.task.thinkingLevel,
      promptText: input.promptText,
      onOutput: (chunk) => {
        if (!chunk.trim()) return
        this.db.appendAgentOutput(input.task.id, `${stripAndNormalize(chunk)}\n`)
        this.broadcast({
          type: "agent_output",
          payload: {
            taskId: input.task.id,
            output: `${stripAndNormalize(chunk)}\n`,
          },
        })
      },
      onSessionMessage: (message) => {
        this.broadcast({
          type: "session_message_created",
          payload: message,
        })
      },
    })

    const updated = this.db.updateTask(input.task.id, {
      sessionId: session.session.id,
      sessionUrl: this.sessionUrlFor(session.session.id),
    })
    if (updated) this.broadcast({ type: "task_updated", payload: updated })

    return { session: session.session, responseText: session.responseText }
  }

  private broadcastTask(taskId: string): void {
    const updated = this.db.getTask(taskId)
    if (!updated) return
    this.broadcast({ type: "task_updated", payload: updated })
  }

  appendApprovalNote(taskId: string, note: string): Task | null {
    const task = this.db.getTask(taskId)
    if (!task) return null
    return this.db.updateTask(taskId, {
      agentOutput: `${task.agentOutput}${tagOutput("user-approval-note", note)}`,
    })
  }

  appendRevisionRequest(taskId: string, feedback: string): Task | null {
    const task = this.db.getTask(taskId)
    if (!task) return null
    return this.db.updateTask(taskId, {
      agentOutput: `${task.agentOutput}${tagOutput("user-revision-request", feedback)}`,
      planRevisionCount: (task.planRevisionCount ?? 0) + 1,
    })
  }

  async resetTaskToBacklog(taskId: string): Promise<Task | null> {
    const task = this.db.getTask(taskId)
    if (!task) return null

    if (task.worktreeDir) {
      try {
        await this.worktree.complete(task.worktreeDir, {
          branch: "",
          targetBranch: "",
          shouldMerge: false,
          shouldRemove: true,
        })
      } catch {
        // best effort
      }
    }

    return this.db.updateTask(taskId, {
      status: "backlog",
      reviewCount: 0,
      errorMessage: null,
      completedAt: null,
      sessionId: null,
      sessionUrl: null,
      worktreeDir: null,
      executionPhase: "not_started",
      awaitingPlanApproval: false,
      planRevisionCount: 0,
    })
  }
}
