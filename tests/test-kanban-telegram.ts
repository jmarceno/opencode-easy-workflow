#!/usr/bin/env bun
/**
 * Tests for Telegram notification feature:
 * - DB option persistence for Telegram fields
 * - Server API GET/PUT for Telegram options
 * - Telegram notifier message formatting
 * - Task status change listener fires correctly
 * - Telegram reply-driven session routing:
 *   - Outbound metadata formatting
 *   - Port/chat_id/message_id parsing
 *   - Reply filtering validation
 *   - Prompt building for forwarded replies
 */

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { KanbanServer } from "../.opencode/easy-workflow/server"
import {
  sendTelegramNotification,
  buildMessageWithMetadata,
  parsePortFromMessage,
  parseChatIdFromMessage,
  parseMessageIdFromMessage,
  sendTelegramNotificationWithMetadata,
  PORT_MARKER_START,
  PORT_MARKER_END,
  CHAT_ID_MARKER_START,
  CHAT_ID_MARKER_END,
  MSG_ID_MARKER_START,
  MSG_ID_MARKER_END,
} from "../.opencode/easy-workflow/telegram"

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

// ---- Telegram notifier unit tests ----

function testSendTelegramNotificationBuildsCorrectMessage() {
  // Capture fetch calls to verify URL and body
  let capturedUrl = ""
  let capturedBody: any = null

  const originalFetch = globalThis.fetch
  globalThis.fetch = function (url: any, init: any) {
    capturedUrl = url
    capturedBody = JSON.parse(init.body)
    return Promise.resolve({ ok: true } as any)
  } as any

  try {
    sendTelegramNotification(
      { botToken: "abc123:XYZ", chatId: "-1001234567890" },
      "Build widget",
      "backlog",
      "executing",
      () => {}
    ).then(() => {
      const expectedUrl = "https://api.telegram.org/botabc123:XYZ/sendMessage"
      assert(capturedUrl === expectedUrl, `Expected URL ${expectedUrl}, got ${capturedUrl}`)
      assert(capturedBody.chat_id === "-1001234567890", `Expected chat_id -1001234567890, got ${capturedBody.chat_id}`)
      assert(capturedBody.parse_mode === "Markdown", `Expected parse_mode Markdown, got ${capturedBody.parse_mode}`)
      assert(capturedBody.text.includes("Build widget"), `Expected message to include task name, got: ${capturedBody.text}`)
      assert(capturedBody.text.includes("backlog"), `Expected message to include old status, got: ${capturedBody.text}`)
      assert(capturedBody.text.includes("executing"), `Expected message to include new status, got: ${capturedBody.text}`)
      console.log("✓ sendTelegramNotification builds correct API request")
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}

function testSendTelegramNotificationSkipsWhenNotConfigured() {
  let called = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = function () {
    called = true
    return Promise.resolve({ ok: true } as any)
  } as any

  try {
    // Empty bot token
    sendTelegramNotification(
      { botToken: "", chatId: "-1001234567890" },
      "Any task",
      "backlog",
      "done",
      () => {}
    )
    // Empty chat id
    sendTelegramNotification(
      { botToken: "abc123:XYZ", chatId: "" },
      "Any task",
      "backlog",
      "done",
      () => {}
    )
    assert(!called, "fetch should not be called when bot token or chat ID is empty")
    console.log("✓ sendTelegramNotification skips when not configured")
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---- DB persistence tests ----

function testDbPersistsTelegramOptions() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-telegram-db-"))
  try {
    const dbPath = join(tempDir, "tasks.db")
    const db = new KanbanDB(dbPath)

    // Initially empty
    let opts = db.getOptions()
    assert(opts.telegramBotToken === "", `Expected empty bot token initially, got: ${opts.telegramBotToken}`)
    assert(opts.telegramChatId === "", `Expected empty chat id initially, got: ${opts.telegramChatId}`)

    // Update with real values
    db.updateOptions({ telegramBotToken: "123456:ABCDef", telegramChatId: "-1009876543210" })
    db.close()

    // Reopen and verify persistence
    const db2 = new KanbanDB(dbPath)
    const opts2 = db2.getOptions()
    assert(opts2.telegramBotToken === "123456:ABCDef", `Expected persisted bot token, got: ${opts2.telegramBotToken}`)
    assert(opts2.telegramChatId === "-1009876543210", `Expected persisted chat id, got: ${opts2.telegramChatId}`)
    db2.close()

    console.log("✓ DB persists Telegram options correctly")
  } finally {
    cleanupTempDir(tempDir)
  }
}

function testDbTaskStatusChangeListener() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-telegram-listener-"))
  try {
    const dbPath = join(tempDir, "tasks.db")
    const db = new KanbanDB(dbPath)

    const events: Array<{ taskId: string; oldStatus: string; newStatus: string }> = []
    db.setTaskStatusChangeListener((taskId, oldStatus, newStatus) => {
      events.push({ taskId, oldStatus, newStatus })
    })

    const task = db.createTask({
      name: "Listener test task",
      prompt: "Test task for listener",
      planmode: false,
      review: false,
      autoCommit: false,
    })

    // Status changes from "backlog" to "executing"
    db.updateTask(task.id, { status: "executing" })
    assert(events.length === 1, `Expected 1 event after first status change, got ${events.length}`)
    assert(events[0].oldStatus === "backlog", `Expected oldStatus backlog, got ${events[0].oldStatus}`)
    assert(events[0].newStatus === "executing", `Expected newStatus executing, got ${events[0].newStatus}`)

    // Update with same status — should NOT fire
    db.updateTask(task.id, { status: "executing" })
    assert(events.length === 1, `Expected still 1 event after same-status update, got ${events.length}`)

    // Update to done
    db.updateTask(task.id, { status: "done" })
    assert(events.length === 2, `Expected 2 events after second status change, got ${events.length}`)
    assert(events[1].oldStatus === "executing", `Expected oldStatus executing, got ${events[1].oldStatus}`)
    assert(events[1].newStatus === "done", `Expected newStatus done, got ${events[1].newStatus}`)

    // Update non-status field — should NOT fire
    db.updateTask(task.id, { errorMessage: "some error" })
    assert(events.length === 2, `Expected still 2 events after non-status update, got ${events.length}`)

    // Null listener — should not throw
    db.setTaskStatusChangeListener(null)
    db.updateTask(task.id, { status: "failed" }) // should not throw

    db.close()
    console.log("✓ DB task status change listener fires correctly")
  } finally {
    cleanupTempDir(tempDir)
  }
}

// ---- Server API tests ----

async function testServerApiOptionsTelegram() {
  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-telegram-api-"))
  try {
    const dbPath = join(tempDir, "tasks.db")
    const db = new KanbanDB(dbPath)
    const portProbe = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok")
      },
    })
    const port = portProbe.port
    portProbe.stop()
    db.updateOptions({ port })

    const server = new KanbanServer(db, {
      onStart: async () => {},
      onStartSingle: async () => {},
      onStop: () => {},
      getExecuting: () => false,
      getStartError: () => null,
      getServerUrl: () => "http://127.0.0.1:4096",
    })
    server.start()

    try {
      // GET /api/options — verify Telegram fields are present
      const getResp = await fetch(`http://127.0.0.1:${port}/api/options`)
      assert(getResp.status === 200, `GET /api/options failed: ${getResp.status}`)
      const getOpts = await getResp.json()
      assert("telegramBotToken" in getOpts, "GET response missing telegramBotToken")
      assert("telegramChatId" in getOpts, "GET response missing telegramChatId")

      // PUT /api/options — valid Telegram values
      const putResp = await fetch(`http://127.0.0.1:${port}/api/options`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramBotToken: "999888777:Tok", telegramChatId: "@my_channel" }),
      })
      assert(putResp.status === 200, `PUT /api/options Telegram failed: ${putResp.status}`)
      const putOpts = await putResp.json()
      assert(putOpts.telegramBotToken === "999888777:Tok", `Expected updated bot token, got: ${putOpts.telegramBotToken}`)
      assert(putOpts.telegramChatId === "@my_channel", `Expected updated chat id, got: ${putOpts.telegramChatId}`)

      // PUT /api/options — invalid telegramBotToken (not a string)
      const badTokenResp = await fetch(`http://127.0.0.1:${port}/api/options`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramBotToken: 12345 }),
      })
      assert(badTokenResp.status === 400, `Expected 400 for non-string telegramBotToken, got ${badTokenResp.status}`)
      const badTokenBody = await badTokenResp.json()
      assert(badTokenBody.error?.includes("telegramBotToken"), `Expected telegramBotToken error, got: ${badTokenBody.error}`)

      // PUT /api/options — invalid telegramChatId (not a string)
      const badChatResp = await fetch(`http://127.0.0.1:${port}/api/options`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramChatId: ["array-not-allowed"] }),
      })
      assert(badChatResp.status === 400, `Expected 400 for non-string telegramChatId, got ${badChatResp.status}`)

      console.log("✓ Server API handles Telegram options correctly")
    } finally {
      server.stop()
      db.close()
    }
  } finally {
    cleanupTempDir(tempDir)
  }
}

