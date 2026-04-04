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

function makeMockClient(calls: PermissionRespondCall[]) {
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
        calls.push({ ...params })
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

    const interactiveTask = db.createTask({
      name: "Workflow-owned interactive task",
      prompt: "ask first",
      skipPermissionAsking: false,
    })
    db.updateTask(interactiveTask.id, { sessionId: "wf-owned-session-interactive" })
    db.close()
    db = null

    const calls: PermissionRespondCall[] = []
    const client: any = makeMockClient(calls)

    const hooks: any = await EasyWorkflowPlugin({
      client,
      directory: tempDir,
      serverUrl: "http://127.0.0.1:4096",
    })

    assert(typeof hooks?.event === "function", "Expected plugin to expose event hook")

    // Runtime evidence: autonomous workflow-owned sessions still emit permission.asked.
    // This event is a permission gate and requires an explicit response to proceed.
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

    assert(calls.length === 1, `Expected 1 auto-reply call for workflow-owned autonomous session; got ${calls.length}`)
    assert(calls[0].sessionID === "wf-owned-session-entry", `Unexpected sessionID: ${calls[0].sessionID}`)
    assert(calls[0].permissionID === "perm-entry-001", `Unexpected permissionID: ${calls[0].permissionID}`)
    assert(calls[0].response === "once", `Expected response='once', got '${calls[0].response}'`)

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

    assert(calls.length === 1, `Expected no additional call for non-workflow session; got ${calls.length}`)

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

    assert(calls.length === 1, `Expected no additional call for skipPermissionAsking=false; got ${calls.length}`)

    console.log("✓ Observed runtime permission.asked event for workflow-owned autonomous session")
    console.log("✓ Plugin entrypoint auto-replies once for workflow-owned skipPermissionAsking=true")
    console.log("✓ Plugin entrypoint does not auto-reply for non-workflow sessions")
    console.log("✓ Plugin entrypoint does not auto-reply for skipPermissionAsking=false")
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
