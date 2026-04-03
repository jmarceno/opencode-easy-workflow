#!/usr/bin/env bun

import { createOpencode } from "@opencode-ai/sdk"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { Orchestrator } from "../.opencode/easy-workflow/orchestrator"
import { KanbanServer } from "../.opencode/easy-workflow/server"

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

async function testBestOfNWithRealCycle() {
  console.log("=== Best-of-N Real-Cycle E2E Test ===")

  const workspaceRoot = process.cwd()
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-best-of-n-e2e-"))
  const dbPath = join(tempDir, "tasks.db")
  const marker = `BEST_OF_N_E2E_${Date.now()}`
  const outputFile = `best-of-n-e2e-${Date.now()}.txt`
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
        name: "Best-of-N Real Cycle",
        prompt: [
          `Create a file named ${outputFile} in the repository root.`,
          `The file must contain exactly one line: ${marker}`,
        ].join("\n"),
        planmode: false,
        review: false,
        autoCommit: false,
        branch: targetBranch,
        executionStrategy: "best_of_n",
        bestOfNConfig: {
          workers: [
            {
              model: realModel,
              count: 1,
              taskSuffix: `Produce ${outputFile} with exact content ${marker}`,
            },
          ],
          reviewers: [],
          finalApplier: {
            model: realModel,
            taskSuffix: `Apply the best solution and ensure ${outputFile} contains only ${marker}`,
          },
          minSuccessfulWorkers: 1,
          selectionMode: "synthesize",
        },
      }),
    })

    assert(createTaskResponse.ok, `Failed to create best-of-n task: HTTP ${createTaskResponse.status}`)
    const task = await createTaskResponse.json() as any

    const startResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/start`, { method: "POST" })
    assert(startResponse.ok, `Failed to start best-of-n execution: HTTP ${startResponse.status}`)

    let terminalTask: any | null = null
    const taskReachedTerminalState = await pollForCondition(async () => {
      const current = await getTaskById(startedKanbanPort, task.id)
      terminalTask = current
      return current?.status === "done" || current?.status === "failed" || current?.status === "stuck"
    }, 600000)

    assert(taskReachedTerminalState, "Best-of-n task did not reach a terminal state")
    assert(terminalTask?.status === "done", `Best-of-n task ended with status ${terminalTask?.status}: ${terminalTask?.errorMessage ?? "no error message"}`)

    const finalTask = await getTaskById(startedKanbanPort, task.id)
    assert(finalTask, "Task not found after completion")
    assert(finalTask.status === "done", `Expected done status, got ${finalTask.status}`)
    assert(finalTask.bestOfNSubstage === "completed", `Expected completed substage, got ${finalTask.bestOfNSubstage}`)
    assert(finalTask.agentOutput.includes("[worker-0]"), "Expected worker output in task log")
    assert(finalTask.agentOutput.includes("[final-applier]"), "Expected final-applier output in task log")

    const runsResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/tasks/${task.id}/runs`)
    assert(runsResponse.ok, `Failed to fetch task runs: HTTP ${runsResponse.status}`)
    const runs = await runsResponse.json() as any[]
    assert(runs.length === 2, `Expected 2 runs (worker + final), got ${runs.length}`)
    assert(runs.some((run) => run.phase === "worker" && run.status === "done"), "Expected a completed worker run")
    assert(runs.some((run) => run.phase === "final_applier" && run.status === "done"), "Expected a completed final applier run")
    assert(runs.every((run) => typeof run.sessionId === "string" && run.sessionId.length > 0), "Expected all runs to have real session IDs")

    const candidatesResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/tasks/${task.id}/candidates`)
    assert(candidatesResponse.ok, `Failed to fetch candidates: HTTP ${candidatesResponse.status}`)
    const candidates = await candidatesResponse.json() as any[]
    assert(candidates.length >= 1, "Expected at least one candidate from worker runs")

    const summaryResponse = await fetch(`http://127.0.0.1:${startedKanbanPort}/api/tasks/${task.id}/best-of-n-summary`)
    assert(summaryResponse.ok, `Failed to fetch best-of-n summary: HTTP ${summaryResponse.status}`)
    const summary = await summaryResponse.json() as any
    assert(summary.workersTotal === 1, `Expected workersTotal=1, got ${summary.workersTotal}`)
    assert(summary.workersDone === 1, `Expected workersDone=1, got ${summary.workersDone}`)
    assert(summary.hasFinalApplier === true, "Expected hasFinalApplier=true")

    assert(existsSync(outputPath), `Expected output file to exist: ${outputFile}`)
    const content = readFileSync(outputPath, "utf-8").trim()
    assert(content === marker, `Unexpected output content. Expected '${marker}', got '${content}'`)

    console.log("✓ Real best-of-n cycle completed with a real LLM backend")
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
  await testBestOfNWithRealCycle()
  console.log("\nAll best-of-n tests passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
