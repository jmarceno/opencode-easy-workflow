import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PiKanbanDB } from "../src/db.ts"
import { PiOrchestrator } from "../src/orchestrator.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim()
}

function initGitRepo(root: string): void {
  git(root, ["init"])
  git(root, ["checkout", "-b", "master"])
  writeFileSync(join(root, "README.md"), "# best-of-n test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi-best-of-n.js")
  const mockScript = `#!/usr/bin/env bun
import { createInterface } from "readline"

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  let request = null
  try { request = JSON.parse(line) } catch { return }

  const id = request?.id
  const type = request?.type

  if (type === "set_model" || type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: type, success: true }))
    return
  }

  if (type === "prompt") {
    const prompt = String(request?.message || "")

    if (prompt.includes("reviewer in a best-of-n workflow")) {
      if (prompt.includes("force-manual")) {
        const manual = {
          status: "needs_manual_review",
          summary: "Manual review required",
          bestCandidateIds: [],
          gaps: ["Needs human verification"],
          recommendedFinalStrategy: "pick_best",
          recommendedPrompt: "Stop for manual review"
        }
        const text = JSON.stringify(manual)
        console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true, data: { text } }))
        console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
        console.log(JSON.stringify({ type: "agent_end" }))
        return
      }

      const result = {
        status: "pass",
        summary: "Candidate c1 is strongest",
        bestCandidateIds: ["candidate-1"],
        gaps: [],
        recommendedFinalStrategy: "pick_or_synthesize",
        recommendedPrompt: "Prefer candidate-1 approach"
      }
      const text = JSON.stringify(result)
      console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true, data: { text } }))
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
      console.log(JSON.stringify({ type: "agent_end" }))
      return
    }

    let text = "Worker implemented candidate changes"
    if (prompt.includes("final applier in a best-of-n workflow")) {
      text = "Final applier completed integration"
    }
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true, data: { text } }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  if (type === "get_messages") {
    console.log(JSON.stringify({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ text: "snapshot" }] } }))
    return
  }

  console.log(JSON.stringify({ id, type: "response", command: type, success: true, data: { ok: true } }))
})
`
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

describe("PiOrchestrator best-of-n execution", () => {
  it("runs worker/reviewer/final-applier sessions with Pi and preserves run visibility", async () => {
    const root = createTempDir("pi-easy-workflow-bestofn-")
    initGitRepo(root)

    const mockPi = createMockPiBinary(root)
    process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master" })
    const task = db.createTask({
      id: "bon-1",
      name: "Best of N task",
      prompt: "Implement best-of-n flow",
      status: "backlog",
      executionStrategy: "best_of_n",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      bestOfNConfig: {
        workers: [{ model: "default", count: 2 }],
        reviewers: [{ model: "default", count: 1 }],
        finalApplier: { model: "default" },
        minSuccessfulWorkers: 1,
        selectionMode: "pick_or_synthesize",
      },
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)
    await orchestrator.startSingle(task.id)

    await waitFor(() => {
      const current = db.getTask(task.id)
      return Boolean(current && (current.status === "done" || current.status === "failed" || current.status === "review"))
    })

    const current = db.getTask(task.id)
    expect(current?.status).toBe("done")
    expect(current?.bestOfNSubstage).toBe("completed")

    const runs = db.getTaskRuns(task.id)
    expect(runs.filter((run) => run.phase === "worker").length).toBe(2)
    expect(runs.filter((run) => run.phase === "reviewer").length).toBe(1)
    expect(runs.filter((run) => run.phase === "final_applier").length).toBe(1)
    expect(runs.every((run) => run.status === "done")).toBe(true)

    const candidates = db.getTaskCandidates(task.id)
    expect(candidates.length).toBe(2)
    expect(candidates.some((candidate) => candidate.status === "selected")).toBe(true)

    const sessions = db.getWorkflowSessionsByTask(task.id)
    expect(sessions.length).toBeGreaterThanOrEqual(4)
    expect(sessions.some((session) => session.sessionKind === "task_run_worker")).toBe(true)
    expect(sessions.some((session) => session.sessionKind === "task_run_reviewer")).toBe(true)
    expect(sessions.some((session) => session.sessionKind === "task_run_final_applier")).toBe(true)

    const firstSessionIo = db.getSessionIO(sessions[0]!.id)
    expect(firstSessionIo.some((record) => record.recordType === "rpc_command")).toBe(true)
    expect(firstSessionIo.some((record) => record.recordType === "rpc_response" || record.recordType === "rpc_event")).toBe(true)

    db.close()
  })

  it("routes to manual review when reviewers request manual review", async () => {
    const root = createTempDir("pi-easy-workflow-bestofn-manual-")
    initGitRepo(root)

    const mockPi = createMockPiBinary(root)
    process.env.PI_EASY_WORKFLOW_PI_BIN = mockPi
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const db = new PiKanbanDB(join(root, "tasks.db"))
    db.updateOptions({ branch: "master" })
    const task = db.createTask({
      id: "bon-2",
      name: "Best of N manual review task",
      prompt: "Implement and ask for manual review",
      status: "backlog",
      executionStrategy: "best_of_n",
      review: false,
      autoCommit: false,
      deleteWorktree: true,
      bestOfNConfig: {
        workers: [{ model: "default", count: 1 }],
        reviewers: [{ model: "default", count: 1, taskSuffix: "force-manual" }],
        finalApplier: { model: "default" },
        minSuccessfulWorkers: 1,
        selectionMode: "pick_best",
      },
    })

    const orchestrator = new PiOrchestrator(db, () => {}, (sessionId) => `/#session/${sessionId}`, root)
    await orchestrator.startSingle(task.id)

    await waitFor(() => {
      const current = db.getTask(task.id)
      return Boolean(current && (current.status === "review" || current.status === "failed" || current.status === "done"))
    })

    const current = db.getTask(task.id)
    expect(current?.status).toBe("review")
    expect(current?.bestOfNSubstage).toBe("blocked_for_manual_review")

    const finalRuns = db.getTaskRunsByPhase(task.id, "final_applier")
    expect(finalRuns.length).toBe(0)

    db.close()
  })
})
