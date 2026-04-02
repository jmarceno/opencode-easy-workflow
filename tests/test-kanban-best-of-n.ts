#!/usr/bin/env bun
/**
 * Tests for Best-of-N Kanban functionality
 * Tests validation, DB persistence, and API behavior
 */

import { existsSync, mkdirSync, unlinkSync } from "fs"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"

const TEST_DIR = process.cwd()
const WORKFLOW_ROOT = join(TEST_DIR, ".opencode", "easy-workflow")
const TEST_ARTIFACTS = join(WORKFLOW_ROOT, "test-artifacts")
const DB_PATH = join(TEST_ARTIFACTS, "bon-test.db")

async function cleanup() {
  if (existsSync(DB_PATH)) {
    try {
      const db = new KanbanDB(DB_PATH)
      const tasks = db.getTasks()
      for (const task of tasks) {
        db.deleteTask(task.id)
      }
      db.close()
    } catch (e) {
      // ignore
    }
  }
}

async function runTests() {
  console.log("Starting Best-of-N Tests...\n")
  let passed = 0
  let failed = 0

  try {
    await cleanup()
    mkdirSync(TEST_ARTIFACTS, { recursive: true })

    const db = new KanbanDB(DB_PATH)

    // Test 1: Create standard task (default)
    console.log("Test 1: Create standard task")
    const standardTask = db.createTask({
      name: "Standard Task",
      prompt: "Do something",
      executionStrategy: "standard",
    })
    if (standardTask.executionStrategy === "standard" && standardTask.bestOfNConfig === null && standardTask.bestOfNSubstage === "idle") {
      console.log("  PASS: Standard task created correctly")
      passed++
    } else {
      console.log("  FAIL: Standard task fields incorrect")
      failed++
    }

    // Test 2: Create best-of-n task
    console.log("Test 2: Create best-of-n task")
    const bonTask = db.createTask({
      name: "Best-of-N Task",
      prompt: "Do something with multiple attempts",
      executionStrategy: "best_of_n",
      bestOfNConfig: {
        workers: [
          { model: "minimax/minimax-m2.7", count: 2, taskSuffix: "Worker A" },
          { model: "minimax/minimax-m2.7", count: 1, taskSuffix: "Worker B" },
        ],
        reviewers: [
          { model: "minimax/minimax-m2.7", count: 1 },
        ],
        finalApplier: { model: "minimax/minimax-m2.7", taskSuffix: "Make it better" },
        minSuccessfulWorkers: 1,
        selectionMode: "pick_best",
      },
      bestOfNSubstage: "idle",
    })
    if (bonTask.executionStrategy === "best_of_n" && bonTask.bestOfNConfig !== null && bonTask.bestOfNSubstage === "idle") {
      console.log("  PASS: Best-of-N task created correctly")
      passed++
    } else {
      console.log("  FAIL: Best-of-N task fields incorrect")
      failed++
    }

    // Test 3: Verify best-of-n config structure
    console.log("Test 3: Verify best-of-n config structure")
    const config = bonTask.bestOfNConfig!
    if (
      config.workers.length === 2 &&
      config.workers[0].count === 2 &&
      config.workers[1].count === 1 &&
      config.reviewers.length === 1 &&
      config.finalApplier.model === "minimax/minimax-m2.7" &&
      config.minSuccessfulWorkers === 1 &&
      config.selectionMode === "pick_best"
    ) {
      console.log("  PASS: Best-of-N config structure correct")
      passed++
    } else {
      console.log("  FAIL: Best-of-N config structure incorrect")
      failed++
    }

    // Test 4: Create task run
    console.log("Test 4: Create task run")
    const run = db.createTaskRun({
      taskId: bonTask.id,
      phase: "worker",
      slotIndex: 0,
      attemptIndex: 0,
      model: "minimax/minimax-m2.7",
      taskSuffix: "Worker A",
      status: "pending",
    })
    if (run.taskId === bonTask.id && run.phase === "worker" && run.status === "pending") {
      console.log("  PASS: Task run created correctly")
      passed++
    } else {
      console.log("  FAIL: Task run fields incorrect")
      failed++
    }

    // Test 5: Get task runs
    console.log("Test 5: Get task runs")
    const runs = db.getTaskRuns(bonTask.id)
    if (runs.length === 1 && runs[0].id === run.id) {
      console.log("  PASS: Task runs retrieved correctly")
      passed++
    } else {
      console.log("  FAIL: Task runs retrieval incorrect")
      failed++
    }

    // Test 6: Update task run
    console.log("Test 6: Update task run")
    const updatedRun = db.updateTaskRun(run.id, {
      status: "done",
      sessionId: "sess_123",
      summary: "Work completed successfully",
    })
    if (updatedRun && updatedRun.status === "done" && updatedRun.sessionId === "sess_123") {
      console.log("  PASS: Task run updated correctly")
      passed++
    } else {
      console.log("  FAIL: Task run update incorrect")
      failed++
    }

    // Test 7: Create task candidate
    console.log("Test 7: Create task candidate")
    const candidate = db.createTaskCandidate({
      taskId: bonTask.id,
      workerRunId: run.id,
      status: "available",
      changedFiles: ["file1.txt", "file2.txt"],
      diffStats: { "file1.txt": 10, "file2.txt": 5 },
      summary: "Implementation complete",
    })
    if (candidate.taskId === bonTask.id && candidate.workerRunId === run.id && candidate.status === "available") {
      console.log("  PASS: Task candidate created correctly")
      passed++
    } else {
      console.log("  FAIL: Task candidate fields incorrect")
      failed++
    }

    // Test 8: Get task candidates
    console.log("Test 8: Get task candidates")
    const candidates = db.getTaskCandidates(bonTask.id)
    if (candidates.length === 1 && candidates[0].id === candidate.id) {
      console.log("  PASS: Task candidates retrieved correctly")
      passed++
    } else {
      console.log("  FAIL: Task candidates retrieval incorrect")
      failed++
    }

    // Test 9: Update task candidate
    console.log("Test 9: Update task candidate")
    const updatedCandidate = db.updateTaskCandidate(candidate.id, { status: "selected" })
    if (updatedCandidate && updatedCandidate.status === "selected") {
      console.log("  PASS: Task candidate updated correctly")
      passed++
    } else {
      console.log("  FAIL: Task candidate update incorrect")
      failed++
    }

    // Test 10: Get best-of-n counts
    console.log("Test 10: Get best-of-n counts")
    const counts = db.getBestOfNCounts(bonTask.id)
    if (counts.workersTotal === 1 && counts.workersDone === 1 && counts.reviewersTotal === 0 && counts.hasFinalApplier === false) {
      console.log("  PASS: Best-of-n counts correct")
      passed++
    } else {
      console.log(`  FAIL: Best-of-n counts incorrect: ${JSON.stringify(counts)}`)
      failed++
    }

    // Test 11: Update task bestOfNSubstage
    console.log("Test 11: Update task bestOfNSubstage")
    const updatedTask = db.updateTask(bonTask.id, { bestOfNSubstage: "workers_running" })
    if (updatedTask && updatedTask.bestOfNSubstage === "workers_running") {
      console.log("  PASS: Task bestOfNSubstage updated correctly")
      passed++
    } else {
      console.log("  FAIL: Task bestOfNSubstage update incorrect")
      failed++
    }

    // Test 12: Delete cascade for task runs
    console.log("Test 12: Delete cascade for task runs")
    db.deleteTask(bonTask.id)
    const runsAfterDelete = db.getTaskRuns(bonTask.id)
    const candidatesAfterDelete = db.getTaskCandidates(bonTask.id)
    if (runsAfterDelete.length === 0 && candidatesAfterDelete.length === 0) {
      console.log("  PASS: Task runs and candidates deleted on task deletion")
      passed++
    } else {
      console.log("  FAIL: Delete cascade not working correctly")
      failed++
    }

    // Test 13: Get task runs by phase
    console.log("Test 13: Create multiple runs and filter by phase")
    const task2 = db.createTask({
      name: "Multi-phase Task",
      prompt: "Test multi-phase",
      executionStrategy: "best_of_n",
      bestOfNConfig: {
        workers: [{ model: "minimax/minimax-m2.7", count: 2 }],
        reviewers: [{ model: "minimax/minimax-m2.7", count: 1 }],
        finalApplier: { model: "minimax/minimax-m2.7" },
        minSuccessfulWorkers: 1,
        selectionMode: "pick_best",
      },
    })
    const workerRun1 = db.createTaskRun({ taskId: task2.id, phase: "worker", slotIndex: 0, attemptIndex: 0, model: "test" })
    const workerRun2 = db.createTaskRun({ taskId: task2.id, phase: "worker", slotIndex: 1, attemptIndex: 0, model: "test" })
    const reviewerRun1 = db.createTaskRun({ taskId: task2.id, phase: "reviewer", slotIndex: 0, attemptIndex: 0, model: "test" })
    const finalRun = db.createTaskRun({ taskId: task2.id, phase: "final_applier", slotIndex: 0, attemptIndex: 0, model: "test" })

    const workers = db.getTaskRunsByPhase(task2.id, "worker")
    const reviewers = db.getTaskRunsByPhase(task2.id, "reviewer")
    const finalApplier = db.getTaskRunsByPhase(task2.id, "final_applier")

    if (workers.length === 2 && reviewers.length === 1 && finalApplier.length === 1) {
      console.log("  PASS: Task runs filtered by phase correctly")
      passed++
    } else {
      console.log("  FAIL: Task runs phase filtering incorrect")
      failed++
    }

    db.close()

  } catch (e) {
    console.error("Test error:", e)
    failed++
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`)
  await cleanup()
  process.exit(failed > 0 ? 1 : 0)
}

runTests()