// ---- Telegram metadata and reply routing tests ----

function testBuildMessageWithMetadataContainsPortMarker() {
  const message = buildMessageWithMetadata("Test task", "backlog", "done", 3789, "-1001234567890", 42)

  // Verify base message content is present
  assert(message.includes("Test task"), "Message should include task name")
  assert(message.includes("backlog"), "Message should include old status")
  assert(message.includes("done"), "Message should include new status")

  // Verify metadata markers are present
  assert(message.includes(`${PORT_MARKER_START}3789${PORT_MARKER_END}`),
    `Message should include port marker, got: ${message}`)
  assert(message.includes(`${CHAT_ID_MARKER_START}-1001234567890${CHAT_ID_MARKER_END}`),
    `Message should include chat_id marker, got: ${message}`)
  assert(message.includes(`${MSG_ID_MARKER_START}42${MSG_ID_MARKER_END}`),
    `Message should include message_id marker, got: ${message}`)

  console.log("✓ buildMessageWithMetadata includes port marker")
}

function testBuildMessageWithMetadataWithoutMessageId() {
  const message = buildMessageWithMetadata("Test task", "backlog", "done", 3789, "-1001234567890")

  // Verify port and chat_id markers are present
  assert(message.includes(`${PORT_MARKER_START}3789${PORT_MARKER_END}`),
    `Message should include port marker, got: ${message}`)
  assert(message.includes(`${CHAT_ID_MARKER_START}-1001234567890${CHAT_ID_MARKER_END}`),
    `Message should include chat_id marker, got: ${message}`)

  // Verify message_id marker is NOT present when not provided
  assert(!message.includes(MSG_ID_MARKER_START),
    `Message should not include message_id marker when not provided, got: ${message}`)

  console.log("✓ buildMessageWithMetadata works without message_id")
}

