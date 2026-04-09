import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createPiServer } from "../src/server.ts"

const tempDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("PiKanbanServer API", () => {
  it("supports tasks/options/runs/models and session endpoints", async () => {
    const root = createTempDir("pi-easy-workflow-server-")
    const dbPath = join(root, "tasks.db")
    const { db, server } = createPiServer({ dbPath, port: 0 })

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
})
