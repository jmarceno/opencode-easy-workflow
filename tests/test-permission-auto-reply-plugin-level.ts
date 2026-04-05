#!/usr/bin/env bun
/**
 * Plugin-level integration tests for permission auto-reply.
 *
 * These tests invoke the REAL handlePermissionAutoReply function from the plugin,
 * with a real KanbanDB and a mock SDK client that intercepts permission.reply and
 * permission.respond calls.
 *
 * Coverage:
 * 1. Workflow-owned task session registered in registry with skipPermissionAsking=true → permission.reply called with "always"
 * 2. Workflow-owned task_run session registered in registry with skipPermissionAsking=true → same
 * 3. Workflow-owned session with skipPermissionAsking=false → no reply/respond call
 * 4. Non-workflow (unknown) session → no reply/respond call
 * 5. permission.asked with missing sessionId → no call, no crash
 * 6. permission.asked with missing permissionId → no call, no crash
 * 7. permission.reply preferred over permission.respond
 * 8. permission.respond fallback when reply is unavailable
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { handlePermissionAutoReply } from "../.opencode/plugins/easy-workflow"

// ---- Mock SDK client that intercepts permission.reply and permission.respond ----

interface PermissionReplyCall {
  requestID: string
  reply: string
}

interface PermissionRespondCall {
  sessionID: string
  permissionID: string
  response: string
}

const CLEANUP = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

function makeMockClient(replyCalls: PermissionReplyCall[], respondCalls: PermissionRespondCall[], throwOnReply = false, permissionListData?: any[]) {
  return {
    permission: {
      reply(
        params: { requestID: string; reply: string },
        _options?: { throwOnError?: boolean },
      ) {
        if (throwOnReply) {
          return Promise.reject(new Error("reply() not available"))
        }
        replyCalls.push({ ...params })
        return Promise.resolve({ data: true })
      },
      respond(
        params: { sessionID: string; permissionID: string; response: string },
        _options?: { throwOnError?: boolean },
      ) {
        respondCalls.push({ ...params })
        return Promise.resolve({ data: true })
      },
      list() {
        if (permissionListData !== undefined) {
          return Promise.resolve({ data: permissionListData })
        }
        return Promise.resolve({ data: [] })
      },
    },
  }
}

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
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Autonomous task", prompt: "do work", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "wf-task-session-001",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-abc-123",
        sessionID: "wf-task-session-001",
        permission: "bash",
        patterns: ["**"],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 1, `Expected exactly 1 permission.reply call; got ${replyCalls.length}`)
    assert(replyCalls[0].requestID === "perm-abc-123", `Wrong requestID: ${replyCalls[0].requestID}`)
    assert(replyCalls[0].reply === "always", `Expected reply="always", got="${replyCalls[0].reply}"`)
    assert(respondCalls.length === 0, `Expected 0 respond calls when reply succeeds; got ${respondCalls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.reply called with reply='always'")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_autoReply_workflowOwnedTaskRunSession_withSkipPermissionAskingTrue() {
  console.log("=== [plugin] auto-reply: workflow-owned task_run session, skipPermissionAsking=true ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-run-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Autonomous run task", prompt: "do work", skipPermissionAsking: true })
    const run = db.createTaskRun({
      taskId: task.id,
      phase: "worker",
      slotIndex: 0,
      attemptIndex: 0,
      model: "test-model",
    })
    db.registerWorkflowSession({
      sessionId: "wf-run-session-002",
      taskId: task.id,
      taskRunId: run.id,
      sessionKind: "task_run_worker",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-def-456",
        sessionID: "wf-run-session-002",
        permission: "edit",
        patterns: ["src/**/*.ts"],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 1, `Expected exactly 1 permission.reply call; got ${replyCalls.length}`)
    assert(replyCalls[0].reply === "always", `Expected reply="always", got="${replyCalls[0].reply}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.reply called for task_run session with reply='always'")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_workflowOwnedTaskSession_withSkipPermissionAskingFalse() {
  console.log("=== [plugin] NO auto-reply: skipPermissionAsking=false ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-false-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Interactive task", prompt: "ask me", skipPermissionAsking: false })
    db.registerWorkflowSession({
      sessionId: "interactive-session-003",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: false,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-ghi-789",
        sessionID: "interactive-session-003",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 0, `Expected 0 reply calls (guardrail blocks); got ${replyCalls.length}`)
    assert(respondCalls.length === 0, `Expected 0 respond calls (guardrail blocks); got ${respondCalls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no reply/respond call — guardrail correctly blocks for skipPermissionAsking=false")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_nonWorkflowSession() {
  console.log("=== [plugin] NO auto-reply: non-workflow (unknown) session ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-unknown-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "DB task", prompt: "db task", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "known-task-session",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-xyz-999",
        sessionID: "completely-unrelated-user-session",
        permission: "webfetch",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 0, `Expected 0 reply calls (non-workflow session); got ${replyCalls.length}`)
    assert(respondCalls.length === 0, `Expected 0 respond calls (non-workflow session); got ${respondCalls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no reply/respond call — unrelated user session not affected")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_missingSessionId() {
  console.log("=== [plugin] NO auto-reply: missing sessionId in event ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-nosess-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

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

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 0, `Expected 0 reply calls (missing sessionId); got ${replyCalls.length}`)
    assert(respondCalls.length === 0, `Expected 0 respond calls (missing sessionId); got ${respondCalls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no reply/respond call — missing sessionId safely ignored, no crash")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_noAutoReply_missingPermissionId() {
  console.log("=== [plugin] NO auto-reply: missing permissionId in event ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-noperm-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Sess task", prompt: "task", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "sess-without-permid",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

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

    assert(replyCalls.length === 0, `Expected 0 reply calls (missing permissionId); got ${replyCalls.length}`)
    assert(respondCalls.length === 0, `Expected 0 respond calls (missing permissionId); got ${respondCalls.length}`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ no reply/respond call — missing permissionId safely ignored, no crash")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_autoReply_reviewScratchSession() {
  console.log("=== [plugin] auto-reply: review scratch session, skipPermissionAsking=true ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-review-scratch-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Review task", prompt: "review", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "review-scratch-session-005",
      taskId: task.id,
      sessionKind: "review_scratch",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-review-555",
        sessionID: "review-scratch-session-005",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 1, `Expected 1 reply call for review scratch; got ${replyCalls.length}`)
    assert(replyCalls[0].reply === "always", `Expected reply="always", got="${replyCalls[0].reply}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.reply called for review scratch session with reply='always'")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_autoReply_repairSession() {
  console.log("=== [plugin] auto-reply: repair session, skipPermissionAsking=true ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-repair-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Repair task", prompt: "repair", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "repair-session-006",
      taskId: task.id,
      sessionKind: "repair",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-repair-666",
        sessionID: "repair-session-006",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 1, `Expected 1 reply call for repair; got ${replyCalls.length}`)
    assert(replyCalls[0].reply === "always", `Expected reply="always", got="${replyCalls[0].reply}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.reply called for repair session with reply='always'")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_respondFallback_whenReplyThrows() {
  console.log("=== [plugin] respond fallback when reply() throws ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-fallback-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls, true)

    const task = db.createTask({ name: "Fallback task", prompt: "task", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "fallback-session-007",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-fallback-777",
        sessionID: "fallback-session-007",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 0, `Expected 0 reply calls when reply throws; got ${replyCalls.length}`)
    assert(respondCalls.length === 1, `Expected 1 respond call as fallback; got ${respondCalls.length}`)
    assert(respondCalls[0].response === "always", `Expected respond response="always", got="${respondCalls[0].response}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.respond fallback used with response='always' when reply() throws")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_permissionListRecovery_whenSessionIdMissing() {
  console.log("=== [plugin] permission.list() recovery when sessionId missing ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-recovery-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls, false, [
      {
        id: "perm-recovery-888",
        sessionID: "recovered-session-008",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    ])

    const task = db.createTask({ name: "Recovery task", prompt: "task", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "recovered-session-008",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-recovery-888",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 1, `Expected 1 reply call after recovery; got ${replyCalls.length}`)
    assert(replyCalls[0].reply === "always", `Expected reply="always", got="${replyCalls[0].reply}"`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ permission.list() recovered sessionId and auto-replied with 'always'")
  } catch (err) {
    db?.close()
    cleanupTempDir(tempDir)
    throw err
  }
}

async function test_responseModeIsAlways() {
  console.log("=== [plugin] response mode is 'always', not 'once' ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-always-"))
  const dbPath = join(tempDir, "tasks.db")
  let db: KanbanDB | null = null

  try {
    db = new KanbanDB(dbPath)
    const replyCalls: PermissionReplyCall[] = []
    const respondCalls: PermissionRespondCall[] = []
    const mockClient: any = makeMockClient(replyCalls, respondCalls)

    const task = db.createTask({ name: "Always mode task", prompt: "task", skipPermissionAsking: true })
    db.registerWorkflowSession({
      sessionId: "always-mode-session",
      taskId: task.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const event = {
      type: "permission.asked",
      properties: {
        id: "perm-always-xyz",
        sessionID: "always-mode-session",
        permission: "bash",
        patterns: [],
        metadata: {},
        always: [],
      },
    }

    await handlePermissionAutoReply(event, mockClient, db)

    assert(replyCalls.length === 1, `Expected 1 call`)
    assert(
      replyCalls[0].reply === "always",
      `Expected reply="always", got="${replyCalls[0].reply}" — must NOT be "once"`,
    )

    db.close()
    cleanupTempDir(tempDir)
    console.log("  ✓ response mode is 'always' (not 'once' or 'reject')")
  } catch (err) {
    db?.close()
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
    test_autoReply_reviewScratchSession,
    test_autoReply_repairSession,
    test_respondFallback_whenReplyThrows,
    test_permissionListRecovery_whenSessionIdMissing,
    test_responseModeIsAlways,
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
