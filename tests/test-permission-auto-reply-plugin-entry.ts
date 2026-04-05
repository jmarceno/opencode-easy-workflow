#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { EasyWorkflowPlugin } from "../.opencode/plugins/easy-workflow"

const CLEANUP = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

interface PermissionRespondCall {
  sessionID: string
  permissionID: string
  response: string
}

interface PermissionReplyCall {
  requestID: string
  reply: string
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function getFreePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const { port } = probe
  probe.stop()
  return port
}

function cleanupTempDir(tempDir: string) {
  if (!CLEANUP) {
    console.log(`  (preserving workspace: ${tempDir}; set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

function makeMockClient(respondCalls: PermissionRespondCall[], replyCalls: PermissionReplyCall[]) {
  return {
    app: {
      log: async (_payload: unknown) => ({ data: true }),
    },
    tui: {
      showToast: async (_payload: unknown) => ({ data: true }),
    },
    permission: {
      respond: async (
        params: { sessionID: string; permissionID: string; response: string },
        _options?: { throwOnError?: boolean },
      ) => {
        respondCalls.push({ ...params })
        return { data: true }
      },
      reply: async (
        params: { requestID: string; reply: string },
        _options?: { throwOnError?: boolean },
      ) => {
        replyCalls.push({ ...params })
        return { data: true }
      },
    },
  }
}

async function main() {
  console.log("=== Plugin Entry Permission Auto-Reply Integration ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-plugin-entry-"))

  let db: KanbanDB | null = null
  try {
    const workflowDir = join(tempDir, ".opencode", "easy-workflow")
    mkdirSync(workflowDir, { recursive: true })

    const dbPath = join(workflowDir, "tasks.db")
    db = new KanbanDB(dbPath)
    db.updateOptions({ port: getFreePort() })

    const workflowOwnedTask = db.createTask({
      name: "Workflow-owned autonomous task",
      prompt: "implement",
      skipPermissionAsking: true,
    })
    db.updateTask(workflowOwnedTask.id, { sessionId: "wf-owned-session-entry" })
    db.registerWorkflowSession({
      sessionId: "wf-owned-session-entry",
      taskId: workflowOwnedTask.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const interactiveTask = db.createTask({
      name: "Workflow-owned interactive task",
      prompt: "ask first",
      skipPermissionAsking: false,
    })
    db.updateTask(interactiveTask.id, { sessionId: "wf-owned-session-interactive" })
    db.registerWorkflowSession({
      sessionId: "wf-owned-session-interactive",
      taskId: interactiveTask.id,
      sessionKind: "task",
      ownerDirectory: tempDir,
      skipPermissionAsking: false,
    })

    const workerRun = db.createTaskRun({
      taskId: workflowOwnedTask.id,
      phase: "worker",
      slotIndex: 0,
      attemptIndex: 0,
      model: "test-model",
    })
    db.updateTaskRun(workerRun.id, { sessionId: "wf-worker-session" })
    db.registerWorkflowSession({
      sessionId: "wf-worker-session",
      taskId: workflowOwnedTask.id,
      taskRunId: workerRun.id,
      sessionKind: "task_run_worker",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const reviewScratchSessionId = "wf-review-scratch-session"
    db.registerWorkflowSession({
      sessionId: reviewScratchSessionId,
      taskId: workflowOwnedTask.id,
      sessionKind: "review_scratch",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    const repairSessionId = "wf-repair-session"
    db.registerWorkflowSession({
      sessionId: repairSessionId,
      taskId: workflowOwnedTask.id,
      sessionKind: "repair",
      ownerDirectory: tempDir,
      skipPermissionAsking: true,
    })

    db.close()
    db = null

    const respondCalls: PermissionRespondCall[] = []
    const replyCalls: PermissionReplyCall[] = []
    const client: any = makeMockClient(respondCalls, replyCalls)

    const hooks: any = await EasyWorkflowPlugin({
      client,
      directory: tempDir,
      serverUrl: "http://127.0.0.1:4096",
    })

    assert(typeof hooks?.event === "function", "Expected plugin to expose event hook")

    // Test 1: autonomous workflow-owned task session auto-replies with "always"
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-entry-001",
          sessionID: "wf-owned-session-entry",
          permission: "bash",
          patterns: ["**"],
          metadata: {},
          always: [],
        },
      },
    })

    assert(replyCalls.length === 1, `Expected 1 reply() call for workflow-owned autonomous session; got ${replyCalls.length}`)
    assert(replyCalls[0].requestID === "perm-entry-001", `Unexpected requestID: ${replyCalls[0].requestID}`)
    assert(replyCalls[0].reply === "always", `Expected reply='always', got '${replyCalls[0].reply}'`)

    // Test 2: worker session auto-replies with "always"
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-worker-001",
          sessionID: "wf-worker-session",
          permission: "bash",
          patterns: ["**"],
          metadata: {},
          always: [],
        },
      },
    })

    assert(replyCalls.length === 2, `Expected 2 reply() calls after worker; got ${replyCalls.length}`)
    assert(replyCalls[1].reply === "always", `Expected reply='always' for worker, got '${replyCalls[1].reply}'`)

    // Test 3: review scratch session auto-replies with "always"
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-review-001",
          sessionID: "wf-review-scratch-session",
          permission: "bash",
          patterns: ["**"],
          metadata: {},
          always: [],
        },
      },
    })

    assert(replyCalls.length === 3, `Expected 3 reply() calls after review scratch; got ${replyCalls.length}`)
    assert(replyCalls[2].reply === "always", `Expected reply='always' for review scratch, got '${replyCalls[2].reply}'`)

    // Test 4: repair session auto-replies with "always"
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-repair-001",
          sessionID: "wf-repair-session",
          permission: "bash",
          patterns: ["**"],
          metadata: {},
          always: [],
        },
      },
    })

    assert(replyCalls.length === 4, `Expected 4 reply() calls after repair; got ${replyCalls.length}`)
    assert(replyCalls[3].reply === "always", `Expected reply='always' for repair, got '${replyCalls[3].reply}'`)

    // Guardrail: unrelated/non-workflow sessions are ignored.
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-entry-002",
          sessionID: "non-workflow-user-session",
          permission: "bash",
          patterns: ["**"],
          metadata: {},
          always: [],
        },
      },
    })

    assert(replyCalls.length === 4 && respondCalls.length === 0, `Expected no additional calls for non-workflow session; got ${replyCalls.length} reply, ${respondCalls.length} respond`)

    // Guardrail: workflow-owned tasks with skipPermissionAsking=false are ignored.
    await hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "perm-entry-003",
          sessionID: "wf-owned-session-interactive",
          permission: "bash",
          patterns: ["**"],
          metadata: {},
          always: [],
        },
      },
    })

    assert(replyCalls.length === 4 && respondCalls.length === 0, `Expected no additional calls for skipPermissionAsking=false; got ${replyCalls.length} reply, ${respondCalls.length} respond`)

    console.log("✓ Observed runtime permission.asked event for workflow-owned autonomous session")
    console.log("✓ Plugin entrypoint auto-replies 'always' for workflow-owned skipPermissionAsking=true")
    console.log("✓ Plugin entrypoint does not auto-reply for non-workflow sessions")
    console.log("✓ Plugin entrypoint does not auto-reply for skipPermissionAsking=false")
    console.log("✓ Worker, review scratch, and repair sessions all auto-reply with 'always'")
  } finally {
    try {
      db?.close()
    } catch {
      // best-effort
    }
    cleanupTempDir(tempDir)
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