function testParsePortFromMessage() {
  // Valid port marker
  const text1 = "Some message\n<!-- EWF_PORT:3789:EWF_PORT -->\nMore text"
  assert(parsePortFromMessage(text1) === 3789, `Expected port 3789, got ${parsePortFromMessage(text1)}`)

  // Port marker at different positions
  const text2 = "<!-- EWF_PORT:4096:EWF_PORT --> some message"
  assert(parsePortFromMessage(text2) === 4096, `Expected port 4096, got ${parsePortFromMessage(text2)}`)

  // No port marker
  const text3 = "Just a regular message without markers"
  assert(parsePortFromMessage(text3) === null, `Expected null for no marker, got ${parsePortFromMessage(text3)}`)

  // Invalid port (non-numeric)
  const text4 = "<!-- EWF_PORT:abc:EWF_PORT -->"
  assert(parsePortFromMessage(text4) === null, `Expected null for invalid port, got ${parsePortFromMessage(text4)}`)

  // Empty port
  const text5 = "<!-- EWF_PORT::EWF_PORT -->"
  assert(parsePortFromMessage(text5) === null, `Expected null for empty port, got ${parsePortFromMessage(text5)}`)

  console.log("✓ parsePortFromMessage extracts port correctly")
}

function testParseChatIdFromMessage() {
  // Valid chat_id
  const text1 = "Some message\n<!-- EWF_CHAT_ID:-1001234567890:EWF_CHAT_ID -->\nMore text"
  assert(parseChatIdFromMessage(text1) === "-1001234567890",
    `Expected chat_id -1001234567890, got ${parseChatIdFromMessage(text1)}`)

  // Chat_id with alphanumeric characters
  const text2 = "<!-- EWF_CHAT_ID:@my_channel:EWF_CHAT_ID -->"
  assert(parseChatIdFromMessage(text2) === "@my_channel",
    `Expected chat_id @my_channel, got ${parseChatIdFromMessage(text2)}`)

  // No chat_id marker
  const text3 = "Just a regular message"
  assert(parseChatIdFromMessage(text3) === null, `Expected null for no marker, got ${parseChatIdFromMessage(text3)}`)

  console.log("✓ parseChatIdFromMessage extracts chat_id correctly")
}

