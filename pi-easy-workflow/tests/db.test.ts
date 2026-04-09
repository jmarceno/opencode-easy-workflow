import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { PiKanbanDB } from "../src/db.ts"

const tempDirs: string[] = []

function createTempDb(): { db: PiKanbanDB; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-easy-workflow-db-"))
  tempDirs.push(root)
  const dbPath = join(root, "tasks.db")
  const db = new PiKanbanDB(dbPath)
  return { db, dbPath }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("PiKanbanDB", () => {
  it("creates schema, default options, and prompt template seeds", () => {
    const { db } = createTempDb()

    const options = db.getOptions()
    expect(options.parallelTasks).toBe(1)
    expect(options.commitPrompt.length).toBeGreaterThan(20)

    const prompts = db.getAllPromptTemplates()
    expect(prompts.length).toBeGreaterThanOrEqual(10)
    expect(prompts.some((item) => item.key === "execution")).toBe(true)
    expect(prompts.some((item) => item.key === "commit")).toBe(true)

    db.close()
  })

  it("supports task and workflow run storage", () => {
    const { db } = createTempDb()

    const task = db.createTask({
      id: "task-1",
      name: "Build DB layer",
      prompt: "Implement database layer",
      status: "backlog",
    })
    expect(task.id).toBe("task-1")
    expect(db.getTasks().length).toBe(1)

    const updatedTask = db.updateTask("task-1", { status: "executing", reviewCount: 1 })
    expect(updatedTask?.status).toBe("executing")
    expect(updatedTask?.reviewCount).toBe(1)

    const run = db.createWorkflowRun({
      id: "run-1",
      kind: "single_task",
      displayName: "Run 1",
      taskOrder: ["task-1"],
      currentTaskId: "task-1",
    })
    expect(run.id).toBe("run-1")

    const updatedRun = db.updateWorkflowRun("run-1", { status: "completed", finishedAt: Math.floor(Date.now() / 1000) })
    expect(updatedRun?.status).toBe("completed")

    const deleted = db.deleteTask("task-1")
    expect(deleted).toBe(true)
    expect(db.getTask("task-1")).toBeNull()

    db.close()
  })

  it("supports workflow sessions and first-class raw session capture", () => {
    const { db } = createTempDb()

    db.createTask({
      id: "task-raw",
      name: "raw capture",
      prompt: "capture session streams",
    })

    const session = db.createWorkflowSession({
      id: "session-1",
      taskId: "task-raw",
      sessionKind: "task",
      cwd: "/tmp/work",
      model: "default",
    })
    expect(session.status).toBe("starting")

    const first = db.appendSessionIO({
      sessionId: "session-1",
      stream: "stdin",
      recordType: "rpc_command",
      payloadJson: { method: "run", params: { prompt: "hello" } },
    })
    const second = db.appendSessionIO({
      sessionId: "session-1",
      stream: "stdout",
      recordType: "rpc_response",
      payloadJson: { id: 1, ok: true },
    })
    const snapshot = db.appendSessionIO({
      sessionId: "session-1",
      stream: "server",
      recordType: "snapshot",
      payloadJson: { status: "active" },
    })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(snapshot.seq).toBe(3)
    expect(db.getLatestSessionSeq("session-1")).toBe(3)

    const snapshotRecord = db.getSessionSnapshot("session-1")
    expect(snapshotRecord?.recordType).toBe("snapshot")
    expect(snapshotRecord?.payloadJson?.status).toBe("active")

    const stdoutOnly = db.getSessionIOByType("session-1", "rpc_response")
    expect(stdoutOnly.length).toBe(1)
    expect(stdoutOnly[0]?.stream).toBe("stdout")

    db.close()
  })

  it("supports normalized session message storage", () => {
    const { db } = createTempDb()

    db.createWorkflowSession({
      id: "session-messages",
      sessionKind: "task",
      cwd: "/tmp/work",
    })

    const created = db.createSessionMessage({
      sessionId: "session-messages",
      role: "assistant",
      messageType: "assistant_response",
      contentJson: { text: "Done" },
      modelProvider: "pi",
      modelId: "default",
    })

    expect(created.id).toBeGreaterThan(0)
    expect(created.seq).toBe(1)
    expect(created.messageType).toBe("assistant_response")

    const updated = db.updateSessionMessage(created.id, {
      messageType: "text",
      contentJson: { text: "Done updated" },
    })
    expect(updated?.messageType).toBe("text")
    expect(updated?.contentJson.text).toBe("Done updated")

    const timeline = db.getSessionTimeline("session-messages")
    expect(timeline.length).toBe(1)
    expect(timeline[0]?.sessionId).toBe("session-messages")

    const filtered = db.getSessionMessagesByType("session-messages", "text")
    expect(filtered.length).toBe(1)

    db.close()
  })

  it("computes per-session token and cost rollups", () => {
    const { db } = createTempDb()

    db.createWorkflowSession({
      id: "session-usage",
      sessionKind: "task",
      cwd: "/tmp/work",
    })

    db.createSessionMessage({
      sessionId: "session-usage",
      timestamp: 100,
      role: "assistant",
      eventName: "message_end",
      messageType: "assistant_response",
      contentJson: { text: "first" },
      promptTokens: 100,
      completionTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      totalTokens: 127,
      costTotal: 0.12,
    })

    db.createSessionMessage({
      sessionId: "session-usage",
      timestamp: 120,
      role: "assistant",
      eventName: "message_end",
      messageType: "assistant_response",
      contentJson: { text: "second" },
      promptTokens: 40,
      completionTokens: 10,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 54,
      costTotal: 0.05,
    })

    db.createSessionMessage({
      sessionId: "session-usage",
      timestamp: 130,
      role: "system",
      eventName: "agent_end",
      messageType: "step_finish",
      contentJson: { text: "done" },
    })

    const rollup = db.getSessionUsageRollup("session-usage")
    expect(rollup.sessionId).toBe("session-usage")
    expect(rollup.messageCount).toBe(3)
    expect(rollup.tokenizedMessageCount).toBe(2)
    expect(rollup.costedMessageCount).toBe(2)
    expect(rollup.firstTimestamp).toBe(100)
    expect(rollup.lastTimestamp).toBe(130)
    expect(rollup.promptTokens).toBe(140)
    expect(rollup.completionTokens).toBe(30)
    expect(rollup.cacheReadTokens).toBe(8)
    expect(rollup.cacheWriteTokens).toBe(3)
    expect(rollup.totalTokens).toBe(181)
    expect(rollup.totalCost).toBeCloseTo(0.17, 10)

    db.close()
  })

  it("creates a pi-native session_messages schema", () => {
    const { db, dbPath } = createTempDb()
    db.close()

    const sqlite = new Database(dbPath, { readonly: true })
    const columns = sqlite.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>
    const names = columns.map((column) => column.name)

    expect(names.includes("seq")).toBe(true)
    expect(names.includes("event_name")).toBe(true)
    expect(names.includes("cache_read_tokens")).toBe(true)
    expect(names.includes("cache_write_tokens")).toBe(true)
    expect(names.includes("cost_json")).toBe(true)
    expect(names.includes("cost_total")).toBe(true)
    expect(names.includes("tool_call_id")).toBe(true)
    expect(names.includes("task_id")).toBe(false)
    expect(names.includes("task_run_id")).toBe(false)

    sqlite.close(false)
  })

  it("supports best-of-n task runs and candidates mutation APIs", () => {
    const { db } = createTempDb()

    db.createTask({
      id: "bon-db-1",
      name: "Best of N task",
      prompt: "Run best of n",
      executionStrategy: "best_of_n",
      bestOfNConfig: {
        workers: [{ model: "default", count: 1 }],
        reviewers: [],
        finalApplier: { model: "default" },
        minSuccessfulWorkers: 1,
        selectionMode: "pick_best",
      },
    })

    const run = db.createTaskRun({
      taskId: "bon-db-1",
      phase: "worker",
      slotIndex: 0,
      attemptIndex: 0,
      model: "default",
      status: "running",
    })
    expect(run.id.length).toBeGreaterThan(0)

    const updatedRun = db.updateTaskRun(run.id, {
      status: "done",
      summary: "worker done",
      metadataJson: { reviewerOutput: null },
      completedAt: Math.floor(Date.now() / 1000),
    })
    expect(updatedRun?.status).toBe("done")
    expect(updatedRun?.summary).toBe("worker done")
    expect(db.getTaskRunsByPhase("bon-db-1", "worker").length).toBe(1)

    const candidate = db.createTaskCandidate({
      taskId: "bon-db-1",
      workerRunId: run.id,
      status: "available",
      changedFilesJson: ["src/index.ts"],
      diffStatsJson: { "src/index.ts": 12 },
      verificationJson: { status: "passed" },
      summary: "candidate summary",
    })
    expect(candidate.id.length).toBeGreaterThan(0)

    const updatedCandidate = db.updateTaskCandidate(candidate.id, { status: "selected" })
    expect(updatedCandidate?.status).toBe("selected")

    const summary = db.getBestOfNSummary("bon-db-1")
    expect(summary.workersTotal).toBe(1)
    expect(summary.workersDone).toBe(1)
    expect(summary.availableCandidates + summary.selectedCandidates).toBe(1)

    db.close()
  })

  it("renders prompt templates and captures rendered prompts in session_io", () => {
    const { db } = createTempDb()

    db.createWorkflowSession({
      id: "session-prompt",
      sessionKind: "task",
      cwd: "/tmp/work",
    })

    const rendered = db.renderPromptAndCapture({
      key: "execution",
      variables: {
        task: { id: "task-2", name: "Task 2", prompt: "Do work" },
        execution_intro: "Implement now",
        approved_plan_block: "",
        user_guidance_block: "",
        additional_context_block: "",
      },
      sessionId: "session-prompt",
    })

    expect(rendered.renderedText.includes("Do work")).toBe(true)
    expect(rendered.renderedText.includes("Implement now")).toBe(true)

    const capture = db.getSessionIOByType("session-prompt", "prompt_rendered")
    expect(capture.length).toBe(1)
    expect(capture[0]?.payloadJson?.templateKey).toBe("execution")
    expect(capture[0]?.payloadJson?.renderedLength).toBe(rendered.renderedText.length)
    expect(capture[0]?.payloadText).toBe(rendered.renderedText)

    const beforeVersions = db.getPromptTemplateVersions("execution").length
    db.upsertPromptTemplate({
      key: "execution",
      name: "Task Execution",
      description: "updated",
      templateText: "Execute task {{task.id}} quickly",
      variablesJson: ["task"],
    })
    const afterVersions = db.getPromptTemplateVersions("execution").length
    expect(afterVersions).toBe(beforeVersions + 1)

    db.close()
  })
})
