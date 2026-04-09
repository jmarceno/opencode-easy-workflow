#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../src/db"
import { KanbanServer } from "../src/server"
import { WorkflowRunManager } from "../src/run-manager"

const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

function cleanupTempDir(tempDir: string) {
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${join(tempDir, "tasks.db")} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-recovery-"))
  const dbPath = join(tempDir, "tasks.db")
  const db = new KanbanDB(dbPath)

  const taskA = db.createTask({
    name: "Recovered task A",
    prompt: "No-op",
    planmode: false,
    review: false,
    autoCommit: false,
    status: "executing",
  })
  const taskB = db.createTask({
    name: "Recovered task B",
    prompt: "No-op",
    planmode: false,
    review: false,
    autoCommit: false,
    status: "executing",
  })

  const runA = db.createWorkflowRun({
    kind: "single_task",
    displayName: "Stale run A",
    taskOrder: [taskA.id],
    targetTaskId: taskA.id,
    currentTaskId: taskA.id,
    status: "running",
  })
  const runB = db.createWorkflowRun({
    kind: "single_task",
    displayName: "Stale run B",
    taskOrder: [taskB.id],
    targetTaskId: taskB.id,
    currentTaskId: taskB.id,
    status: "paused",
  })

  const server = new KanbanServer(db, {
    getExecuting: () => false,
    getServerUrl: () => "http://127.0.0.1:4096",
  })
  const manager = new WorkflowRunManager(db, server, () => "http://127.0.0.1:4096", tempDir)

  const repairedTaskIds: string[] = []
  const recoveredRuns = await manager.recoverStaleRuns(async (taskId: string) => {
    repairedTaskIds.push(taskId)
  })

  assert(recoveredRuns.length === 2, `Expected two stale runs to be recovered, got ${recoveredRuns.length}`)
  assert(repairedTaskIds.includes(taskA.id), "Expected task A to be sent to repair")
  assert(repairedTaskIds.includes(taskB.id), "Expected task B to be sent to repair")

  const failedRunA = db.getWorkflowRun(runA.id)
  const failedRunB = db.getWorkflowRun(runB.id)
  assert(failedRunA?.status === "failed", `Expected run A to be failed, got ${failedRunA?.status}`)
  assert(failedRunB?.status === "failed", `Expected run B to be failed, got ${failedRunB?.status}`)
  assert(!!failedRunA?.errorMessage, "Expected recovered run A to have an error message")
  assert(!!failedRunB?.errorMessage, "Expected recovered run B to have an error message")

  console.log("✓ stale workflow runs are failed and handed to task repair")

  db.close()
  cleanupTempDir(tempDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
