#!/usr/bin/env bun
/**
 * Plugin-level integration tests for permission auto-reply.
 *
 * These tests invoke the REAL handlePermissionAutoReply function from the plugin,
 * with a real KanbanDB and a mock SDK client that intercepts permission.respond calls.
 *
 * This is NOT a unit test of isolated helpers — it exercises the actual event-handler
 * code path that runs when the OpenCode server dispatches a permission.asked event.
 *
 * Coverage:
 * 1. Workflow-owned task session with skipPermissionAsking=true  → permission.respond called once, mode "once"
 * 2. Workflow-owned task_run session with skipPermissionAsking=true → same
 * 3. Workflow-owned session with skipPermissionAsking=false        → no permission.respond call
 * 4. Non-workflow (unknown) session                              → no permission.respond call
 * 5. permission.asked with missing sessionId                     → no call, no crash
 * 6. permission.asked with missing permissionId                 → no call, no crash
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { handlePermissionAutoReply } from "../.opencode/plugins/easy-workflow"

// ---- Mock SDK client that intercepts permission.respond ----

interface PermissionRespondCall {
  sessionID: string
  permissionID: string
  response: string
}

const CLEANUP = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

function makeMockClient(calls: PermissionRespondCall[]) {
  return {
    permission: {
      respond(
        params: { sessionID: string; permissionID: string; response: string },
        _options?: { throwOnError?: boolean },
      ) {
        calls.push({ ...params })
        return Promise.resolve({ data: true })
      },
    },
  }
}

// ---- Evidence capture: permission.asked event structure ----
//
// When an autonomous agent session hits a permission gate, OpenCode emits:
//   event = { type: "permission.asked", properties: { sessionID, permissionID, permission, patterns } }
//
// SDK endpoint: POST /session/{sessionID}/permissions/{permissionID}
//               body: { response: "once" | "always" | "reject" }
//
// Relevant SDK types (from @opencode-ai/sdk v2/gen/types.gen.ts):
//   EventPermissionAsked = { type: "permission.asked", properties: PermissionRequest }
//   PermissionRequest = { id, sessionID, permission, patterns, metadata, always, tool? }
//   PermissionRespondData = { sessionID, permissionID, response: "once" | "always" | "reject" }
//
// The following tests exercise the real plugin handler against this event structure.

// ---- Test helpers ----

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function cleanupTempDir(tempDir: string) {
  if (!CLEANUP) {
    console.log(`  (preserving db: ${join(tempDir, "tasks.db")}; set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

// ---- Test cases ----

async function test_autoReply_workflowOwnedTaskSession_withSkipPermissionAskingTrue() {
  console.log("=== [plugin] auto-reply: workflow-owned task session, skipPermissionAsking=true ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-task-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    // Create a task with a sessionId and skipPermissionAsking=true (the autonomy flag)
    const task = db.createTask({ name: "Autonomous task", prompt: "do work", skipPermissionAsking: true })
    db.updateTask(task.id, { sessionId: "wf-task-session-001" })

    const event = {
      type: "permission.asked",
      properties: {
        sessionID: "wf-task-session-001",
        permissionID: "perm-abc-123",
        permission: "bash",
        patterns: ["**"],
        metadata: {},
        always: [],
      },
    }

    // Call the REAL plugin handler (not a mock/stub)
    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 1, `Expected exactly 1 permission.respond call; got ${calls.length}`)
    assert(calls[0].sessionID === "wf-task-session-001", `Wrong sessionID: ${calls[0].sessionID}`)
    assert(calls[0].permissionID === "perm-abc-123", `Wrong permissionID: ${calls[0].permissionID}`)
    assert(calls[0].response === "once", `Expected response="once", got="${calls[0].response}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.respond called exactly once with response='once'")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_autoReply_workflowOwnedTaskRunSession_withSkipPermissionAskingTrue() {
  console.log("=== [plugin] auto-reply: workflow-owned task_run session, skipPermissionAsking=true ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-run-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    // Create a task with skipPermissionAsking=true, then a worker task-run with its own sessionId
    const task = db.createTask({ name: "Autonomous run task", prompt: "do work", skipPermissionAsking: true })
    const run = db.createTaskRun({
      taskId: task.id,
      phase: "worker",
      slotIndex: 0,
      attemptIndex: 0,
      model: "test-model",
    })
    db.updateTaskRun(run.id, { sessionId: "wf-run-session-002" })

    const event = {
      type: "permission.asked",
      properties: {
        sessionID: "wf-run-session-002",
        permissionID: "perm-def-456",
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      },
    }

    // Call the REAL plugin handler
    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 1, `Expected exactly 1 permission.respond call; got ${calls.length}`)
    assert(calls[0].sessionID === "wf-run-session-002", `Wrong sessionID: ${calls[0].sessionID}`)
    assert(calls[0].permissionID === "perm-def-456", `Wrong permissionID: ${calls[0].permissionID}`)
    assert(calls[0].response === "once", `Expected response="once", got="${calls[0].response}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.respond called exactly once for task_run session with response='once'")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_workflowOwnedTaskSession_withSkipPermissionAskingFalse() {
  console.log("=== [plugin] NO auto-reply: skipPermissionAsking=false ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-false-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    // Task with skipPermissionAsking=false (interactive — should NOT auto-reply)
    const task = db.createTask({ name: "Interactive task", prompt: "ask me", skipPermissionAsking: false })
    db.updateTask(task.id, { sessionId: "interactive-session-003" })

    const event = {
      type: "permission.asked",
      properties: {
        sessionID: "interactive-session-003",
        permissionID: "perm-ghi-789",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 0, `Expected 0 calls (guardrail blocks); got ${calls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no permission.respond call — guardrail correctly blocks for skipPermissionAsking=false")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_nonWorkflowSession() {
  console.log("=== [plugin] NO auto-reply: non-workflow (unknown) session ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-unknown-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    // Create a task in the DB but use a completely different session ID (simulating a user session)
    const task = db.createTask({ name: "DB task", prompt: "db task", skipPermissionAsking: true })
    db.updateTask(task.id, { sessionId: "known-task-session" })

    // Event from a session not in the DB at all
    const event = {
      type: "permission.asked",
      properties: {
        sessionID: "completely-unrelated-user-session",
        permissionID: "perm-xyz-999",
        permission: "webfetch",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 0, `Expected 0 calls (non-workflow session); got ${calls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no permission.respond call — unrelated user session not affected")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_missingSessionId() {
  console.log("=== [plugin] NO auto-reply: missing sessionId in event ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-nosess-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    // Event with permissionId but no sessionId
    const event: any = {
      type: "permission.asked",
      properties: {
        permissionID: "perm-no-sess",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    // Must not throw
    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 0, `Expected 0 calls (missing sessionId); got ${calls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no permission.respond call — missing sessionId safely ignored, no crash")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_missingPermissionId() {
  console.log("=== [plugin] NO auto-reply: missing permissionId in event ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-noperm-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    const task = db.createTask({ name: "Sess task", prompt: "task", skipPermissionAsking: true })
    db.updateTask(task.id, { sessionId: "sess-without-permid" })

    // Event with sessionId but no permissionId
    const event: any = {
      type: "permission.asked",
      properties: {
        sessionID: "sess-without-permid",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 0, `Expected 0 calls (missing permissionId); got ${calls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no permission.respond call — missing permissionId safely ignored, no crash")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_reviewerTaskRunSession() {
  console.log("=== [plugin] NO auto-reply: reviewer task_run session (skipPermissionAsking=false) ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-review-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    // Create a task with skipPermissionAsking=false (reviewer sessions inherit this)
    const task = db.createTask({ name: "Review task", prompt: "review", skipPermissionAsking: false })
    const reviewerRun = db.createTaskRun({
      taskId: task.id,
      phase: "reviewer",
      slotIndex: 0,
      attemptIndex: 0,
      model: "test-model",
    })
    db.updateTaskRun(reviewerRun.id, { sessionId: "reviewer-session-005" })

    const event = {
      type: "permission.asked",
      properties: {
        sessionID: "reviewer-session-005",
        permissionID: "perm-review-555",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 0, `Expected 0 calls (reviewer skipPermissionAsking=false); got ${calls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no permission.respond call — reviewer session inherits skipPermissionAsking=false")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_responseModeIsExactlyOnce() {
  console.log("=== [plugin] response mode is exactly 'once', not 'always' ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-once-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const calls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(calls)

    const task = db.createTask({ name: "Once mode task", prompt: "task", skipPermissionAsking: true })
    db.updateTask(task.id, { sessionId: "once-mode-session" })

    const event = {
      type: "permission.asked",
      properties: {
        sessionID: "once-mode-session",
        permissionID: "perm-once-xyz",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(calls.length === 1, `Expected 1 call`)
    assert(
      calls[0].response === "once",
      `Expected response="once", got="${calls[0].response}" — must NOT be "always"`,
    )

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ response mode is 'once' (not 'always' or 'reject')")
  } catch (err) {
    db.close?.()
    cleanupTempDir(tempDir)
    throw err
  }
}

// ---- Main ----

async function main() {
  console.log("=== Plugin-Level Permission Auto-Reply Integration Tests ===\n")
  console.log("NOTE: These tests invoke the REAL handlePermissionAutoReply from the plugin\n")

  const tests = [
    test_autoReply_workflowOwnedTaskSession_withSkipPermissionAskingTrue,
    test_autoReply_workflowOwnedTaskRunSession_withSkipPermissionAskingTrue,
    test_noAutoReply_workflowOwnedTaskSession_withSkipPermissionAskingFalse,
    test_noAutoReply_nonWorkflowSession,
    test_noAutoReply_missingSessionId,
    test_noAutoReply_missingPermissionId,
    test_noAutoReply_reviewerTaskRunSession,
    test_responseModeIsExactlyOnce,
  ]

  let passed = 0
  let failed = 0

  for (const test of tests) {
    try {
      await test()
      passed++
    } catch (err) {
      failed++
      console.error(`  ✗ ${test.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error("Test suite failed:", err)
  process.exit(1)
})