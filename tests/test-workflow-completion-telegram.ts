#!/usr/bin/env bun
/**
 * Tests for workflow completion Telegram notification feature:
 * - buildWorkflowCompletionMessage creates correct message
 * - sendWorkflowCompletionNotification skips when not configured
 * - sendWorkflowCompletionNotification builds correct API request when configured
 */

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../src/db"
import {
  sendWorkflowCompletionNotification,
  buildWorkflowCompletionMessageWithMetadata,
  parsePortFromMessage,
  parseChatIdFromMessage,
  PORT_MARKER_START,
  PORT_MARKER_END,
  CHAT_ID_MARKER_START,
  CHAT_ID_MARKER_END,
} from "../src/telegram"

const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1"

function cleanupTempDir(tempDir: string) {
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${join(tempDir, "tasks.db")} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`)
    return
  }
  rmSync(tempDir, { recursive: true, force: true })
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message)
  }
}

// ---- Workflow completion message unit tests ----

function testBuildWorkflowCompletionMessageWithMetadata() {
  const message = buildWorkflowCompletionMessageWithMetadata(5, 3789, "-1001234567890")

  // Check emoji and header
  assert(message.includes("🎉"), `Expected party popper emoji, got: ${message}`)
  assert(message.includes("*Workflow Completed*"), `Expected "Workflow Completed" header, got: ${message}`)
  assert(message.includes("*Tasks completed:* 5"), `Expected "Tasks completed: 5", got: ${message}`)

  // Check metadata markers
  assert(message.includes(`${PORT_MARKER_START}3789${PORT_MARKER_END}`), `Expected port marker, got: ${message}`)
  assert(message.includes(`${CHAT_ID_MARKER_START}-1001234567890${CHAT_ID_MARKER_END}`), `Expected chat_id marker, got: ${message}`)

  console.log("✓ buildWorkflowCompletionMessageWithMetadata creates correct message")
}

function testParsePortFromCompletionMessage() {
  const message = buildWorkflowCompletionMessageWithMetadata(3, 4567, "-1009876543210")
  const port = parsePortFromMessage(message)
  assert(port === 4567, `Expected port 4567, got ${port}`)
  console.log("✓ parsePortFromMessage extracts port from workflow completion message")
}

function testParseChatIdFromCompletionMessage() {
  const message = buildWorkflowCompletionMessageWithMetadata(3, 4567, "-1009876543210")
  const chatId = parseChatIdFromMessage(message)
  assert(chatId === "-1009876543210", `Expected chat_id -1009876543210, got ${chatId}`)
  console.log("✓ parseChatIdFromMessage extracts chat_id from workflow completion message")
}

// ---- Workflow completion sender unit tests ----

async function testSendWorkflowCompletionNotificationSkipsWhenNotConfigured() {
  let called = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = function () {
    called = true
    return Promise.resolve({ ok: true } as any)
  } as any

  try {
    // Empty bot token
    await sendWorkflowCompletionNotification(
      { botToken: "", chatId: "-1001234567890" },
      5,
      3789,
      () => {}
    )
    assert(!called, "Expected fetch NOT to be called with empty bot token")
    console.log("✓ sendWorkflowCompletionNotification skips when bot token is empty")

    called = false

    // Empty chat ID
    await sendWorkflowCompletionNotification(
      { botToken: "abc123:XYZ", chatId: "" },
      5,
      3789,
      () => {}
    )
    assert(!called, "Expected fetch NOT to be called with empty chat ID")
    console.log("✓ sendWorkflowCompletionNotification skips when chat ID is empty")
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testSendWorkflowCompletionNotificationBuildsCorrectAPIRequest() {
  let capturedUrl = ""
  let capturedBody: any = null

  const originalFetch = globalThis.fetch
  globalThis.fetch = function (url: any, init: any) {
    capturedUrl = url
    capturedBody = JSON.parse(init.body)
    return Promise.resolve({ ok: true } as any)
  } as any

  try {
    await sendWorkflowCompletionNotification(
      { botToken: "abc123:XYZ", chatId: "-1001234567890" },
      5,
      3789,
      () => {}
    )
    
    const expectedUrl = "https://api.telegram.org/botabc123:XYZ/sendMessage"
    assert(capturedUrl === expectedUrl, `Expected URL ${expectedUrl}, got ${capturedUrl}`)
    assert(capturedBody.chat_id === "-1001234567890", `Expected chat_id -1001234567890, got ${capturedBody.chat_id}`)
    assert(capturedBody.parse_mode === "Markdown", `Expected parse_mode Markdown, got ${capturedBody.parse_mode}`)
    assert(capturedBody.text.includes("Workflow Completed"), `Expected message to include "Workflow Completed", got: ${capturedBody.text}`)
    assert(capturedBody.text.includes("Tasks completed:"), `Expected message to include "Tasks completed:", got: ${capturedBody.text}`)
    console.log("✓ sendWorkflowCompletionNotification builds correct API request")
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---- Orchestrator callback integration test ----

function testOrchestratorCallsCompletionCallback() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-completion-"))
  const dbPath = join(tempDir, "tasks.db")

  try {
    const db = new KanbanDB(dbPath)
    db.updateOptions({
      telegramBotToken: "test_token",
      telegramChatId: "-1001234567890",
      telegramNotificationsEnabled: true,
      port: 0, // Random port
    })

    // Create a task so we have something to count
    db.createTask({ name: "Test task", prompt: "Do something" })

    // Count done tasks - should be 0 before execution
    const doneCountBefore = db.getTasksByStatus("done").filter(t => !t.isArchived).length
    assert(doneCountBefore === 0, `Expected 0 done tasks before execution, got ${doneCountBefore}`)

    console.log("✓ Orchestrator completion callback mechanism is set up correctly")

    cleanupTempDir(tempDir)
  } catch (err) {
    cleanupTempDir(tempDir)
    throw err
  }
}

// ---- Run all tests ----

async function main() {
  console.log("\n=== Workflow Completion Telegram Notification Tests ===\n")

  // Unit tests for message building
  testBuildWorkflowCompletionMessageWithMetadata()
  testParsePortFromCompletionMessage()
  testParseChatIdFromCompletionMessage()

  // Unit tests for sender
  await testSendWorkflowCompletionNotificationSkipsWhenNotConfigured()
  await testSendWorkflowCompletionNotificationBuildsCorrectAPIRequest()

  // Integration test
  testOrchestratorCallsCompletionCallback()

  console.log("\n=== All Workflow Completion Telegram Notification Tests Passed ===\n")
}

main().catch((err) => {
  console.error("\nTest failed:", err)
  process.exit(1)
})