#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { Orchestrator } from "../.opencode/easy-workflow/orchestrator"

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

async function testInvalidApprovalStateIsRepairedOnLoad() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-repair-"))
  const dbPath = join(tempDir, "tasks.db")

  const db = new KanbanDB(dbPath)
  const task = db.createTask({
    name: "Broken plan task",
    prompt: "Plan something",
    planmode: true,
    review: true,
    autoCommit: false,
    status: "review",
    executionPhase: "plan_complete_waiting_approval",
    awaitingPlanApproval: true,
  })
  db.close()

  const repairedDb = new KanbanDB(dbPath)
  const repairedTask = repairedDb.getTask(task.id)

  try {
    assert(repairedTask?.status === "failed", `Expected repaired task to be failed, got ${repairedTask?.status}`)
    assert(repairedTask?.awaitingPlanApproval === false, "Expected awaitingPlanApproval to be cleared")
    assert(repairedTask?.executionPhase === "not_started", `Expected executionPhase to reset, got ${repairedTask?.executionPhase}`)
    assert(
      repairedTask?.errorMessage?.includes("no captured plan output") || repairedTask?.errorMessage?.includes("without any captured plan output"),
      `Expected repair error message, got ${repairedTask?.errorMessage}`,
    )
    console.log("✓ invalid plan approval state is repaired on load")
  } finally {
    repairedDb.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function testPlanModeCreditErrorFailsTask() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-credit-"))
  const dbPath = join(tempDir, "tasks.db")
  const db = new KanbanDB(dbPath)
  const task = db.createTask({
    name: "Credit failure task",
    prompt: "Plan something",
    planmode: true,
    review: true,
    autoCommit: false,
  })

  const server = { broadcast: () => {} } as any
  const orchestrator = new Orchestrator(db, server, "http://127.0.0.1:4096", process.cwd()) as any

  orchestrator.createWorktree = async () => ({
    directory: tempDir,
    branch: `opencode/task-${task.id}`,
    baseRef: "main",
  })
  orchestrator.removeWorktree = async () => {}
  orchestrator.getClient = () => ({
    session: {
      create: async () => ({ data: { id: "session-1" } }),
      prompt: async () => ({
        data: {
          parts: [
            {
              type: "text",
              text: "This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 869. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher daily limit",
            },
          ],
        },
      }),
    },
  })

  try {
    await orchestrator.executeTask(task, db.getOptions())
    throw new Error("Expected plan-mode execution to fail on provider credit error")
  } catch (err) {
    const failedTask = db.getTask(task.id)
    const message = err instanceof Error ? err.message : String(err)
    assert(message.includes("requires more credits"), `Expected provider error to bubble up, got ${message}`)
    assert(failedTask?.status === "failed", `Expected task status failed, got ${failedTask?.status}`)
    assert(failedTask?.awaitingPlanApproval === false, "Expected task to not await plan approval")
    assert(failedTask?.executionPhase === "not_started", `Expected execution phase to remain not_started, got ${failedTask?.executionPhase}`)
    console.log("✓ plan-mode credit errors are treated as failures")
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function testPlanModeEmptyOutputFailsTask() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-empty-plan-"))
  const dbPath = join(tempDir, "tasks.db")
  const db = new KanbanDB(dbPath)
  const task = db.createTask({
    name: "Empty plan task",
    prompt: "Plan something",
    planmode: true,
    review: true,
    autoCommit: false,
  })

  const server = { broadcast: () => {} } as any
  const orchestrator = new Orchestrator(db, server, "http://127.0.0.1:4096", process.cwd()) as any

  orchestrator.createWorktree = async () => ({
    directory: tempDir,
    branch: `opencode/task-${task.id}`,
    baseRef: "main",
  })
  orchestrator.removeWorktree = async () => {}
  orchestrator.getClient = () => ({
    session: {
      create: async () => ({ data: { id: "session-1" } }),
      prompt: async () => ({ data: { parts: [] } }),
    },
  })

  try {
    await orchestrator.executeTask(task, db.getOptions())
    throw new Error("Expected plan-mode execution to fail on empty plan output")
  } catch (err) {
    const failedTask = db.getTask(task.id)
    const message = err instanceof Error ? err.message : String(err)
    assert(message.includes("no plan output was captured"), `Expected empty-plan error, got ${message}`)
    assert(failedTask?.status === "failed", `Expected task status failed, got ${failedTask?.status}`)
    assert(failedTask?.awaitingPlanApproval === false, "Expected task to not await plan approval")
    console.log("✓ empty plan output is treated as a failure")
  } finally {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  await testInvalidApprovalStateIsRepairedOnLoad()
  await testPlanModeCreditErrorFailsTask()
  await testPlanModeEmptyOutputFailsTask()
  console.log("\nAll plan failure handling tests passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
