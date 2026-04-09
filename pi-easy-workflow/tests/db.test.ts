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
