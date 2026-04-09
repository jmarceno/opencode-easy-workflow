import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"

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
  git(root, ["checkout", "-b", "master"])
  writeFileSync(join(root, "README.md"), "# orchestration test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi-orchestration.js")
  writeFileSync(
    filePath,
    `#!/usr/bin/env bun
import { createInterface } from "readline"
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch { return }
  const id = request?.id
  const type = request?.type
  const prompt = String(request?.message || "")

  if (type === "set_model" || type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
    return
  }

  if (type === "prompt") {
    const text = prompt.includes("Task A")
      ? "Completed Task A implementation"
      : prompt.includes("Task B")
        ? "Completed Task B implementation"
        : "Completed task"
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  if (type === "get_messages") {
    console.log(JSON.stringify({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ role: "assistant", text: "Completed task" }] } }))
    return
  }

  console.log(JSON.stringify({ id, type: "response", command: type || "unknown", success: true, data: {} }))
})
`,
    "utf-8",
  )
  chmodSync(filePath, 0o755)
  return filePath
}

async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
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

describe("PiOrchestrator dependency-aware workflow runs", () => {
  it("executes dependency chains in order for targeted task runs", async () => {
    const root = createTempDir("pi-easy-workflow-orchestration-")
    initGitRepo(root)
    process.env.PI_EASY_WORKFLOW_PI_BIN = createMockPiBinary(root)
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master" })

    const taskA = db.createTask({
      id: "orch-a",
      name: "Task A",
      prompt: "Implement Task A",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [],
    })
    const taskB = db.createTask({
      id: "orch-b",
      name: "Task B",
      prompt: "Implement Task B after A",
      status: "backlog",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      requirements: [taskA.id],
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)
    const run = await orchestrator.startSingle(taskB.id)

    await waitFor(() => {
      const latest = db.getWorkflowRun(run.id)
      return Boolean(latest && (latest.status === "completed" || latest.status === "failed"))
    })

    const finalRun = db.getWorkflowRun(run.id)
    expect(finalRun?.status).toBe("completed")
    expect(finalRun?.taskOrder).toEqual([taskA.id, taskB.id])
    expect(finalRun?.currentTaskIndex).toBeGreaterThanOrEqual(0)

    const finalA = db.getTask(taskA.id)
    const finalB = db.getTask(taskB.id)
    expect(finalA?.status).toBe("done")
    expect(finalB?.status).toBe("done")
    expect(finalA?.completedAt).not.toBeNull()
    expect(finalB?.completedAt).not.toBeNull()
    expect((finalA?.completedAt ?? 0) <= (finalB?.completedAt ?? 0)).toBe(true)

    const sessionsA = db.getWorkflowSessionsByTask(taskA.id)
    const sessionsB = db.getWorkflowSessionsByTask(taskB.id)
    expect(sessionsA.length).toBeGreaterThan(0)
    expect(sessionsB.length).toBeGreaterThan(0)

    const ioA = db.getSessionIO(sessionsA[0]!.id)
    const ioB = db.getSessionIO(sessionsB[0]!.id)
    expect(ioA.some((record) => record.recordType === "rpc_command")).toBe(true)
    expect(ioB.some((record) => record.recordType === "rpc_command")).toBe(true)
    expect(ioA.some((record) => record.recordType === "prompt_rendered")).toBe(true)
    expect(ioB.some((record) => record.recordType === "prompt_rendered")).toBe(true)

    db.close()
  })
})
