import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { SmartRepairService } from "../src/runtime/smart-repair.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

function createRepairMockPi(root: string, mode: "valid" | "malformed"): string {
  const filePath = join(root, "mock-pi-repair.js")
  writeFileSync(
    filePath,
    `#!/usr/bin/env bun
import { createInterface } from "readline"
const mode = ${JSON.stringify(mode)}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch {
    return
  }
  const id = request?.id
  const method = request?.method
  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: { sessionId: "repair-session-" + id, sessionFile: "/tmp/mock-repair-session" } }))
    return
  }
  if (method === "prompt") {
    if (mode === "malformed") {
      console.log(JSON.stringify({ id, result: { text: "missing-json" } }))
      return
    }
    const payload = { action: "mark_done", reason: "Repair confirmed completion", errorMessage: "" }
    console.log(JSON.stringify({ id, result: { text: JSON.stringify(payload) } }))
    return
  }
  if (method === "get_messages") {
    console.log(JSON.stringify({ id, result: { messages: [{ text: "snapshot" }] } }))
    return
  }
  console.log(JSON.stringify({ id, result: { ok: true } }))
})\n`,
    "utf-8",
  )
  chmodSync(filePath, 0o755)
  return filePath
}

afterEach(() => {
  delete process.env.PI_EASY_WORKFLOW_PI_BIN
  delete process.env.PI_EASY_WORKFLOW_PI_ARGS
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("smart repair", () => {
  it("applies each repair action with expected task state updates", () => {
    const root = createTempDir("pi-easy-workflow-smart-repair-actions-")
    const db = new PiKanbanDB(join(root, "tasks.db"))
    const service = new SmartRepairService(db)

    const scenarios = [
      { action: "queue_implementation", expectedStatus: "executing", expectedPhase: "implementation_pending" },
      { action: "restore_plan_approval", expectedStatus: "review", expectedPhase: "plan_complete_waiting_approval" },
      { action: "reset_backlog", expectedStatus: "backlog", expectedPhase: "not_started" },
      { action: "mark_done", expectedStatus: "done", expectedPhase: null },
      { action: "fail_task", expectedStatus: "failed", expectedPhase: null },
      { action: "continue_with_more_reviews", expectedStatus: "backlog", expectedPhase: null },
    ] as const

    for (const [idx, scenario] of scenarios.entries()) {
      const task = db.createTask({
        id: `repair-${idx + 1}`,
        name: `Repair scenario ${idx + 1}`,
        prompt: "Repair me",
        status: "review",
        planmode: true,
      })

      const updated = service.applyAction(task.id, {
        action: scenario.action,
        reason: "test-reason",
        ...(scenario.action === "fail_task" ? { errorMessage: "explicit failure" } : {}),
      })

      expect(updated.status).toBe(scenario.expectedStatus)
      if (scenario.expectedPhase) {
        expect(updated.executionPhase).toBe(scenario.expectedPhase)
      }
      if (scenario.action === "fail_task") {
        expect(updated.errorMessage).toBe("explicit failure")
      }
      if (scenario.action === "continue_with_more_reviews") {
        expect(updated.reviewCount).toBe(0)
      }
    }

    db.close()
  })

  it("runs Pi-backed smart repair and stores repair session IO", async () => {
    const root = createTempDir("pi-easy-workflow-smart-repair-pi-")
    process.env.PI_EASY_WORKFLOW_PI_BIN = createRepairMockPi(root, "valid")
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ repairModel: "test-repair-model" })
    const task = db.createTask({
      id: "repair-smart-1",
      name: "Smart repair task",
      prompt: "Repair with smart context",
      status: "review",
      planmode: false,
    })
    db.updateTask(task.id, { reviewCount: 3 })
    db.createWorkflowSession({ id: "hist-1", taskId: task.id, sessionKind: "task", cwd: root, status: "failed" })
    db.createSessionMessage({
      sessionId: "hist-1",
      taskId: task.id,
      role: "assistant",
      messageType: "assistant_response",
      contentJson: { text: "previous attempt failed" },
    })

    const service = new SmartRepairService(db)
    const result = await service.repair(task.id)

    expect(result.action).toBe("mark_done")
    expect(result.task.status).toBe("done")
    const sessions = db.getWorkflowSessionsByTask(task.id)
    const repairSession = sessions.find((session) => session.sessionKind === "repair")
    expect(repairSession).toBeDefined()
    const io = db.getSessionIO(repairSession!.id)
    expect(io.some((record) => record.recordType === "rpc_command")).toBe(true)
    expect(io.some((record) => record.recordType === "rpc_response")).toBe(true)
    db.close()
  })

  it("falls back to deterministic action when smart repair JSON is malformed", async () => {
    const root = createTempDir("pi-easy-workflow-smart-repair-fallback-")
    process.env.PI_EASY_WORKFLOW_PI_BIN = createRepairMockPi(root, "malformed")
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    const task = db.createTask({
      id: "repair-smart-2",
      name: "Smart repair fallback task",
      prompt: "Fallback behavior",
      status: "executing",
      planmode: false,
    })

    const service = new SmartRepairService(db)
    const result = await service.repair(task.id)

    expect(result.reason.includes("smart repair fallback")).toBe(true)
    expect(["backlog", "done", "failed", "review", "executing"]).toContain(result.task.status)
    db.close()
  })
})