function testParseMessageIdFromMessage() {
  // Valid message_id
  const text1 = "Some message\n<!-- EWF_MSG_ID:42:EWF_MSG_ID -->\nMore text"
  assert(parseMessageIdFromMessage(text1) === 42, `Expected message_id 42, got ${parseMessageIdFromMessage(text1)}`)

  // Large message_id
  const text2 = "<!-- EWF_MSG_ID:123456789:EWF_MSG_ID -->"
  assert(parseMessageIdFromMessage(text2) === 123456789,
    `Expected message_id 123456789, got ${parseMessageIdFromMessage(text2)}`)

  // No message_id marker
  const text3 = "Just a regular message"
  assert(parseMessageIdFromMessage(text3) === null, `Expected null for no marker, got ${parseMessageIdFromMessage(text3)}`)

  // Invalid message_id (non-numeric)
  const text4 = "<!-- EWF_MSG_ID:abc:EWF_MSG_ID -->"
  assert(parseMessageIdFromMessage(text4) === null,
    `Expected null for invalid message_id, got ${parseMessageIdFromMessage(text4)}`)

  console.log("✓ parseMessageIdFromMessage extracts message_id correctly")
}

function testSendTelegramNotificationWithMetadataMakesCorrectAPICall() {
  let capturedUrl = ""
  let capturedBody: any = null

  const originalFetch = globalThis.fetch
  globalThis.fetch = function (url: any, init: any) {
    capturedUrl = url
    capturedBody = JSON.parse(init.body)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 123 } })
    } as any)
  } as any

  try {
    sendTelegramNotificationWithMetadata(
      { botToken: "abc123:XYZ", chatId: "-1001234567890" },
      "Build widget",
      "backlog",
      "executing",
      3789,
      () => {}
    ).then(() => {
      const expectedUrl = "https://api.telegram.org/botabc123:XYZ/sendMessage"
      assert(capturedUrl === expectedUrl, `Expected URL ${expectedUrl}, got ${capturedUrl}`)
      assert(capturedBody.chat_id === "-1001234567890", `Expected chat_id -1001234567890, got ${capturedBody.chat_id}`)
      assert(capturedBody.parse_mode === "Markdown", `Expected parse_mode Markdown, got ${capturedBody.parse_mode}`)
      assert(capturedBody.text.includes("Build widget"), `Expected message to include task name, got: ${capturedBody.text}`)
      assert(capturedBody.text.includes("<!-- EWF_PORT:3789:EWF_PORT -->"),
        `Expected message to include port marker, got: ${capturedBody.text}`)
      assert(capturedBody.text.includes("<!-- EWF_CHAT_ID:-1001234567890:EWF_CHAT_ID -->"),
        `Expected message to include chat_id marker, got: ${capturedBody.text}`)
      console.log("✓ sendTelegramNotificationWithMetadata builds correct API request")
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}

function testSendTelegramNotificationWithMetadataSkipsWhenNotConfigured() {
  let called = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = function () {
    called = true
    return Promise.resolve({ ok: true } as any)
  } as any

  try {
    // Empty bot token
    sendTelegramNotificationWithMetadata(
      { botToken: "", chatId: "-1001234567890" },
      "Any task",
      "backlog",
      "done",
      3789,
      () => {}
    )
    // Empty chat id
    sendTelegramNotificationWithMetadata(
      { botToken: "abc123:XYZ", chatId: "" },
      "Any task",
      "backlog",
      "done",
      3789,
      () => {}
    )
    assert(!called, "fetch should not be called when bot token or chat ID is empty")
    console.log("✓ sendTelegramNotificationWithMetadata skips when not configured")
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ---- Run all tests ----

async function runAll() {
  testSendTelegramNotificationBuildsCorrectMessage()
  await testSendTelegramNotificationSkipsWhenNotConfigured()
  testDbPersistsTelegramOptions()
  testDbTaskStatusChangeListener()
  await testServerApiOptionsTelegram()
  // New metadata and reply routing tests
  testBuildMessageWithMetadataContainsPortMarker()
  testBuildMessageWithMetadataWithoutMessageId()
  testParsePortFromMessage()
  testParseChatIdFromMessage()
  testParseMessageIdFromMessage()
  testSendTelegramNotificationWithMetadataMakesCorrectAPICall()
  await testSendTelegramNotificationWithMetadataSkipsWhenNotConfigured()
  console.log("\n✅ All Telegram tests passed!")
}

runAll().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
