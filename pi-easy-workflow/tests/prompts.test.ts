import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import type { AggregatedReviewResult, Task, TaskCandidate } from "../src/types.ts"
import {
  buildBestOfNFinalApplierVariables,
  buildBestOfNReviewerVariables,
  buildBestOfNWorkerVariables,
  buildCommitVariables,
  buildExecutionVariables,
  buildPlanningVariables,
  buildPlanRevisionVariables,
  buildRepairVariables,
  buildReviewFixVariables,
  buildReviewVariables,
  renderTemplate,
} from "../src/prompts/renderer.ts"

const tempDirs: string[] = []

function createTempDb(): PiKanbanDB {
  const root = mkdtempSync(join(tmpdir(), "pi-easy-workflow-prompts-"))
  tempDirs.push(root)
  return new PiKanbanDB(join(root, "tasks.db"))
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    name: "Implement feature",
    idx: 0,
    prompt: "Add feature end-to-end",
    branch: "master",
    planModel: "default",
    executionModel: "default",
    planmode: false,
    autoApprovePlan: false,
    review: true,
    autoCommit: true,
    deleteWorktree: true,
    status: "backlog",
    requirements: [],
    agentOutput: "",
    reviewCount: 0,
    sessionId: null,
    sessionUrl: null,
    worktreeDir: null,
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    thinkingLevel: "default",
    executionPhase: "not_started",
    awaitingPlanApproval: false,
    planRevisionCount: 0,
    executionStrategy: "standard",
    bestOfNConfig: null,
    bestOfNSubstage: "idle",
    skipPermissionAsking: true,
    maxReviewRunsOverride: null,
    smartRepairHints: null,
    reviewActivity: "idle",
    isArchived: false,
    archivedAt: null,
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("prompt renderer helpers", () => {
  it("renders nested variables and handles missing keys", () => {
    const text = renderTemplate(
      { templateText: "Task {{task.id}} :: {{task.name}} :: {{missing.value}}" },
      { task: { id: "t-1", name: "Demo" } },
    )

    expect(text).toBe("Task t-1 :: Demo :: ")
  })

  it("builds variables for core workflow prompts", () => {
    const task = createTask({ prompt: "Ship workflow prompt migration" })

    const executionVars = buildExecutionVariables(
      task,
      {
        commitPrompt: "",
        extraPrompt: "Be precise",
        branch: "master",
        planModel: "default",
        executionModel: "default",
        reviewModel: "default",
        repairModel: "default",
        command: "",
        parallelTasks: 1,
        autoDeleteNormalSessions: false,
        autoDeleteReviewSessions: false,
        showExecutionGraph: true,
        port: 3789,
        thinkingLevel: "default",
        telegramBotToken: "",
        telegramChatId: "",
        telegramNotificationsEnabled: true,
        maxReviews: 2,
      },
      "/tmp/worktree",
      {
        approvedPlan: "1. Do X\n2. Do Y",
        userGuidance: "Keep API stable",
        isPlanMode: true,
      },
    )

    expect(executionVars.approved_plan_block).toContain("Approved plan")
    expect(executionVars.user_guidance_block).toContain("Keep API stable")

    const planningVars = buildPlanningVariables(task, {
      commitPrompt: "",
      extraPrompt: "Use existing patterns",
      branch: "master",
      planModel: "default",
      executionModel: "default",
      reviewModel: "default",
      repairModel: "default",
      command: "",
      parallelTasks: 1,
      autoDeleteNormalSessions: false,
      autoDeleteReviewSessions: false,
      showExecutionGraph: true,
      port: 3789,
      thinkingLevel: "default",
      telegramBotToken: "",
      telegramChatId: "",
      telegramNotificationsEnabled: true,
      maxReviews: 2,
    })
    expect(String(planningVars.additional_context_block)).toContain("Additional context")

    const revisionVars = buildPlanRevisionVariables(task, "Old plan", "Please revise")
    expect(revisionVars.current_plan).toBe("Old plan")
    expect(revisionVars.revision_feedback).toBe("Please revise")

    const reviewVars = buildReviewVariables(task, "/tmp/review.md")
    expect(reviewVars.review_file_path).toBe("/tmp/review.md")

    const reviewFixVars = buildReviewFixVariables(task, "summary", ["gap one", "gap two"])
    expect(String(reviewFixVars.review_gaps)).toContain("gap one")

    const repairVars = buildRepairVariables(task, "M src/file.ts", "session summary", "latest output")
    expect(String(repairVars.repair_context)).toContain("Worktree git status")
    expect(String(repairVars.repair_context)).toContain("session summary")
  })

  it("builds variables for best-of-n and commit flows", () => {
    const task = createTask()
    const candidates: TaskCandidate[] = [
      {
        id: "cand-1",
        taskId: task.id,
        workerRunId: "run-1",
        status: "available",
        changedFilesJson: ["src/a.ts"],
        diffStatsJson: { "src/a.ts": 10 },
        verificationJson: { status: "passed" },
        summary: "Implemented A",
        errorMessage: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ]

    const agg: AggregatedReviewResult = {
      candidateVoteCounts: { "cand-1": 2 },
      recurringRisks: [],
      recurringGaps: ["add test coverage"],
      consensusReached: true,
      recommendedFinalStrategy: "pick_best",
      usableResults: [
        {
          status: "pass",
          summary: "Looks good",
          bestCandidateIds: ["cand-1"],
          gaps: [],
          recommendedFinalStrategy: "pick_best",
          recommendedPrompt: "keep naming consistent",
        },
      ],
    }

    const worker = buildBestOfNWorkerVariables(task, 0, "provider/model", "extra", "suffix")
    expect(worker.slot_index).toBe(0)

    const reviewer = buildBestOfNReviewerVariables(task, candidates, "extra", "review suffix")
    expect(String(reviewer.candidate_summaries)).toContain("cand-1")

    const finalVars = buildBestOfNFinalApplierVariables(task, candidates, agg, "pick_best", "extra", "final suffix")
    expect(String(finalVars.candidate_guidance)).toContain("Top voted candidate")
    expect(finalVars.consensus_reached).toBe("yes")

    const commitVars = buildCommitVariables("main", false)
    expect(commitVars.base_ref).toBe("main")
    expect(String(commitVars.keep_worktree_note)).toContain("do NOT delete the worktree")
  })
})

describe("prompt template seeds", () => {
  it("renders all core workflow template keys from the database", () => {
    const db = createTempDb()
    db.createWorkflowSession({ id: "session-all", sessionKind: "task", cwd: "/tmp/work" })

    const task = createTask()
    const renderInputs: Array<{ key: string; variables: Record<string, unknown> }> = [
      {
        key: "execution",
        variables: {
          task,
          execution_intro: "Implement now",
          approved_plan_block: "",
          user_guidance_block: "",
          additional_context_block: "",
        },
      },
      {
        key: "planning",
        variables: { task, additional_context_block: "Additional context:\nextra" },
      },
      {
        key: "plan_revision",
        variables: {
          task,
          current_plan: "old",
          revision_feedback: "feedback",
          additional_context_block: "",
        },
      },
      {
        key: "review",
        variables: { task, review_file_path: "/tmp/review.md" },
      },
      {
        key: "review_fix",
        variables: { task, review_summary: "summary", review_gaps: "- gap" },
      },
      {
        key: "repair",
        variables: { task, repair_context: "context" },
      },
      {
        key: "best_of_n_worker",
        variables: {
          task,
          slot_index: 0,
          model: "provider/model",
          task_suffix: "",
          additional_context_block: "",
        },
      },
      {
        key: "best_of_n_reviewer",
        variables: {
          task,
          candidate_summaries: "candidate",
          task_suffix: "",
          additional_context_block: "",
        },
      },
      {
        key: "best_of_n_final_applier",
        variables: {
          task,
          selection_mode: "pick_best",
          candidate_guidance: "guidance",
          recurring_gaps: "(none)",
          reviewer_recommended_prompts: "(none)",
          consensus_reached: "yes",
          task_suffix: "",
          additional_context_block: "",
        },
      },
      {
        key: "commit",
        variables: {
          base_ref: "main",
          keep_worktree_note: "",
        },
      },
    ]

    for (const input of renderInputs) {
      const rendered = db.renderPromptAndCapture({
        key: input.key,
        variables: input.variables,
        sessionId: "session-all",
      })
      expect(rendered.template.key).toBe(input.key)
      expect(rendered.renderedText.length).toBeGreaterThan(20)
    }

    const promptLogs = db.getSessionIOByType("session-all", "prompt_rendered")
    expect(promptLogs.length).toBe(renderInputs.length)
    expect(promptLogs.every((record) => typeof record.payloadText === "string" && record.payloadText.length > 0)).toBe(true)

    db.close()
  })
})
