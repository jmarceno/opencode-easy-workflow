#!/usr/bin/env bun

import { createOpencode } from "@opencode-ai/sdk"
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { KanbanServer } from "../.opencode/easy-workflow/server"

const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

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
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${join(tempDir, "tasks.db")} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

async function testDbPersistence() {
  console.log("=== DB Persistence Tests ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-db-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)

    const t1 = db.createTask({ name: "Persist true", prompt: "test", skipPermissionAsking: true })
    assert(t1.skipPermissionAsking === true, `Expected true, got ${t1.skipPermissionAsking}`)

    const fetched1 = db.getTask(t1.id)
    assert(fetched1 && fetched1.skipPermissionAsking === true, `getTask failed for true`)

    const t2 = db.createTask({ name: "Persist false", prompt: "test", skipPermissionAsking: false })
    assert(t2.skipPermissionAsking === false, `Expected false, got ${t2.skipPermissionAsking}`)

    const fetched2 = db.getTask(t2.id)
    assert(fetched2 && fetched2.skipPermissionAsking === false, `getTask failed for false`)

    const allTasks = db.getTasks()
    const tasksByName = Object.fromEntries(allTasks.map(t => [t.name, t]))
    assert(tasksByName["Persist true"].skipPermissionAsking === true, `getTasks failed for true`)
    assert(tasksByName["Persist false"].skipPermissionAsking === false, `getTasks failed for false`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("✓ DB persistence tests passed")
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

async function testDbUpdateAndRoundTrip() {
  console.log("=== DB Update & Round-trip Tests ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-update-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)

    const t1 = db.createTask({ name: "Update test", prompt: "test", skipPermissionAsking: false })
    assert(t1.skipPermissionAsking === false, `Initial value should be false`)

    const updated = db.updateTask(t1.id, { skipPermissionAsking: true })
    assert(updated && updated.skipPermissionAsking === true, `updateTask to true failed: got ${updated?.skipPermissionAsking}`)

    const reFetched = db.getTask(t1.id)
    assert(reFetched && reFetched.skipPermissionAsking === true, `getTask after update failed`)

    const updatedBack = db.updateTask(t1.id, { skipPermissionAsking: false })
    assert(updatedBack && updatedBack.skipPermissionAsking === false, `updateTask to false failed`)

    db.close()
    cleanupTempDir(tempDir)
    console.log("✓ DB update & round-trip tests passed")
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

async function testDbMigrationBackfill() {
  console.log("=== DB Migration Backfill Test ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-migrate-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db1 = new KanbanDB(dbPath)
    const existingTask = db1.createTask({ name: "Pre-migration task", prompt: "test" })
    assert(existingTask.skipPermissionAsking === true, `Default should be true before migration`)
    db1.close()

    const db2 = new KanbanDB(dbPath)
    const migratedTask = db2.getTask(existingTask.id)
    assert(migratedTask && migratedTask.skipPermissionAsking === true, `Migration should backfill true`)
    db2.close()

    cleanupTempDir(tempDir)
    console.log("✓ DB migration backfill test passed")
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

async function testApiCreateDefaults() {
  console.log("=== API Create Default Behavior Tests ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-api-default-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const port = getFreePort()
    db.updateOptions({ port })

    let isExecuting = false
    const server = new KanbanServer(db, {
      onStart: async () => {},
      onStartSingle: async () => {},
      onStop: () => {},
      getExecuting: () => isExecuting,
      getStartError: () => null,
      getServerUrl: () => "http://127.0.0.1:4096",
    })
    server.start()

    const r1 = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Default test", prompt: "test" }),
    })
    assert(r1.ok, `Create without field failed: ${r1.status}`)
    const t1 = await r1.json()
    assert(t1.skipPermissionAsking === true, `Expected default true, got ${t1.skipPermissionAsking}`)

    const r2 = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Default explicit false", prompt: "test", skipPermissionAsking: false }),
    })
    assert(r2.ok, `Create with explicit false failed: ${r2.status}`)
    const t2 = await r2.json()
    assert(t2.skipPermissionAsking === false, `Expected false, got ${t2.skipPermissionAsking}`)

    const r3 = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Default explicit true", prompt: "test", skipPermissionAsking: true }),
    })
    assert(r3.ok, `Create with explicit true failed: ${r3.status}`)
    const t3 = await r3.json()
    assert(t3.skipPermissionAsking === true, `Expected true, got ${t3.skipPermissionAsking}`)

    server.stop()
    db.close()
    cleanupTempDir(tempDir)
    console.log("✓ API create default behavior tests passed")
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

async function testApiValidationRejectsNonBooleans() {
  console.log("=== API Validation Rejects Non-Booleans Tests ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-api-validate-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const port = getFreePort()
    db.updateOptions({ port })

    let isExecuting = false
    const server = new KanbanServer(db, {
      onStart: async () => {},
      onStartSingle: async () => {},
      onStop: () => {},
      getExecuting: () => isExecuting,
      getStartError: () => null,
      getServerUrl: () => "http://127.0.0.1:4096",
    })
    server.start()

    const invalidValues = [
      { name: "string", value: "yes", expectedError: "skipPermissionAsking" },
      { name: "number", value: 1, expectedError: "skipPermissionAsking" },
      { name: "number zero", value: 0, expectedError: "skipPermissionAsking" },
      { name: "object", value: {}, expectedError: "skipPermissionAsking" },
      { name: "array", value: [], expectedError: "skipPermissionAsking" },
      { name: "null", value: null, expectedError: "skipPermissionAsking" },
    ]

    for (const { name, value, expectedError } of invalidValues) {
      const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Bad ${name}`, prompt: "test", skipPermissionAsking: value }),
      })
      assert(r.status === 400, `Expected 400 for ${name}, got ${r.status}`)
      const e = await r.json()
      assert(e.error && e.error.includes(expectedError), `Expected error about ${expectedError}, got: ${e.error}`)
    }

    const createdTask = db.createTask({ name: "Target for patch", prompt: "test", skipPermissionAsking: true })
    const patchInvalid = await fetch(`http://127.0.0.1:${port}/api/tasks/${createdTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipPermissionAsking: "no" }),
    })
    assert(patchInvalid.status === 400, `Expected 400 for PATCH with string, got ${patchInvalid.status}`)
    const patchError = await patchInvalid.json()
    assert(patchError.error && patchError.error.includes("skipPermissionAsking"), `Expected patch error about skipPermissionAsking`)

    server.stop()
    db.close()
    cleanupTempDir(tempDir)
    console.log("✓ API validation rejects non-booleans tests passed")
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

async function testApiUpdateOperations() {
  console.log("=== API Update Operations Tests ===")
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-api-update-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    const port = getFreePort()
    db.updateOptions({ port })

    let isExecuting = false
    const server = new KanbanServer(db, {
      onStart: async () => {},
      onStartSingle: async () => {},
      onStop: () => {},
      getExecuting: () => isExecuting,
      getStartError: () => null,
      getServerUrl: () => "http://127.0.0.1:4096",
    })
    server.start()

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Update target", prompt: "test", skipPermissionAsking: false }),
    })
    assert(created.ok, `Create failed: ${created.status}`)
    const task = await created.json()
    assert(task.skipPermissionAsking === false, `Initial value should be false`)

    const patchedToTrue = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipPermissionAsking: true }),
    })
    assert(patchedToTrue.ok, `PATCH to true failed: ${patchedToTrue.status}`)
    const t1 = await patchedToTrue.json()
    assert(t1.skipPermissionAsking === true, `Expected true after patch, got ${t1.skipPermissionAsking}`)

    const patchedToFalse = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipPermissionAsking: false }),
    })
    assert(patchedToFalse.ok, `PATCH to false failed: ${patchedToFalse.status}`)
    const t2 = await patchedToFalse.json()
    assert(t2.skipPermissionAsking === false, `Expected false after patch, got ${t2.skipPermissionAsking}`)

    const fetched = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}`)
    assert(fetched.ok, `GET failed: ${fetched.status}`)
    const reFetched = await fetched.json()
    assert(reFetched.skipPermissionAsking === false, `Expected false from GET, got ${reFetched.skipPermissionAsking}`)

    server.stop()
    db.close()
    cleanupTempDir(tempDir)
    console.log("✓ API update operations tests passed")
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

async function main() {
  await testDbPersistence()
  await testDbUpdateAndRoundTrip()
  await testDbMigrationBackfill()
  await testApiCreateDefaults()
  await testApiValidationRejectsNonBooleans()
  await testApiUpdateOperations()
  console.log("\nAll skipPermissionAsking tests passed")
}

main().catch((err) => {
  console.error("FAIL:", err)
  process.exit(1)
})