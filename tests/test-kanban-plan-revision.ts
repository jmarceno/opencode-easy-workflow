#!/usr/bin/env bun

import { createOpencode } from "@opencode-ai/sdk"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../src/db"
import { Orchestrator } from "../src/orchestrator"
import { KanbanServer } from "../src/server"

const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 2000,
): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return true
    await waitFor(intervalMs)
  }
  return false
}

function getFreePort(): number {
  const probe = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })
  const { port } = probe
  probe.stop()
  return port
}

async function listGitWorktrees(): Promise<Set<string>> {
  const output = await Bun.$`git worktree list --porcelain`.text()
  const paths = new Set<string>()
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(line.slice("worktree ".length).trim())
    }
  }
  return paths
}

async function cleanupNewWorktrees(baseline: Set<string>): Promise<void> {
  const current = await listGitWorktrees()
  for (const path of current) {
    if (baseline.has(path)) continue
    try {
      await Bun.$`git worktree remove --force ${path}`
      console.log(`Removed worktree: ${path}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Failed to remove worktree ${path}: ${message}`)
    }
  }
}

function cleanupOutputFile(path: string) {
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

function cleanupTempDir(tempDir: string) {
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${join(tempDir, "tasks.db")} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

async function resolveRealModel(kanbanPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${kanbanPort}/api/models`)
  assert(response.ok, `Failed to fetch model catalog: HTTP ${response.status}`)
  const catalog = await response.json() as any

  const allModelValues = (catalog?.providers || [])
    .flatMap((provider: any) => Array.isArray(provider?.models) ? provider.models : [])
    .map((model: any) => model?.value)
    .filter((value: any) => typeof value === "string" && value.trim().length > 0) as string[]

  const byLowerValue = new Map(allModelValues.map((value) => [value.toLowerCase(), value]))
  const preferredModels = [
    "openai/gpt-5.4-mini",
    "google/gemini-2.5-flash-lite",
    "google/gemini-2.5-flash-preview-04-17",
    "opencode-go/minimax-m2.7",
    "opencode-go/kimi-k2.5",
    "minimax/minimax-m2.7",
    "minimax/minimax-m2.5",
  ]

  for (const preferred of preferredModels) {
    const matched = byLowerValue.get(preferred.toLowerCase())
    if (matched) return matched
  }

  const defaults = Object.values(catalog?.defaults || {}).filter((value): value is string => typeof value === "string" && value.trim().length > 0)
  if (defaults.length > 0) {
    const nonCodexDefault = defaults.find((value) => !value.toLowerCase().includes("codex"))
    if (nonCodexDefault) return nonCodexDefault
  }

  const firstSafeCatalogModel = allModelValues.find((value) => {
    const lower = value.toLowerCase()
    return !lower.startsWith("openrouter/") && !lower.includes("codex")
  })
  if (firstSafeCatalogModel) {
    return firstSafeCatalogModel
  }

  const firstCatalogModel = allModelValues.find((value) => !value.toLowerCase().includes("codex"))

  assert(firstCatalogModel, "Model catalog returned no selectable models")
  return firstCatalogModel
}

async function resolveTargetBranch(): Promise<string> {
  const current = (await Bun.$`git branch --show-current`.text()).trim()
  if (current) return current

  const availableBranches = (await Bun.$`git branch --format=%(refname:short)`.text())
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  if (availableBranches.includes("main")) return "main"
  if (availableBranches.includes("master")) return "master"
  assert(availableBranches.length > 0, "No local branches are available")
  return availableBranches[0]
}

async function getTaskById(kanbanPort: number, taskId: string): Promise<any | null> {
  const response = await fetch(`http://127.0.0.1:${kanbanPort}/api/tasks`)
  if (!response.ok) return null
  const tasks = await response.json() as any[]
  return tasks.find((task: any) => task.id === taskId) ?? null
}

async function testPlanRevisionWithRealCycle() {
  console.log("=== Plan Revision Real-Cycle E2E Test ===")

  const workspaceRoot = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-plan-revision-e2e-"))
  const dbPath = join(tempDir, "tasks.db")
  const marker = `PLAN_REVISION_E2E_${Date.now()}`
  const outputFile = `plan-revision-e2e-${Date.now()}.txt`
  const outputPath = join(workspaceRoot, outputFile)

  let openCodeServer: { url: string; close(): void } | null = null
  let db: KanbanDB | null = null
  let kanbanServer: KanbanServer | null = null
  let orchestrator: Orchestrator | null = null
  let baselineWorktrees = new Set<string>()

  try {
    cleanupOutputFile(outputPath)

    const openCode = await createOpencode({ port: 0 })
    openCodeServer = openCode.server
    baselineWorktrees = await listGitWorktrees()

    db = new KanbanDB(dbPath)
    const kanbanPort = getFreePort()
    db.updateOptions({ port: kanbanPort })

    let isExecuting = false

    kanbanServer = new KanbanServer(db, {
      onStart: async () => {
        isExecuting = true
        try {
          if (orchestrator) await orchestrator.start()
        } finally {
          isExecuting = false
        }
      },
      onStop: () => {
        isExecuting = false
        if (orchestrator) orchestrator.stop()
      },
      getExecuting: () => isExecuting,
      getStartError: () => (orchestrator ? orchestrator.preflightStartError() : "Kanban orchestrator is not ready"),
      getServerUrl: () => openCodeServer?.url || null,
    })

    orchestrator = new Orchestrator(db, kanbanServer, () => openCodeServer?.url || null, workspaceRoot)
    const startedKanbanPort = kanbanServer.start()

    const realModel = await resolveRealModel(startedKanbanPort)
    const targetBranch = await resolveTargetBranch()
    console.log(`Using model: ${realModel}`)
    console.log(`Using branch: ${targetBranch}`)

    const createTaskResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Plan Revision Real Cycle",
        prompt: [
          `Create a file named ${outputFile} in the repository root.`,
          `The file must contain exactly one line: ${marker}`,
        ].join("\n"),
        planmode: true,
        review: false,
        autoCommit: false,
        executionModel: realModel,
        planModel: realModel,
        branch: targetBranch,
      }),
    })

    assert(createTaskResponse.ok, `Failed to create task: HTTP ${createTaskResponse.status}`)
    const planTask = await createTaskResponse.json() as any

    const startResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/start`, { method: "POST" })
    assert(startResponse.ok, `Failed to start initial planning: HTTP ${startResponse.status}`)

    const initialPlanReady = await pollForCondition(async () => {
      const task = await getTaskById(startedKanbanPort, planTask.id)
      return task?.status === "review"
        && task?.awaitingPlanApproval === true
        && task?.executionPhase === "plan_complete_waiting_approval"
    }, 180000)

    assert(initialPlanReady, "Initial plan was not generated")

    const revisionResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/tasks/${planTask.id}/request-plan-revision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedback: "Please make the plan explicit about exact file name and exact one-line output.",
      }),
    })
    assert(revisionResponse.ok, `Failed to request plan revision: HTTP ${revisionResponse.status}`)

    const revisedPlanReady = await pollForCondition(async () => {
      const task = await getTaskById(startedKanbanPort, planTask.id)
      if (!task) return false
      const planEntries = (task.agentOutput.match(/\[plan\]/g) || []).length
      return task.status === "review"
        && task.awaitingPlanApproval === true
        && task.executionPhase === "plan_complete_waiting_approval"
        && task.planRevisionCount === 1
        && planEntries >= 2
    }, 180000)

    assert(revisedPlanReady, "Revised plan was not generated")

    const approveResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Proceed with implementation exactly as planned." }),
    })
    assert(approveResponse.ok, `Failed to approve revised plan: HTTP ${approveResponse.status}`)

    let terminalTask: any | null = null
    const implementationReachedTerminalState = await pollForCondition(async () => {
      const task = await getTaskById(startedKanbanPort, planTask.id)
      terminalTask = task
      return task?.status === "done" || task?.status === "failed" || task?.status === "stuck"
    }, 600000)

    assert(implementationReachedTerminalState, "Implementation did not reach a terminal state")
    assert(terminalTask?.status === "done", `Implementation ended with status ${terminalTask?.status}: ${terminalTask?.errorMessage ?? "no error message"}`)

    const finalTask = await getTaskById(startedKanbanPort, planTask.id)
    assert(finalTask, "Task not found after completion")
    assert(finalTask.status === "done", `Expected done status, got ${finalTask.status}`)
    assert(finalTask.planRevisionCount === 1, `Expected revision count 1, got ${finalTask.planRevisionCount}`)
    assert(finalTask.agentOutput.includes("[user-revision-request]"), "Missing user revision marker in agent output")
    assert(Boolean(finalTask.sessionId), "Expected a real session ID from backend")

    assert(existsSync(outputPath), `Expected output file to exist: ${outputFile}`)
    const content = readFileSync(outputPath, "utf-8").trim()
    assert(content === marker, `Unexpected output content. Expected '${marker}', got '${content}'`)

    console.log("✓ Real plan revision cycle completed with a real LLM backend")
  } finally {
    try {
      if (kanbanServer) kanbanServer.stop()
    } catch {}
    try {
      if (db) db.close()
    } catch {}
    try {
      if (openCodeServer) openCodeServer.close()
    } catch {}

    await cleanupNewWorktrees(baselineWorktrees)
    cleanupOutputFile(outputPath)
    cleanupTempDir(tempDir)
  }
}

async function main() {
  await testPlanRevisionWithRealCycle()
  console.log("\nAll plan revision tests passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
