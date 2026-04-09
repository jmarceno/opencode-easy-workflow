#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../src/db"
import { KanbanServer } from "../src/server"

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
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-runs-"))
  const dbPath = join(tempDir, "tasks.db")
  const db = new KanbanDB(dbPath)
  const task = db.createTask({
    name: "Single run task",
    prompt: "No-op",
    planmode: false,
    review: false,
    autoCommit: false,
  })

  const probe = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })
  const port = probe.port
  probe.stop()

  db.updateOptions({ port, parallelTasks: 1 })

  const capacityError = () => {
    const limit = db.getOptions().parallelTasks
    const used = db.countConsumedWorkflowSlots()
    return used >= limit ? `All ${limit} workflow slot${limit === 1 ? " is" : "s are"} in use` : null
  }

  const server = new KanbanServer(db, {
    onStart: async () => db.createWorkflowRun({
      kind: "all_tasks",
      displayName: "Workflow run",
      taskOrder: [task.id],
      currentTaskId: task.id,
      currentTaskIndex: 0,
      status: "running",
    }),
    onStartSingle: async (taskId: string) => db.createWorkflowRun({
      kind: "single_task",
      displayName: `Task run: ${taskId}`,
      targetTaskId: taskId,
      taskOrder: [taskId],
      currentTaskId: taskId,
      currentTaskIndex: 0,
      status: "running",
    }),
    onStop: async () => {
      for (const run of db.getActiveWorkflowRuns()) {
        db.updateWorkflowRun(run.id, {
          status: "failed",
          currentTaskId: null,
          errorMessage: "Stopped by test",
          finishedAt: Math.floor(Date.now() / 1000),
        })
      }
    },
    onPauseRun: async (runId: string) => db.updateWorkflowRun(runId, {
      status: "paused",
      currentTaskId: null,
      pauseRequested: false,
    }),
    onResumeRun: async (runId: string) => db.updateWorkflowRun(runId, {
      status: "running",
      currentTaskId: task.id,
      errorMessage: null,
      finishedAt: null,
    }),
    onStopRun: async (runId: string) => db.updateWorkflowRun(runId, {
      status: "failed",
      currentTaskId: null,
      stopRequested: false,
      errorMessage: "Run stopped by user",
      finishedAt: Math.floor(Date.now() / 1000),
    }),
    getExecuting: () => false,
    getStartError: (taskId?: string) => {
      const error = capacityError()
      if (error) return error
      if (taskId && !db.getTask(taskId)) return "Task not found"
      return null
    },
    getServerUrl: () => "http://127.0.0.1:4096",
  })

  server.start()

  try {
    const startResp = await fetch(`http://127.0.0.1:${port}/api/start`, { method: "POST" })
    assert(startResp.status === 200, `Expected first start to succeed, got ${startResp.status}`)
    const startedRun = await startResp.json() as any
    assert(startedRun?.id, "Expected /api/start to return a run payload")

    const listResp = await fetch(`http://127.0.0.1:${port}/api/runs`)
    const listedRuns = await listResp.json() as any[]
    assert(listedRuns.length === 1, `Expected one run after start, got ${listedRuns.length}`)

    const secondStartResp = await fetch(`http://127.0.0.1:${port}/api/start`, { method: "POST" })
    assert(secondStartResp.status === 409, `Expected second start to fail at capacity, got ${secondStartResp.status}`)

    const pauseResp = await fetch(`http://127.0.0.1:${port}/api/runs/${startedRun.id}/pause`, { method: "POST" })
    assert(pauseResp.status === 200, `Expected pause to succeed, got ${pauseResp.status}`)
    const pausedRun = await pauseResp.json() as any
    assert(pausedRun.status === "paused", `Expected paused run status, got ${pausedRun.status}`)

    const resumeResp = await fetch(`http://127.0.0.1:${port}/api/runs/${startedRun.id}/resume`, { method: "POST" })
    assert(resumeResp.status === 200, `Expected resume to succeed, got ${resumeResp.status}`)
    const resumedRun = await resumeResp.json() as any
    assert(resumedRun.status === "running", `Expected resumed run status, got ${resumedRun.status}`)

    const stopResp = await fetch(`http://127.0.0.1:${port}/api/runs/${startedRun.id}/stop`, { method: "POST" })
    assert(stopResp.status === 200, `Expected stop to succeed, got ${stopResp.status}`)
    const stoppedRun = await stopResp.json() as any
    assert(stoppedRun.status === "failed", `Expected stopped run to be failed, got ${stoppedRun.status}`)

    const singleStartResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/start`, { method: "POST" })
    assert(singleStartResp.status === 200, `Expected single task start to succeed after slot frees, got ${singleStartResp.status}`)
    const singleRun = await singleStartResp.json() as any
    assert(singleRun.kind === "single_task", `Expected single_task run kind, got ${singleRun.kind}`)

    console.log("✓ run APIs expose slot limits and per-run controls")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
