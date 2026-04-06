#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { KanbanServer } from "../.opencode/easy-workflow/server"

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

async function testApprovePlanWithMessage() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-approve-msg-"))
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

  let broadcastMessages: any[] = []
  const server = new KanbanServer(db, {
    onStart: async () => {},
    onStartSingle: async () => {},
    onStop: () => {},
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })
  const originalBroadcast = server.broadcast.bind(server)
  server.broadcast = (msg: any) => {
    broadcastMessages.push(msg)
    originalBroadcast(msg)
  }

  server.start()

  try {
    const planTask = db.createTask({
      name: "Test Plan Task",
      prompt: "Test prompt",
      planmode: true,
      review: false,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })
    db.updateTask(planTask.id, { agentOutput: "[plan] A simple plan output\n" })

    const approveResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please implement carefully" }),
    })

    if (!approveResp.ok) {
      const errorText = await approveResp.text()
      console.error("Approve failed:", approveResp.status, errorText)
    }
    assert(approveResp.ok, `Expected approve-plan to succeed, got ${approveResp.status}`)

    const updated = db.getTask(planTask.id)!
    assert(updated.awaitingPlanApproval === false, "Expected awaitingPlanApproval to be false")
    assert(updated.executionPhase === "implementation_pending", "Expected executionPhase to be implementation_pending")
    assert(updated.status === "executing", "Expected status to be executing")
    assert(updated.agentOutput.includes("[user-approval-note] Please implement carefully"), "Expected agentOutput to contain user-approval-note")

    const hasAgentOutputBroadcast = broadcastMessages.some(
      m => m.type === "agent_output" && m.payload.taskId === planTask.id && m.payload.output.includes("user-approval-note")
    )
    if (!hasAgentOutputBroadcast) {
      console.error("Broadcast messages:", JSON.stringify(broadcastMessages, null, 2))
    }
    assert(hasAgentOutputBroadcast, "Expected agent_output broadcast for user approval note")

    console.log("✓ approve-plan with message succeeds and persists note")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testApprovePlanWithoutMessage() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-approve-no-msg-"))
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

  let broadcastMessages: any[] = []
  const server = new KanbanServer(db, {
    onStart: async () => {},
    onStartSingle: async () => {},
    onStop: () => {},
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })
  const originalBroadcast = server.broadcast.bind(server)
  server.broadcast = (msg: any) => {
    broadcastMessages.push(msg)
    originalBroadcast(msg)
  }

  server.start()

  try {
    const planTask = db.createTask({
      name: "Test Plan Task No Msg",
      prompt: "Test prompt",
      planmode: true,
      review: false,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })
    db.updateTask(planTask.id, { agentOutput: "[plan] A simple plan output\n" })

    const taskAfterUpdate = db.getTask(planTask.id)!
    const initialOutput = taskAfterUpdate.agentOutput

    const approveResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    assert(approveResp.ok, `Expected approve-plan to succeed, got ${approveResp.status}`)

    const updated = db.getTask(planTask.id)!
    assert(updated.awaitingPlanApproval === false, "Expected awaitingPlanApproval to be false")
    assert(updated.agentOutput === initialOutput, "Expected agentOutput to be unchanged when no message provided")

    console.log("✓ approve-plan without message works as before")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testApprovePlanWithEmptyMessage() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-approve-empty-msg-"))
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
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })
  const originalBroadcast = server.broadcast.bind(server)
  server.broadcast = (msg: any) => {
    originalBroadcast(msg)
  }

  server.start()

  try {
    const planTask = db.createTask({
      name: "Test Plan Task Empty",
      prompt: "Test prompt",
      planmode: true,
      review: false,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })
    db.updateTask(planTask.id, { agentOutput: "[plan] A simple plan output\n" })

    const taskAfterUpdate = db.getTask(planTask.id)!
    const initialOutput = taskAfterUpdate.agentOutput

    const approveResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    })

    assert(approveResp.ok, `Expected approve-plan to succeed with empty message, got ${approveResp.status}`)

    const updated = db.getTask(planTask.id)!
    assert(updated.agentOutput === initialOutput, "Expected agentOutput to be unchanged when message is empty after trim")

    console.log("✓ approve-plan with whitespace-only message treated as no message")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testApprovePlanWithExistingApprovalNote() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-approve-existing-note-"))
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
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })

  server.start()

  try {
    const planTask = db.createTask({
      name: "Test Plan Task Existing Note",
      prompt: "Test prompt",
      planmode: true,
      review: false,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })
    db.updateTask(planTask.id, { agentOutput: "[plan] A simple plan output\n[user-approval-note] Previous note\n" })

    const approveResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "New note" }),
    })

    assert(approveResp.ok, `Expected approve-plan to succeed, got ${approveResp.status}`)

    const updated = db.getTask(planTask.id)!
    assert(updated.agentOutput.includes("[user-approval-note] Previous note"), "Expected original note to be preserved")
    assert(updated.agentOutput.includes("[user-approval-note] New note"), "Expected new note to be appended")

    console.log("✓ approve-plan appends new note without removing existing notes")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testApprovePlanRejectsNonPlanOutput() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-approve-invalid-output-"))
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
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })

  server.start()

  try {
    const planTask = db.createTask({
      name: "Invalid Plan Output Task",
      prompt: "Test prompt",
      planmode: true,
      review: false,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })
    db.updateTask(planTask.id, { agentOutput: "This is output, but not a captured plan" })

    const approveResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })

    assert(approveResp.status === 400, `Expected approve-plan to fail with 400, got ${approveResp.status}`)
    const text = await approveResp.text()
    assert(text.includes("captured plan output"), `Expected captured plan error, got ${text}`)

    console.log("✓ approve-plan rejects review tasks without a captured [plan] block")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testRepairStateQueuesImplementation() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-repair-queue-"))
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

  let startCalls = 0
  const server = new KanbanServer(db, {
    onStart: async () => { startCalls++ },
    onStartSingle: async () => {},
    onStop: () => {},
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })

  server.start()

  try {
    const task = db.createTask({
      name: "Repairable plan task",
      prompt: "Test prompt",
      planmode: true,
      review: true,
      autoCommit: false,
      status: "review",
      executionPhase: "plan_complete_waiting_approval",
      awaitingPlanApproval: true,
    })
    db.updateTask(task.id, { agentOutput: "[plan] A valid captured plan\n" })

    const repairResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/repair-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "queue_implementation" }),
    })

    assert(repairResp.ok, `Expected repair-state to succeed, got ${repairResp.status}`)
    const updated = db.getTask(task.id)!
    assert(updated.status === "backlog", `Expected backlog status, got ${updated.status}`)
    assert(updated.executionPhase === "implementation_pending", `Expected implementation_pending phase, got ${updated.executionPhase}`)
    assert(updated.awaitingPlanApproval === false, "Expected awaitingPlanApproval to be false")
    assert(startCalls === 1, `Expected repair-state to auto-start execution once, got ${startCalls}`)

    console.log("✓ repair-state can send a stranded plan task back to execution")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testAutoApprovePlanDefaultsAndRoundTrips() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-auto-approve-roundtrip-"))
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
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })

  server.start()

  try {
    const createdDefault = db.createTask({
      name: "Default auto-approve",
      prompt: "Test",
    })
    assert(createdDefault.autoApprovePlan === false, "Expected autoApprovePlan to default to false")

    const createResp = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Auto approve true",
        prompt: "Plan and execute",
        planmode: true,
        autoApprovePlan: true,
      }),
    })

    assert(createResp.ok, `Expected create to succeed, got ${createResp.status}`)
    const createdTask = await createResp.json() as any
    assert(createdTask.autoApprovePlan === true, "Expected created task to store autoApprovePlan=true")

    const patchResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${createdTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApprovePlan: false }),
    })
    assert(patchResp.ok, `Expected patch to succeed, got ${patchResp.status}`)
    const patchedTask = db.getTask(createdTask.id)!
    assert(patchedTask.autoApprovePlan === false, "Expected autoApprovePlan=false after patch")

    console.log("✓ autoApprovePlan defaults to false and round-trips via API")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function testTaskBooleanValidationRejectsInvalidAutoApprovePlan() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-auto-approve-validation-"))
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
    getExecuting: () => false,
    getStartError: () => null,
    getServerUrl: () => `http://127.0.0.1:${port}`,
  })

  server.start()

  try {
    const createResp = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid bool",
        prompt: "Test",
        autoApprovePlan: "yes",
      }),
    })
    assert(createResp.status === 400, `Expected invalid boolean create to fail with 400, got ${createResp.status}`)

    const validTask = db.createTask({ name: "Patch target", prompt: "Test" })
    const patchResp = await fetch(`http://127.0.0.1:${port}/api/tasks/${validTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApprovePlan: 1 }),
    })
    assert(patchResp.status === 400, `Expected invalid boolean patch to fail with 400, got ${patchResp.status}`)

    console.log("✓ task API rejects non-boolean autoApprovePlan values")
  } finally {
    server.stop()
    db.close()
    cleanupTempDir(tempDir)
  }
}

async function main() {
  await testApprovePlanWithMessage()
  await testApprovePlanWithoutMessage()
  await testApprovePlanWithEmptyMessage()
  await testApprovePlanWithExistingApprovalNote()
  await testApprovePlanRejectsNonPlanOutput()
  await testRepairStateQueuesImplementation()
  await testAutoApprovePlanDefaultsAndRoundTrips()
  await testTaskBooleanValidationRejectsInvalidAutoApprovePlan()
  console.log("\nAll approval message tests passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
