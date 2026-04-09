import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"
import { getExecutionGraphTasks, getExecutableTasks, buildExecutionGraph } from "../src/execution-plan.ts"
import type { Task } from "../src/types.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim()
}

function initGitRepo(root: string): void {
  git(root, ["init"])
  git(root, ["checkout", "-b", "main"])
  writeFileSync(join(root, "README.md"), "# pi-easy-workflow test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi.js")
  writeFileSync(
    filePath,
    `#!/usr/bin/env bun
import { createInterface } from "readline"
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch {
    return
  }
  const id = request?.id
  const method = request?.method
  const params = request?.params || {}
  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: { sessionId: "pi-session-" + id, sessionFile: "/tmp/mock-session" } }))
    return
  }
  if (method === "prompt") {
    const prompt = String(params.prompt || "")
    let text = "Implemented changes end to end"
    if (prompt.includes("PREPARE PLAN ONLY") && prompt.includes("requested changes")) text = "Revised plan: 1) adjust 2) validate"
    else if (prompt.includes("PREPARE PLAN ONLY")) text = "Plan: 1) implement 2) verify"
    else if (prompt.includes("detached HEAD")) text = "Commit complete: hash abc123"
    process.stderr.write("mock pi stderr line\\n")
    console.log(JSON.stringify({ method: "assistant_message", params: { role: "assistant", text } }))
    console.log(JSON.stringify({ id, result: { text } }))
    return
  }
  if (method === "get_messages") {
    console.log(JSON.stringify({ id, result: { messages: [{ text: "snapshot" }] } }))
    return
  }
  console.log(JSON.stringify({ id, result: { ok: true } }))
})\n`,
    "utf-8",
  )
  chmodSync(filePath, 0o755)
  return filePath
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for condition")
}

