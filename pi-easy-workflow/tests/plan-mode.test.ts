import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { PiKanbanServer } from "../src/server/server.ts"
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
  writeFileSync(join(root, "README.md"), "# plan mode test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi-plan.js")
  const mockScript = `#!/usr/bin/env bun
import { createInterface } from "readline"
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch {
    return
  }
  const id = request?.id
  const type = request?.type
  const message = String(request?.message || "")
  if (type === "set_model" || type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
    return
  }
  if (type === "prompt") {
    let text = "Implemented approved plan"
    if (message.includes("PREPARE PLAN ONLY") && message.includes("requested changes")) text = "Revised plan: address feedback"
    else if (message.includes("PREPARE PLAN ONLY")) text = "Initial plan: step A then B"
    else if (message.includes("detached HEAD")) text = "Commit from plan task complete"
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }
  if (type === "get_messages") {
    console.log(JSON.stringify({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ text: "snapshot" }] } }))
    return
  }
  console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
})\n`
  writeFileSync(filePath, mockScript, "utf-8")
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

describe("Plan mode flows", () => {
  it("supports revision requests, approval transitions, and implementation completion", async () => {
    const root = createTempDir("pi-easy-workflow-plan-")
    initGitRepo(root)
    const mockPi = createMockPiBinary(root)
    process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)
    const server = new PiKanbanServer(db, {
      port: 0,
      onStart: async () => await orchestrator.startAll(),
      onStartSingle: async (taskId) => await orchestrator.startSingle(taskId),
      onStop: async () => {
        await orchestrator.stop()
        return { ok: true }
      },
    })

    const port = await server.start(0)
    const baseUrl = `http://127.0.0.1:${port}`

    const api = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      return {
        response,
        data: text ? JSON.parse(text) : null,
      }
    }

    const task = db.createTask({
      id: "plan-1",
      name: "Plan mode task",
      prompt: "Implement with planning",
      status: "backlog",
      planmode: true,
      autoApprovePlan: false,
      review: false,
      autoCommit: false,
      deleteWorktree: true,
    })

    try {
      const startPlan = await api(`/api/tasks/${task.id}/start`, { method: "POST" })
      expect(startPlan.response.status).toBe(200)

      await waitFor(() => {
        const current = db.getTask(task.id)
        return Boolean(current && current.status === "review" && current.awaitingPlanApproval)
      })

      let current = db.getTask(task.id)
      expect(current?.executionPhase).toBe("plan_complete_waiting_approval")
      expect(current?.agentOutput.includes("[plan]")).toBe(true)

      const revision = await api(`/api/tasks/${task.id}/request-revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Please revise this plan" }),
      })
      expect(revision.response.status).toBe(200)
      expect(revision.data.task.executionPhase).toBe("plan_revision_pending")

      await waitFor(() => {
        const latest = db.getTask(task.id)
        return Boolean(latest && latest.status === "review" && latest.awaitingPlanApproval && latest.planRevisionCount >= 1)
      })

      current = db.getTask(task.id)
      expect(current?.agentOutput.includes("[user-revision-request]")).toBe(true)
      expect(current?.agentOutput.match(/\[plan\]/g)?.length).toBeGreaterThanOrEqual(2)

      const approval = await api(`/api/tasks/${task.id}/approve-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalNote: "Looks good. Implement now." }),
      })
      expect(approval.response.status).toBe(200)
      expect(approval.data.executionPhase).toBe("implementation_pending")
      expect(approval.data.awaitingPlanApproval).toBe(false)

      const runImpl = await api(`/api/tasks/${task.id}/start`, { method: "POST" })
      expect(runImpl.response.status).toBe(200)

      await waitFor(() => {
        const latest = db.getTask(task.id)
        return Boolean(latest && (latest.status === "done" || latest.status === "failed"))
      })

      current = db.getTask(task.id)
      expect(current?.status).toBe("done")
      expect(current?.executionPhase).toBe("implementation_done")
      expect(current?.agentOutput.includes("[user-approval-note]")).toBe(true)
      expect(current?.agentOutput.includes("[exec]")).toBe(true)
    } finally {
      server.stop()
      db.close()
    }
  })
})
