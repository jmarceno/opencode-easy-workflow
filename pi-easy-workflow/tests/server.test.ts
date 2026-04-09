import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createPiServer } from "../src/server.ts"

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
  writeFileSync(join(root, "README.md"), "# server test\n", "utf-8")
  git(root, ["add", "README.md"])
  git(root, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "init"])
}

function createMockPiBinary(root: string): string {
  const filePath = join(root, "mock-pi-server.js")
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
  
  // Handle set_model command
  if (type === "set_model") {
    console.log(JSON.stringify({ id, type: "response", command: "set_model", success: true, data: { provider: request.provider, id: request.modelId } }))
    return
  }
  
  // Handle set_thinking_level command
  if (type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: "set_thinking_level", success: true }))
    return
  }
  
  // Handle prompt command - returns immediately, then sends events
  if (type === "prompt") {
    // Send success response first
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    // Then send streaming events
    const text = "Local session viewer execution output"
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } }))
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_complete", text } }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }
  
  // Handle get_messages command
  if (type === "get_messages") {
    console.log(JSON.stringify({ 
      id, 
      type: "response", 
      command: "get_messages", 
      success: true, 
      data: { 
        messages: [
          { role: "user", text: "test prompt" },
          { role: "assistant", text: "Local session viewer execution output" }
        ] 
      } 
    }))
    return
  }
  
  // Handle get_state command
  if (type === "get_state") {
    console.log(JSON.stringify({ 
      id, 
      type: "response", 
      command: "get_state", 
      success: true, 
      data: { 
        isStreaming: false,
        messageCount: 2,
        thinkingLevel: "medium",
        steeringMode: "all",
        followUpMode: "all",
        autoCompactionEnabled: false
      } 
    }))
    return
  }
  
  // Default response for unknown commands
  console.log(JSON.stringify({ id, type: "response", command: type || "unknown", success: true, data: {} }))
})
`,
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

describe("PiKanbanServer API", () => {
  it("supports tasks/options/runs/models and session endpoints", async () => {
    const root = createTempDir("pi-easy-workflow-server-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0 })
    db.updateOptions({ branch: "master" })

    const port = await server.start(0)
    const baseUrl = `http://127.0.0.1:${port}`

    const api = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      const data = text ? JSON.parse(text) : null
      return { response, data }
    }

    try {
      const optionsRes = await api("/api/options")
      expect(optionsRes.response.status).toBe(200)
      expect(optionsRes.data.parallelTasks).toBe(1)

      const createTaskRes = await api("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Server API test task",
          prompt: "Verify server endpoints",
          status: "backlog",
          executionStrategy: "standard",
          planmode: false,
          review: true,
        }),
      })
      expect(createTaskRes.response.status).toBe(201)
      expect(createTaskRes.data.name).toBe("Server API test task")
      const taskId = createTaskRes.data.id as string

      const listTasksRes = await api("/api/tasks")
      expect(listTasksRes.response.status).toBe(200)
      expect(Array.isArray(listTasksRes.data)).toBe(true)
      expect(listTasksRes.data.length).toBe(1)

      const patchTaskRes = await api(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "review", awaitingPlanApproval: true, executionPhase: "plan_complete_waiting_approval" }),
      })
      expect(patchTaskRes.response.status).toBe(200)
      expect(patchTaskRes.data.status).toBe("review")

      const reviewStatusRes = await api(`/api/tasks/${taskId}/review-status`)
      expect(reviewStatusRes.response.status).toBe(200)
      expect(reviewStatusRes.data.taskId).toBe(taskId)

      const runsRes = await api("/api/runs")
      expect(runsRes.response.status).toBe(200)
      expect(Array.isArray(runsRes.data)).toBe(true)

      const graphRes = await api("/api/execution-graph")
      expect([200, 400]).toContain(graphRes.response.status)

      const modelsRes = await api("/api/models")
      expect(modelsRes.response.status).toBe(200)
      expect(Array.isArray(modelsRes.data.providers)).toBe(true)
      expect(typeof modelsRes.data.defaults).toBe("object")

      const session = db.createWorkflowSession({
        id: "session-api-1",
        taskId,
        sessionKind: "task",
        cwd: root,
      })
      db.updateTask(taskId, { sessionId: session.id, sessionUrl: "https://opencode.ai/session/legacy-id" })
      db.createSessionMessage({
        sessionId: session.id,
        taskId,
        role: "assistant",
        messageType: "assistant_response",
        contentJson: { text: "hello from session" },
      })

      db.getRawHandle().prepare(
        `
        INSERT INTO task_runs (id, task_id, phase, model, status, session_id, session_url, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'worker', 'default', 'running', ?, ?, '{}', unixepoch(), unixepoch())
        `,
      ).run("run-session-api-1", taskId, session.id, "https://opencode.ai/session/task-run-legacy")

      const sessionRes = await api(`/api/sessions/${session.id}`)
      expect(sessionRes.response.status).toBe(200)
      expect(sessionRes.data.id).toBe(session.id)

      const taskRes = await api(`/api/tasks/${taskId}`)
      expect(taskRes.response.status).toBe(200)
      expect(taskRes.data.sessionUrl).toBe(`/#session/${session.id}`)

      const sessionMessagesRes = await api(`/api/sessions/${session.id}/messages`)
      expect(sessionMessagesRes.response.status).toBe(200)
      expect(Array.isArray(sessionMessagesRes.data)).toBe(true)
      expect(sessionMessagesRes.data.length).toBe(1)

      const taskRunsRes = await api(`/api/tasks/${taskId}/runs`)
      expect(taskRunsRes.response.status).toBe(200)
      expect(Array.isArray(taskRunsRes.data)).toBe(true)
      expect(taskRunsRes.data[0]?.sessionUrl).toBe(`/#session/${session.id}`)

      const bonTaskRes = await api("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Best of N API task",
          prompt: "Run best-of-n",
          status: "backlog",
          executionStrategy: "best_of_n",
          bestOfNConfig: {
            workers: [{ model: "default", count: 1 }],
            reviewers: [{ model: "default", count: 1 }],
            finalApplier: { model: "default" },
            minSuccessfulWorkers: 1,
            selectionMode: "pick_best",
          },
        }),
      })
      expect(bonTaskRes.response.status).toBe(201)
      const bonTaskId = bonTaskRes.data.id as string

      db.createTaskRun({
        id: "bon-run-worker",
        taskId: bonTaskId,
        phase: "worker",
        slotIndex: 0,
        attemptIndex: 0,
        model: "default",
        status: "done",
      })
      const bonCandidate = db.createTaskCandidate({
        id: "bon-candidate-1",
        taskId: bonTaskId,
        workerRunId: "bon-run-worker",
        status: "available",
        summary: "candidate output",
      })

      const bonSummaryRes = await api(`/api/tasks/${bonTaskId}/best-of-n-summary`)
      expect(bonSummaryRes.response.status).toBe(200)
      expect(bonSummaryRes.data.taskId).toBe(bonTaskId)
      expect(typeof bonSummaryRes.data.expandedWorkerCount).toBe("number")
      expect(typeof bonSummaryRes.data.finalApplierDone).toBe("boolean")

      const selectCandidateRes = await api(`/api/tasks/${bonTaskId}/best-of-n/select-candidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: bonCandidate.id }),
      })
      expect(selectCandidateRes.response.status).toBe(200)
      expect(selectCandidateRes.data.selectedCandidate).toBe(bonCandidate.id)

      const abortBonRes = await api(`/api/tasks/${bonTaskId}/best-of-n/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual hold" }),
      })
      expect(abortBonRes.response.status).toBe(200)
      expect(abortBonRes.data.task.status).toBe("review")
      expect(abortBonRes.data.task.bestOfNSubstage).toBe("blocked_for_manual_review")

      const sessionTimelineRes = await api(`/api/sessions/${session.id}/timeline`)
      expect(sessionTimelineRes.response.status).toBe(200)
      expect(Array.isArray(sessionTimelineRes.data)).toBe(true)

      const taskMessagesRes = await api(`/api/tasks/${taskId}/messages`)
      expect(taskMessagesRes.response.status).toBe(200)
      expect(Array.isArray(taskMessagesRes.data)).toBe(true)
      expect(taskMessagesRes.data.length).toBe(1)

      const sessionEventRes = await api(`/api/pi/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          role: "assistant",
          messageType: "text",
          text: "stream update",
          contentJson: { text: "stream update" },
        }),
      })
      expect(sessionEventRes.response.status).toBe(200)
      expect(sessionEventRes.data.ok).toBe(true)
    } finally {
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket task updates", async () => {
    const root = createTempDir("pi-easy-workflow-ws-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0 })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      const firstMessagePromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for websocket message")), 5000)

        ws.addEventListener("message", (event) => {
          clearTimeout(timeout)
          resolve(JSON.parse(String(event.data)))
        }, { once: true })
      })

      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "WS test task",
          prompt: "Ensure websocket receives task_created",
          status: "backlog",
        }),
      })

      expect(response.status).toBe(201)

      const event = await firstMessagePromise
      expect(event.type).toBe("task_created")
      expect(event.payload.name).toBe("WS test task")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("broadcasts websocket session message updates", async () => {
    const root = createTempDir("pi-easy-workflow-session-ws-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0 })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)

    const session = db.createWorkflowSession({
      id: "session-ws-1",
      sessionKind: "task",
      cwd: root,
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }))

      const sessionMessageEventPromise = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for session websocket message")), 5000)

        const handler = (event: any) => {
          const parsed = JSON.parse(String(event.data))
          if (parsed?.type !== "session_message_created") return
          clearTimeout(timeout)
          ws.removeEventListener("message", handler)
          resolve(parsed)
        }

        ws.addEventListener("message", handler)
      })

      const response = await fetch(`http://127.0.0.1:${port}/api/pi/sessions/${session.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message",
          role: "assistant",
          messageType: "thinking",
          contentJson: { text: "thinking about fix" },
        }),
      })

      expect(response.status).toBe(200)

      const event = await sessionMessageEventPromise
      expect(event.type).toBe("session_message_created")
      expect(event.payload.sessionId).toBe(session.id)
      expect(event.payload.messageType).toBe("thinking")
    } finally {
      ws.close()
      server.stop()
      db.close()
    }
  })

  it("supports local session viewing for real orchestrated runs", async () => {
    const root = createTempDir("pi-easy-workflow-local-session-view-")
    initGitRepo(root)
    process.env.PI_EASY_WORKFLOW_PI_BIN = createMockPiBinary(root)
    process.env.PI_EASY_WORKFLOW_PI_ARGS = ""

    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0 })
    db.updateOptions({ branch: "master" })
    const port = await server.start(0)
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const createTaskResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Local session viewer task",
          prompt: "Execute task and verify local session viewer APIs",
          status: "backlog",
          review: false,
          autoCommit: false,
          executionStrategy: "standard",
        }),
      })
      expect(createTaskResponse.status).toBe(201)
      const createdTask = await createTaskResponse.json()

      const startResponse = await fetch(`${baseUrl}/api/tasks/${createdTask.id}/start`, { method: "POST" })
      expect(startResponse.status).toBe(200)

      await waitFor(() => {
        const current = db.getTask(createdTask.id)
        return Boolean(current && (current.status === "done" || current.status === "failed"))
      })

      const finalTaskResponse = await fetch(`${baseUrl}/api/tasks/${createdTask.id}`)
      expect(finalTaskResponse.status).toBe(200)
      const finalTask = await finalTaskResponse.json()
      expect(finalTask.status).toBe("done")
      expect(finalTask.sessionId).toBeTruthy()
      expect(finalTask.sessionUrl).toBe(`/#session/${encodeURIComponent(finalTask.sessionId)}`)

      const sessionResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(finalTask.sessionId)}`)
      expect(sessionResponse.status).toBe(200)
      const session = await sessionResponse.json()
      expect(session.id).toBe(finalTask.sessionId)

      const messagesResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(finalTask.sessionId)}/messages?limit=1000`)
      expect(messagesResponse.status).toBe(200)
      const messages = await messagesResponse.json()
      expect(Array.isArray(messages)).toBe(true)
      expect(messages.length).toBeGreaterThan(0)

      const timelineResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(finalTask.sessionId)}/timeline`)
      expect(timelineResponse.status).toBe(200)
      const timeline = await timelineResponse.json()
      expect(Array.isArray(timeline)).toBe(true)
      expect(timeline.length).toBeGreaterThan(0)

      const ioResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(finalTask.sessionId)}/io?limit=1000`)
      expect(ioResponse.status).toBe(200)
      const io = await ioResponse.json()
      expect(Array.isArray(io)).toBe(true)
      expect(io.some((record: any) => record.recordType === "rpc_command")).toBe(true)
      expect(io.some((record: any) => record.recordType === "prompt_rendered")).toBe(true)
    } finally {
      server.stop()
      db.close()
    }
  })
})
