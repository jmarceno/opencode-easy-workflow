#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../src/db"
import { KanbanServer } from "../src/server"
import { Orchestrator } from "../src/orchestrator"

const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

function cleanupTempDir(tempDir: string) {
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${join(tempDir, "tasks.db")} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message)
  }
}

async function createServerWithExecutionLock() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-locks-"))
  const dbPath = join(tempDir, "tasks.db")
  const db = new KanbanDB(dbPath)
  const portProbe = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })
  const port = portProbe.port
  portProbe.stop()
  db.updateOptions({ port })

  const server = new KanbanServer(db, {
    onStart: async () => {},
    onStartSingle: async () => {},
    onStop: () => {},
    getExecuting: () => true,
    getStartError: () => null,
    getServerUrl: () => "http://127.0.0.1:4096",
  })

  server.start()
  return { tempDir, db, server, port }
}

async function testServerBlocksMutationsWhileExecuting() {
  const { tempDir, db, server, port } = await createServerWithExecutionLock()

  try {
    const task = db.createTask({
      name: "Locked task",
      prompt: "No-op",
      planmode: false,
      review: false,
      autoCommit: false,
    })
    const planTask = db.createTask({
      name: "Plan task",
      prompt: "Plan only",
      planmode: true,
      review: false,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })

    const patchResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    })
    assert(patchResp.status === 409, `Expected PATCH to be blocked with 409, got ${patchResp.status}`)

    const deleteResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`, {
      method: "DELETE",
    })
    assert(deleteResp.status === 409, `Expected DELETE to be blocked with 409, got ${deleteResp.status}`)

    const reorderResp = await fetch(`http://127.0.0.1:${port}/api/tasks/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: task.id, newIdx: 0 }),
    })
    assert(reorderResp.status === 409, `Expected reorder to be blocked with 409, got ${reorderResp.status}`)

    const approveResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
    })
    assert(approveResp.status !== 409, `Expected approve-plan to remain actionable for review tasks, got ${approveResp.status}`)

    const reviewPatchResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ errorMessage: "manual action while execution lock is active" }),
    })
    assert(reviewPatchResp.status !== 409, `Expected review task PATCH to remain actionable, got ${reviewPatchResp.status}`)

    console.log("✓ server blocks task mutations while execution is running")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testOrchestratorReportsDeletedTaskCleanly() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-orchestrator-"))
  const dbPath = join(tempDir, "tasks.db")
  const db = new KanbanDB(dbPath)
  const task = db.createTask({
    name: "Disposable task",
    prompt: "No-op",
    planmode: false,
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
      prompt: async () => {
        db.deleteTask(task.id)
        return { data: { parts: [] } }
      },
    },
  })

  try {
    await orchestrator.executeTask(task, db.getOptions())
    throw new Error("Expected executeTask to fail when the task is deleted mid-run")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    assert(
      message.includes("was removed while refreshing task state after execution"),
      `Expected explicit deleted-task error, got: ${message}`,
    )
    assert(
      !message.includes("currentTask.review") && !message.includes("currentTask.deleteWorktree"),
      `Expected no null dereference in error message, got: ${message}`,
    )
    console.log("✓ orchestrator reports deleted tasks without null dereferences")
  } finally {
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function main() {
  await testServerBlocksMutationsWhileExecuting()
  await testOrchestratorReportsDeletedTaskCleanly()
  console.log("\nAll mutation guard tests passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
