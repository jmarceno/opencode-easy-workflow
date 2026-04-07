/**
 * Integration tests for session message logging
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { KanbanDB } from "../src/db"
import { createMessageLogger } from "../src/message-logger"
import type { CreateSessionMessageInput } from "../src/types"

describe("Session Message Logging", () => {
  let tempDir: string
  let db: KanbanDB

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "message-log-test-"))
    const dbPath = join(tempDir, "test.db")
    db = new KanbanDB(dbPath)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("Database Operations", () => {
    it("should create a session message", () => {
      const input: CreateSessionMessageInput = {
        sessionId: "test-session-123",
        role: "user",
        messageType: "text",
        contentJson: { text: "Hello, world!" },
      }

      const message = db.createSessionMessage(input)

      expect(message.id).toBeGreaterThan(0)
      expect(message.sessionId).toBe("test-session-123")
      expect(message.role).toBe("user")
      expect(message.contentJson.text).toBe("Hello, world!")
      expect(message.timestamp).toBeGreaterThan(0)
    })

    it("should retrieve messages by session ID", () => {
      const sessionId = "test-session-456"
      
      db.createSessionMessage({
        sessionId,
        role: "user",
        messageType: "text",
        contentJson: { text: "First message" },
      })

      db.createSessionMessage({
        sessionId,
        role: "assistant",
        messageType: "text",
        contentJson: { text: "Second message" },
      })

      const messages = db.getSessionMessages(sessionId)

      expect(messages.length).toBe(2)
      expect(messages[0].role).toBe("user")
      expect(messages[1].role).toBe("assistant")
    })

    it("should retrieve timeline in chronological order", () => {
      const sessionId = "test-session-789"
      
      db.createSessionMessage({
        sessionId,
        role: "user",
        messageType: "text",
        contentJson: { text: "Message 1" },
        timestamp: 1000,
      })

      db.createSessionMessage({
        sessionId,
        role: "assistant",
        messageType: "text",
        contentJson: { text: "Message 2" },
        timestamp: 2000,
      })

      db.createSessionMessage({
        sessionId,
        role: "user",
        messageType: "text",
        contentJson: { text: "Message 3" },
        timestamp: 1500, // Out of order insert
      })

      const timeline = db.getSessionTimeline(sessionId)

      expect(timeline.length).toBe(3)
      expect(timeline[0].timestamp).toBe(1000)
      expect(timeline[1].timestamp).toBe(1500)
      expect(timeline[2].timestamp).toBe(2000)
    })

    it("should store tool execution with diff", () => {
      const input: CreateSessionMessageInput = {
        sessionId: "test-session-tool",
        role: "tool",
        messageType: "tool_result",
        contentJson: { tool: "file.write", result: "success" },
        toolName: "file.write",
        toolArgsJson: { filePath: "/test/file.txt", content: "new content" },
        toolStatus: "success",
        editFilePath: "/test/file.txt",
        editDiff: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new",
      }

      const message = db.createSessionMessage(input)

      expect(message.toolName).toBe("file.write")
      expect(message.editFilePath).toBe("/test/file.txt")
      expect(message.editDiff).toContain("--- a/file.txt")
    })

    it("should store model and token information", () => {
      const input: CreateSessionMessageInput = {
        sessionId: "test-session-model",
        role: "assistant",
        messageType: "text",
        contentJson: { text: "AI response" },
        modelProvider: "anthropic",
        modelId: "claude-3-5-sonnet",
        agentName: "build",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      }

      const message = db.createSessionMessage(input)

      expect(message.modelProvider).toBe("anthropic")
      expect(message.modelId).toBe("claude-3-5-sonnet")
      expect(message.agentName).toBe("build")
      expect(message.promptTokens).toBe(100)
      expect(message.completionTokens).toBe(50)
      expect(message.totalTokens).toBe(150)
    })

    it("should link messages to tasks and task runs", () => {
      const input: CreateSessionMessageInput = {
        sessionId: "test-session-links",
        taskId: "task-123",
        taskRunId: "run-456",
        role: "assistant",
        messageType: "text",
        contentJson: { text: "Task execution" },
        workflowPhase: "execution",
      }

      const message = db.createSessionMessage(input)

      expect(message.taskId).toBe("task-123")
      expect(message.taskRunId).toBe("run-456")
      expect(message.workflowPhase).toBe("execution")
    })

    it("should delete session messages", () => {
      const sessionId = "test-session-delete"
      
      db.createSessionMessage({
        sessionId,
        role: "user",
        messageType: "text",
        contentJson: { text: "Message" },
      })

      const deletedCount = db.deleteSessionMessages(sessionId)
      const remaining = db.getSessionMessages(sessionId)

      expect(deletedCount).toBe(1)
      expect(remaining.length).toBe(0)
    })

    it("should cleanup old messages", () => {
      const sessionId = "test-session-cleanup"
      const oldTimestamp = Date.now() - (40 * 24 * 60 * 60 * 1000) // 40 days ago
      
      db.createSessionMessage({
        sessionId,
        role: "user",
        messageType: "text",
        contentJson: { text: "Old message" },
        timestamp: oldTimestamp,
      })

      db.createSessionMessage({
        sessionId,
        role: "user",
        messageType: "text",
        contentJson: { text: "Recent message" },
        timestamp: Date.now(),
      })

      const cleanedCount = db.cleanupOldSessionMessages(30) // 30 days retention
      const remaining = db.getSessionMessages(sessionId)

      expect(cleanedCount).toBe(1)
      expect(remaining.length).toBe(1)
      expect(remaining[0].contentJson.text).toBe("Recent message")
    })
  })

  describe("Message Logger Service", () => {
    it("should create a message logger with context", () => {
      const logger = createMessageLogger({
        db,
        taskId: "task-123",
        taskRunId: "run-456",
        workflowPhase: "execution",
      })

      expect(logger).toBeDefined()
    })

    it("should update logger context", () => {
      const logger = createMessageLogger({
        db,
        taskId: "task-123",
      })

      logger.setContext({
        workflowPhase: "review",
        sessionStatus: "active",
      })

      // Context is internal, but we can verify by logging a message
      // and checking the stored workflow_phase
    })

    it("should log message.updated events", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-123",
      })

      await logger.logMessageUpdated({
        sessionId: "session-123",
        properties: {
          id: "msg-1",
          role: "user",
        },
        parts: [{ type: "text", text: "Test message" }],
      })

      const messages = db.getSessionMessages("session-123")
      expect(messages.length).toBe(1)
      expect(messages[0].role).toBe("user")
      expect(messages[0].contentJson.text).toBe("Test message")
    })

    it("should log tool.execute.after events", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-456",
      })

      await logger.logToolExecuteAfter(
        {
          tool: "file.write",
          args: { filePath: "/test.txt", content: "hello" },
        },
        {
          tool: "file.write",
          result: { success: true },
          status: "success",
        }
      )

      const messages = db.getSessionMessages("session-456")
      expect(messages.length).toBe(1)
      expect(messages[0].toolName).toBe("file.write")
      expect(messages[0].toolStatus).toBe("success")
    })

    it("should log session.updated events", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-789",
      })

      await logger.logSessionUpdated({
        properties: {
          id: "session-789",
          status: "active",
          title: "Test Session",
        },
      })

      const messages = db.getSessionMessages("session-789")
      expect(messages.length).toBe(1)
      expect(messages[0].role).toBe("system")
      expect(messages[0].messageType).toBe("session_start")
    })

    it("should log session.idle events", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-abc",
      })

      await logger.logSessionIdle({
        properties: {
          id: "session-abc",
          reason: "completed",
        },
      })

      const messages = db.getSessionMessages("session-abc")
      expect(messages.length).toBe(1)
      expect(messages[0].role).toBe("system")
      expect(messages[0].messageType).toBe("session_end")
    })

    it("should handle errors gracefully without throwing", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-error",
      })

      // Should not throw even with invalid input
      await logger.logMessageUpdated(null)
      await logger.logMessageUpdated({})
      await logger.logToolExecuteAfter(null, null)

      // No assertions - test passes if no exception is thrown
    })

    it("should extract model information from events", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-model",
      })

      await logger.logMessageUpdated({
        sessionId: "session-model",
        properties: {
          model: "anthropic/claude-3-5-sonnet",
        },
        parts: [{ type: "text", text: "Hello" }],
      })

      const messages = db.getSessionMessages("session-model")
      expect(messages.length).toBe(1)
      expect(messages[0].modelProvider).toBe("anthropic")
      expect(messages[0].modelId).toBe("claude-3-5-sonnet")
    })

    it("should extract token usage from events", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-tokens",
      })

      await logger.logMessageUpdated({
        sessionId: "session-tokens",
        properties: {
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        },
        parts: [{ type: "text", text: "Hello" }],
      })

      const messages = db.getSessionMessages("session-tokens")
      expect(messages.length).toBe(1)
      expect(messages[0].promptTokens).toBe(100)
      expect(messages[0].completionTokens).toBe(50)
      expect(messages[0].totalTokens).toBe(150)
    })

    it("should generate diffs for file write operations", async () => {
      const logger = createMessageLogger({
        db,
        sessionId: "session-diff",
      })

      await logger.logToolExecuteAfter(
        {
          tool: "file.write",
          args: { filePath: "/test.txt", content: "new line 1\nnew line 2" },
        },
        {
          tool: "file.write",
          result: { success: true, originalContent: "old line 1\nold line 2" },
          status: "success",
        }
      )

      const messages = db.getSessionMessages("session-diff")
      expect(messages.length).toBe(1)
      expect(messages[0].editDiff).toContain("--- a//test.txt")
      expect(messages[0].editDiff).toContain("old line 1")
      expect(messages[0].editDiff).toContain("new line 1")
    })
  })

  describe("Integration Flow", () => {
    it("should handle a complete conversation flow", async () => {
      const sessionId = "full-session"
      const logger = createMessageLogger({
        db,
        sessionId,
        taskId: "task-123",
        workflowPhase: "execution",
      })

      // Session started
      await logger.logSessionUpdated({
        properties: { id: sessionId, status: "active", title: "Test Task" },
      })

      // User message
      await logger.logMessageUpdated({
        sessionId,
        properties: { role: "user" },
        parts: [{ type: "text", text: "Please write a hello world program" }],
      })

      // Assistant with tool call
      await logger.logMessageUpdated({
        sessionId,
        properties: { 
          role: "assistant",
          model: "anthropic/claude-3-5-sonnet",
        },
        parts: [
          { type: "text", text: "I'll create that file for you" },
          { type: "tool", tool: "file.write", args: { filePath: "hello.js" } },
        ],
      })

      // Tool execution
      await logger.logToolExecuteAfter(
        { tool: "file.write", args: { filePath: "hello.js", content: "console.log('Hello')" } },
        { 
          tool: "file.write", 
          result: { success: true, originalContent: "" },
          status: "success",
        }
      )

      // Assistant response
      await logger.logMessageUpdated({
        sessionId,
        properties: { role: "assistant" },
        parts: [{ type: "text", text: "Done! I've created the file." }],
      })

      // Session ended
      await logger.logSessionIdle({
        properties: { id: sessionId, reason: "completed" },
      })

      // Verify timeline
      const timeline = db.getSessionTimeline(sessionId)
      expect(timeline.length).toBe(6)
      
      // Verify order
      expect(timeline[0].messageType).toBe("session_start")
      expect(timeline[1].role).toBe("user")
      expect(timeline[2].role).toBe("assistant")
      expect(timeline[3].role).toBe("tool")
      expect(timeline[4].role).toBe("assistant")
      expect(timeline[5].messageType).toBe("session_end")

      // Verify metadata
      expect(timeline[0].workflowPhase).toBe("execution")
      expect(timeline[0].taskId).toBe("task-123")
    })
  })
})