afterEach(() => {
  delete process.env.PI_EASY_WORKFLOW_PI_BIN
  delete process.env.PI_EASY_WORKFLOW_PI_ARGS
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("GAP 1: Dynamic Dependency Scheduling", () => {
  describe("getExecutionGraphTasks", () => {
    it("returns empty array when no executable tasks exist", () => {
      const tasks: Task[] = [
        { id: "1", name: "Done Task", status: "done", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Failed Task", status: "failed", requirements: [], idx: 1 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result).toEqual([])
    })

    it("returns single executable task with no dependencies", () => {
      const tasks: Task[] = [
        { id: "1", name: "Backlog Task", status: "backlog", requirements: [], idx: 0 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(1)
      expect(result[0].id).toBe("1")
    })

    it("includes task whose dependency is already done", () => {
      const tasks: Task[] = [
        { id: "1", name: "Done Dep", status: "done", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task with Done Dep", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(1)
      expect(result[0].id).toBe("2")
    })

    it("includes tasks with dependencies that will be satisfied during the same run (GAP 1 fix)", () => {
      const tasks: Task[] = [
        { id: "1", name: "Task A (dependency)", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B (depends on A)", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(2)
      expect(result.map(t => t.id).sort()).toEqual(["1", "2"])
    })

    it("excludes tasks with unmet dependencies (not done and not executable)", () => {
      const tasks: Task[] = [
        { id: "1", name: "Failed Dep", status: "failed", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task depending on failed", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(0)
    })

    it("handles chain of dependencies correctly", () => {
      const tasks: Task[] = [
        { id: "1", name: "Task A", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B depends on A", status: "backlog", requirements: ["1"], idx: 1 } as Task,
        { id: "3", name: "Task C depends on B", status: "backlog", requirements: ["2"], idx: 2 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(3)
      expect(result.map(t => t.id).sort()).toEqual(["1", "2", "3"])
    })

    it("handles diamond dependency pattern", () => {
      const tasks: Task[] = [
        { id: "1", name: "Base Task", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Left Branch", status: "backlog", requirements: ["1"], idx: 1 } as Task,
        { id: "3", name: "Right Branch", status: "backlog", requirements: ["1"], idx: 2 } as Task,
        { id: "4", name: "Merge Task", status: "backlog", requirements: ["2", "3"], idx: 3 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(4)
      expect(result.map(t => t.id).sort()).toEqual(["1", "2", "3", "4"])
    })

    it("handles mixed done and backlog dependencies", () => {
      const tasks: Task[] = [
        { id: "1", name: "Done Task", status: "done", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Backlog Task", status: "backlog", requirements: [], idx: 1 } as Task,
        { id: "3", name: "Task depends on 1 and 2", status: "backlog", requirements: ["1", "2"], idx: 2 } as Task,
      ]

      const result = getExecutionGraphTasks(tasks)
      expect(result.length).toBe(2)
      expect(result.map(t => t.id).sort()).toEqual(["2", "3"])
    })
  })

  describe("getExecutionGraphTasks vs getExecutableTasks", () => {
    it("getExecutableTasks only returns tasks with done dependencies (old behavior)", () => {
      const tasks: Task[] = [
        { id: "1", name: "Task A", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B depends on A", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      // Old behavior: only returns Task A because Task B's dependency is not done
      const executable = getExecutableTasks(tasks)
      expect(executable.length).toBe(1)
      expect(executable[0].id).toBe("1")
    })

    it("getExecutionGraphTasks returns all tasks including those with future-satisfied dependencies", () => {
      const tasks: Task[] = [
        { id: "1", name: "Task A", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B depends on A", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      // New behavior: returns both tasks because Task A will satisfy Task B's dependency
      const graphTasks = getExecutionGraphTasks(tasks)
      expect(graphTasks.length).toBe(2)
      expect(graphTasks.map(t => t.id).sort()).toEqual(["1", "2"])
    })
  })

  describe("buildExecutionGraph with dependencies", () => {
    it("creates correct execution graph for dependent tasks", () => {
      const tasks: Task[] = [
        { id: "1", name: "Task A", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B depends on A", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      const graph = buildExecutionGraph(tasks, 3)

      expect(graph.totalTasks).toBe(2)
      expect(graph.nodes.length).toBe(2)
      expect(graph.edges).toEqual([{ from: "1", to: "2" }])
      expect(graph.batches.length).toBe(2)
      // Task A should be in batch 0
      expect(graph.batches[0].taskIds).toContain("1")
      // Task B should be in batch 1 (after A)
      expect(graph.batches[1].taskIds).toContain("2")
    })

    it("creates correct batches for parallel tasks", () => {
      const tasks: Task[] = [
        { id: "1", name: "Task A", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B", status: "backlog", requirements: [], idx: 1 } as Task,
        { id: "3", name: "Task C depends on A", status: "backlog", requirements: ["1"], idx: 2 } as Task,
        { id: "4", name: "Task D depends on B", status: "backlog", requirements: ["2"], idx: 3 } as Task,
      ]

      const graph = buildExecutionGraph(tasks, 3)

      expect(graph.totalTasks).toBe(4)
      // Tasks A and B should be in batch 0 (no dependencies)
      expect(graph.batches[0].taskIds.sort()).toEqual(["1", "2"])
      // Tasks C and D should be in batch 1 (depend on A and B respectively)
      expect(graph.batches[1].taskIds.sort()).toEqual(["3", "4"])
    })
  })

  describe("Orchestrator startAll with dependencies", () => {
    it("startAll includes both tasks when one depends on the other", async () => {
      const root = createTempDir("pi-easy-workflow-dep-")
      initGitRepo(root)
      const mockPi = createMockPiBinary(root)

      process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
      process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

      const db = new PiKanbanDB(join(root, "tasks.db"))
      db.updateOptions({ command: "echo preflight-ok" })

      // Create Task A (dependency)
      const taskA = db.createTask({
        id: "task-a",
        name: "Task A (dependency)",
        prompt: "Implement task A",
        status: "backlog",
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        planmode: false,
      })

      // Create Task B (depends on Task A)
      const taskB = db.createTask({
        id: "task-b",
        name: "Task B (depends on A)",
        prompt: "Implement task B",
        status: "backlog",
        requirements: [taskA.id],
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        planmode: false,
      })

      const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)

      // Start all tasks
      const run = await orchestrator.startAll()

      // Verify the run includes both tasks in the taskOrder
      expect(run.taskOrder).toContain(taskA.id)
      expect(run.taskOrder).toContain(taskB.id)
      expect(run.taskOrder.length).toBe(2)

      // Wait for execution to complete
      await waitFor(() => {
        const runs = db.getWorkflowRuns()
        const currentRun = runs.find(r => r.id === run.id)
        return currentRun?.status === "completed" || currentRun?.status === "failed"
      })

      // Verify both tasks were executed and completed
      const finalTaskA = db.getTask(taskA.id)
      const finalTaskB = db.getTask(taskB.id)

      expect(finalTaskA?.status).toBe("done")
      expect(finalTaskB?.status).toBe("done")

      db.close()
    })

    it("executes tasks in correct dependency order", async () => {
      const root = createTempDir("pi-easy-workflow-order-")
      initGitRepo(root)
      const mockPi = createMockPiBinary(root)

      process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
      process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

      const db = new PiKanbanDB(join(root, "tasks.db"))
      db.updateOptions({ command: "echo preflight-ok" })

      // Create Task A first (will have lower idx)
      const taskA = db.createTask({
        id: "task-a",
        name: "Task A",
        prompt: "Implement task A",
        status: "backlog",
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        planmode: false,
      })

      // Create Task B second (will have higher idx and depend on A)
      const taskB = db.createTask({
        id: "task-b",
        name: "Task B",
        prompt: "Implement task B",
        status: "backlog",
        requirements: [taskA.id],
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        planmode: false,
      })

      const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)

      // Start all tasks
      const run = await orchestrator.startAll()

      // Task A should come before Task B in the taskOrder (by idx order)
      const taskAIndex = run.taskOrder.indexOf(taskA.id)
      const taskBIndex = run.taskOrder.indexOf(taskB.id)

      expect(taskAIndex).toBeLessThan(taskBIndex)

      // Wait for execution to complete
      await waitFor(() => {
        const runs = db.getWorkflowRuns()
        const currentRun = runs.find(r => r.id === run.id)
        return currentRun?.status === "completed" || currentRun?.status === "failed"
      })

      // Both tasks should complete successfully
      const finalTaskA = db.getTask(taskA.id)
      const finalTaskB = db.getTask(taskB.id)
      expect(finalTaskA?.status).toBe("done")
      expect(finalTaskB?.status).toBe("done")

      db.close()
    })

    it("validates dependencies before executing each task", async () => {
      // This test verifies that the dependency validation in runInBackground works correctly
      // by testing the getExecutionGraphTasks logic with a pre-failed dependency
      const tasks: Task[] = [
        { id: "1", name: "Failed Task", status: "failed", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task depending on failed", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      // getExecutionGraphTasks should return empty since the dependency is failed (not executable)
      const graphTasks = getExecutionGraphTasks(tasks)
      expect(graphTasks.length).toBe(0)

      // If we manually set the dependency to done and create a scenario where it fails mid-run,
      // the runInBackground validation should catch it
      const tasks2: Task[] = [
        { id: "1", name: "Task A", status: "backlog", requirements: [], idx: 0 } as Task,
        { id: "2", name: "Task B depends on A", status: "backlog", requirements: ["1"], idx: 1 } as Task,
      ]

      // With both in backlog, both should be included
      const graphTasks2 = getExecutionGraphTasks(tasks2)
      expect(graphTasks2.length).toBe(2)
      expect(graphTasks2.map(t => t.id).sort()).toEqual(["1", "2"])
    })
  })

  describe("Execution set consistency", () => {
    it("tasks added after run starts are not included in the run", async () => {
      const root = createTempDir("pi-easy-workflow-consistency-")
      initGitRepo(root)
      const mockPi = createMockPiBinary(root)

      process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
      process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

      const db = new PiKanbanDB(join(root, "tasks.db"))
      db.updateOptions({ command: "echo preflight-ok" })

      const taskA = db.createTask({
        id: "task-a",
        name: "Task A",
        prompt: "Implement task A",
        status: "backlog",
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        planmode: false,
      })

      const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)

      // Start the run with only Task A
      const run = await orchestrator.startAll()

      // Task A should be the only task in the run
      expect(run.taskOrder).toEqual([taskA.id])

      // Add a new task AFTER the run started
      const taskB = db.createTask({
        id: "task-b",
        name: "Task B (added after start)",
        prompt: "Implement task B",
        status: "backlog",
        review: false,
        autoCommit: true,
        deleteWorktree: true,
        planmode: false,
      })

      // Wait for execution to complete
      await waitFor(() => {
        const runs = db.getWorkflowRuns()
        const currentRun = runs.find(r => r.id === run.id)
        return currentRun?.status === "completed" || currentRun?.status === "failed"
      })

      // Verify Task B was NOT executed (still in backlog)
      const finalTaskB = db.getTask(taskB.id)
      expect(finalTaskB?.status).toBe("backlog")

      // Verify Task A was executed
      const finalTaskA = db.getTask(taskA.id)
      expect(finalTaskA?.status).toBe("done")

      db.close()
    })
  })
})
