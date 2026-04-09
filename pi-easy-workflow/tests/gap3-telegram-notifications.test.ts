import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { PiKanbanDB } from "../src/db.ts"
import { sendTelegramNotification, type TelegramConfig } from "../src/telegram.ts"
import type { TaskStatus } from "../src/types.ts"

const tempDirs: string[] = []

function createTempDb(): { db: PiKanbanDB; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-easy-workflow-telegram-"))
  tempDirs.push(root)
  const dbPath = join(root, "tasks.db")
  const db = new PiKanbanDB(dbPath)
  return { db, dbPath }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("Telegram Notification Module", () => {
  describe("sendTelegramNotification", () => {
    it("returns error when not configured", async () => {
      const result = await sendTelegramNotification(
        { botToken: "", chatId: "" },
        "Test Task",
        "backlog",
        "executing"
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe("not configured")
    })

    it("returns error when only botToken is provided", async () => {
      const result = await sendTelegramNotification(
        { botToken: "test-token", chatId: "" },
        "Test Task",
        "backlog",
        "executing"
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe("not configured")
    })

    it("returns error when only chatId is provided", async () => {
      const result = await sendTelegramNotification(
        { botToken: "", chatId: "123456" },
        "Test Task",
        "backlog",
        "executing"
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe("not configured")
    })

    it("builds correct message format with status emoji", async () => {
      // Mock fetch to capture the message being sent
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { message_id: 123 } }),
        } as Response)
      )
      global.fetch = mockFetch

      await sendTelegramNotification(
        { botToken: "test-token", chatId: "123456" },
        "My Test Task",
        "backlog",
        "done"
      )

      expect(mockFetch).toHaveBeenCalled()
      const call = mockFetch.mock.calls[0]
      const url = call[0] as string
      const options = call[1] as RequestInit
      const body = JSON.parse(options.body as string)

      expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage")
      expect(body.chat_id).toBe("123456")
      expect(body.parse_mode).toBe("Markdown")
      expect(body.text).toContain("✅ *Task State Update*")
      expect(body.text).toContain("*Task:* My Test Task")
      expect(body.text).toContain("*From:* `backlog` → *To:* `done`")
    })

    it("uses correct emoji for each status", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { message_id: 1 } }),
        } as Response)
      )
      global.fetch = mockFetch

      const testCases: { status: TaskStatus; expectedEmoji: string }[] = [
        { status: "template", expectedEmoji: "📄" },
        { status: "backlog", expectedEmoji: "📌" },
        { status: "executing", expectedEmoji: "▶️" },
        { status: "review", expectedEmoji: "🧩" },
        { status: "done", expectedEmoji: "✅" },
        { status: "failed", expectedEmoji: "❌" },
        { status: "stuck", expectedEmoji: "🚫" },
      ]

      for (const { status, expectedEmoji } of testCases) {
        mockFetch.mockClear()

        await sendTelegramNotification(
          { botToken: "test-token", chatId: "123456" },
          "Test Task",
          "backlog",
          status
        )

        const call = mockFetch.mock.calls[0]
        const options = call[1] as RequestInit
        const body = JSON.parse(options.body as string)

        expect(body.text).toContain(`${expectedEmoji} *Task State Update*`)
      }
    })

    it("returns success with messageId on successful send", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { message_id: 456 } }),
        } as Response)
      )
      global.fetch = mockFetch

      const result = await sendTelegramNotification(
        { botToken: "test-token", chatId: "123456" },
        "Test Task",
        "executing",
        "done"
      )

      expect(result.success).toBe(true)
      expect(result.messageId).toBe(456)
    })

    it("returns error when HTTP request fails", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve("Bad Request"),
        } as Response)
      )
      global.fetch = mockFetch

      const result = await sendTelegramNotification(
        { botToken: "test-token", chatId: "123456" },
        "Test Task",
        "backlog",
        "executing"
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain("HTTP 400")
    })

    it("returns error on network failure", async () => {
      const mockFetch = mock(() => Promise.reject(new Error("Network error")))
      global.fetch = mockFetch

      const result = await sendTelegramNotification(
        { botToken: "test-token", chatId: "123456" },
        "Test Task",
        "backlog",
        "executing"
      )

      expect(result.success).toBe(false)
      expect(result.error).toBe("Network error")
    })

    it("handles malformed JSON response gracefully", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("Invalid JSON")),
        } as Response)
      )
      global.fetch = mockFetch

      const result = await sendTelegramNotification(
        { botToken: "test-token", chatId: "123456" },
        "Test Task",
        "backlog",
        "done"
      )

      // Should still succeed even if JSON parsing fails
      expect(result.success).toBe(true)
      expect(result.messageId).toBeUndefined()
    })

    it("calls custom logger with success message", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ result: { message_id: 789 } }),
        } as Response)
      )
      global.fetch = mockFetch

      const logs: string[] = []
      const customLogger = (msg: string) => logs.push(msg)

      await sendTelegramNotification(
        { botToken: "test-token", chatId: "123456" },
        "Important Task",
        "executing",
        "done",
        customLogger
      )

      expect(logs.length).toBe(1)
      expect(logs[0]).toContain("[telegram] notification sent")
      expect(logs[0]).toContain("Important Task")
      expect(logs[0]).toContain("executing → done")
    })

    it("calls custom logger with error message on failure", async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve("Unauthorized"),
        } as Response)
      )
      global.fetch = mockFetch

      const logs: string[] = []
      const customLogger = (msg: string) => logs.push(msg)

      await sendTelegramNotification(
        { botToken: "invalid-token", chatId: "123456" },
        "Test Task",
        "backlog",
        "executing",
        customLogger
      )

      expect(logs.length).toBe(1)
      expect(logs[0]).toContain("[telegram] send failed")
      expect(logs[0]).toContain("401")
    })
  })
})

