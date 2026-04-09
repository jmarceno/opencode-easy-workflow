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

describe("PiOrchestrator standard execution", () => {
  it("executes a standard task end-to-end with pre-command, commit prompt, merge, and status transitions", async () => {
    const root = createTempDir("pi-easy-workflow-exec-")
    initGitRepo(root)
    const mockPi = createMockPiBinary(root)

    process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ command: "echo preflight-ok" })

    const task = db.createTask({
      id: "exec-1",
      name: "Standard execution task",
      prompt: "Implement standard task",
      status: "backlog",
      review: false,
      autoCommit: true,
      deleteWorktree: true,
      planmode: false,
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)
    await orchestrator.startSingle(task.id)

    await waitFor(() => {
      const current = db.getTask(task.id)
      return Boolean(current && (current.status === "done" || current.status === "failed"))
    })

    const current = db.getTask(task.id)
    expect(current).not.toBeNull()
    expect(current?.status).toBe("done")
    expect(current?.completedAt).not.toBeNull()
    expect(current?.agentOutput.includes("[command stdout]")).toBe(true)
    expect(current?.agentOutput.includes("preflight-ok")).toBe(true)
    expect(current?.agentOutput.includes("Implemented changes end to end")).toBe(true)
    expect(current?.agentOutput.includes("[commit]")).toBe(true)
    expect(current?.sessionId).not.toBeNull()

    const sessions = db.getWorkflowSessionsByTask(task.id)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    const io = db.getSessionIO(sessions[0]!.id)
    expect(io.some((record) => record.recordType === "rpc_command")).toBe(true)
    expect(io.some((record) => record.recordType === "rpc_response")).toBe(true)
    expect(io.some((record) => record.recordType === "rpc_event")).toBe(true)
    expect(io.some((record) => record.recordType === "stderr_chunk")).toBe(true)
    expect(io.some((record) => record.recordType === "lifecycle")).toBe(true)
    expect(io.some((record) => record.recordType === "prompt_rendered")).toBe(true)
    expect(io.some((record) => record.recordType === "snapshot")).toBe(true)

    db.close()
  })
})