describe("Database Status Change Listener", () => {
  it("registers and calls listener on status change", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // Update status - should trigger listener
    db.updateTask("task-1", { status: "executing" })

    expect(statusChanges.length).toBe(1)
    expect(statusChanges[0].taskId).toBe("task-1")
    expect(statusChanges[0].oldStatus).toBe("backlog")
    expect(statusChanges[0].newStatus).toBe("executing")

    db.close()
  })

  it("does not call listener when status is unchanged", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // Update without changing status
    db.updateTask("task-1", { name: "Updated Name" })

    expect(statusChanges.length).toBe(0)

    db.close()
  })

  it("does not call listener when only other fields are updated", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // Update various fields without changing status
    db.updateTask("task-1", { name: "New Name" })
    db.updateTask("task-1", { prompt: "New prompt" })
    db.updateTask("task-1", { agentOutput: "some output" })
    db.updateTask("task-1", { reviewCount: 1 })

    expect(statusChanges.length).toBe(0)

    db.close()
  })

  it("calls listener for each status change", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // Multiple status changes
    db.updateTask("task-1", { status: "executing" })
    db.updateTask("task-1", { status: "review" })
    db.updateTask("task-1", { status: "done" })

    expect(statusChanges.length).toBe(3)
    expect(statusChanges[0]).toEqual({ taskId: "task-1", oldStatus: "backlog", newStatus: "executing" })
    expect(statusChanges[1]).toEqual({ taskId: "task-1", oldStatus: "executing", newStatus: "review" })
    expect(statusChanges[2]).toEqual({ taskId: "task-1", oldStatus: "review", newStatus: "done" })

    db.close()
  })

  it("allows removing listener by setting null", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // Remove listener
    db.setTaskStatusChangeListener(null)

    // Status change should not trigger listener
    db.updateTask("task-1", { status: "executing" })

    expect(statusChanges.length).toBe(0)

    db.close()
  })

  it("tracks status changes for multiple tasks independently", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    db.createTask({
      id: "task-1",
      name: "Task 1",
      prompt: "Prompt 1",
      status: "backlog",
    })

    db.createTask({
      id: "task-2",
      name: "Task 2",
      prompt: "Prompt 2",
      status: "backlog",
    })

    // Change status of both tasks
    db.updateTask("task-1", { status: "executing" })
    db.updateTask("task-2", { status: "executing" })
    db.updateTask("task-1", { status: "done" })

    expect(statusChanges.length).toBe(3)
    expect(statusChanges[0].taskId).toBe("task-1")
    expect(statusChanges[1].taskId).toBe("task-2")
    expect(statusChanges[2].taskId).toBe("task-1")

    db.close()
  })

  it("handles all status transition types", () => {
    const { db } = createTempDb()

    const statusChanges: Array<{ taskId: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []

    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      statusChanges.push({ taskId, oldStatus, newStatus })
    })

    const statuses: TaskStatus[] = ["template", "backlog", "executing", "review", "done", "failed", "stuck"]

    for (let i = 0; i < statuses.length; i++) {
      const taskId = `task-${i}`
      db.createTask({
        id: taskId,
        name: `Task ${i}`,
        prompt: `Prompt ${i}`,
        status: statuses[i],
      })

      // Change to next status (or back to backlog for the last one)
      const nextStatus = i < statuses.length - 1 ? statuses[i + 1] : "backlog"
      db.updateTask(taskId, { status: nextStatus })
    }

    expect(statusChanges.length).toBe(statuses.length)

    db.close()
  })
})

describe("Telegram Integration with Database", () => {
  it("sends notification when task status changes with valid config", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { message_id: 100 } }),
      } as Response)
    )
    global.fetch = mockFetch

    const { db } = createTempDb()

    // Configure Telegram
    db.updateOptions({
      telegramBotToken: "test-bot-token",
      telegramChatId: "123456789",
      telegramNotificationsEnabled: true,
    })

    // Set up listener similar to server.ts
    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus,
        (msg: string) => console.debug(msg)
      ).catch((err: unknown) => {
        console.error("[telegram] notification failed:", err)
      })
    })

    db.createTask({
      id: "task-1",
      name: "Integration Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // Trigger status change
    db.updateTask("task-1", { status: "executing" })

    // Wait for async notification
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).toHaveBeenCalled()
    const call = mockFetch.mock.calls[0]
    const options = call[1] as RequestInit
    const body = JSON.parse(options.body as string)

    expect(body.text).toContain("Integration Test Task")
    expect(body.text).toContain("backlog")
    expect(body.text).toContain("executing")

    db.close()
  })

  it("does not send notification when telegramNotificationsEnabled is false", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { message_id: 100 } }),
      } as Response)
    )
    global.fetch = mockFetch

    const { db } = createTempDb()

    // Configure Telegram but disable notifications
    db.updateOptions({
      telegramBotToken: "test-bot-token",
      telegramChatId: "123456789",
      telegramNotificationsEnabled: false,
    })

    // Set up listener
    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus
      ).catch(() => {})
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    db.updateTask("task-1", { status: "executing" })

    // Wait for any async operations
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).not.toHaveBeenCalled()

    db.close()
  })

  it("does not send notification when bot token is missing", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { message_id: 100 } }),
      } as Response)
    )
    global.fetch = mockFetch

    const { db } = createTempDb()

    // Configure without bot token
    db.updateOptions({
      telegramBotToken: "",
      telegramChatId: "123456789",
      telegramNotificationsEnabled: true,
    })

    // Set up listener
    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus
      ).catch(() => {})
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    db.updateTask("task-1", { status: "executing" })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).not.toHaveBeenCalled()

    db.close()
  })

  it("does not send notification when chat ID is missing", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { message_id: 100 } }),
      } as Response)
    )
    global.fetch = mockFetch

    const { db } = createTempDb()

    // Configure without chat ID
    db.updateOptions({
      telegramBotToken: "test-bot-token",
      telegramChatId: "",
      telegramNotificationsEnabled: true,
    })

    // Set up listener
    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus
      ).catch(() => {})
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    db.updateTask("task-1", { status: "executing" })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).not.toHaveBeenCalled()

    db.close()
  })

  it("handles notification errors gracefully without failing the workflow", async () => {
    const mockFetch = mock(() => Promise.reject(new Error("Network error")))
    global.fetch = mockFetch

    const { db } = createTempDb()

    db.updateOptions({
      telegramBotToken: "test-bot-token",
      telegramChatId: "123456789",
      telegramNotificationsEnabled: true,
    })

    // Set up listener with error handling
    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus
      ).catch((err: unknown) => {
        // Error should be caught and logged, not thrown
        console.error("[telegram] notification failed:", err)
      })
    })

    db.createTask({
      id: "task-1",
      name: "Test Task",
      prompt: "Test prompt",
      status: "backlog",
    })

    // This should not throw even though the notification will fail
    expect(() => db.updateTask("task-1", { status: "executing" })).not.toThrow()

    // Wait for async error handling
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Task should still be updated
    const task = db.getTask("task-1")
    expect(task?.status).toBe("executing")

    db.close()
  })

  it("sends notifications for task completion (done status)", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { message_id: 200 } }),
      } as Response)
    )
    global.fetch = mockFetch

    const { db } = createTempDb()

    db.updateOptions({
      telegramBotToken: "test-bot-token",
      telegramChatId: "123456789",
      telegramNotificationsEnabled: true,
    })

    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus
      ).catch(() => {})
    })

    db.createTask({
      id: "task-1",
      name: "Complete Me",
      prompt: "Test prompt",
      status: "executing",
    })

    db.updateTask("task-1", { status: "done" })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).toHaveBeenCalled()
    const call = mockFetch.mock.calls[0]
    const options = call[1] as RequestInit
    const body = JSON.parse(options.body as string)

    // Should use ✅ emoji for done status
    expect(body.text).toContain("✅")
    expect(body.text).toContain("executing")
    expect(body.text).toContain("done")

    db.close()
  })

  it("sends notifications for task failures", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { message_id: 300 } }),
      } as Response)
    )
    global.fetch = mockFetch

    const { db } = createTempDb()

    db.updateOptions({
      telegramBotToken: "test-bot-token",
      telegramChatId: "123456789",
      telegramNotificationsEnabled: true,
    })

    db.setTaskStatusChangeListener((taskId: string, oldStatus: string, newStatus: string) => {
      const task = db.getTask(taskId)
      if (!task) return
      const opts = db.getOptions()
      if (!opts.telegramNotificationsEnabled || !opts.telegramBotToken || !opts.telegramChatId) return

      sendTelegramNotification(
        { botToken: opts.telegramBotToken, chatId: opts.telegramChatId },
        task.name,
        oldStatus,
        newStatus
      ).catch(() => {})
    })

    db.createTask({
      id: "task-1",
      name: "Failing Task",
      prompt: "Test prompt",
      status: "executing",
    })

    db.updateTask("task-1", { status: "failed" })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mockFetch).toHaveBeenCalled()
    const call = mockFetch.mock.calls[0]
    const options = call[1] as RequestInit
    const body = JSON.parse(options.body as string)

    // Should use ❌ emoji for failed status
    expect(body.text).toContain("❌")
    expect(body.text).toContain("executing")
    expect(body.text).toContain("failed")

    db.close()
  })
})
