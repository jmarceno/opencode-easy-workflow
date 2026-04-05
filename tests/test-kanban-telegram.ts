#!/usr/bin/env bun
/**
 * Tests for Telegram notification feature:
 * - DB option persistence for Telegram fields
 * - Server API GET/PUT for Telegram options
 * - Telegram notifier message formatting
 * - Task status change listener fires correctly
 */

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { KanbanDB } from "../.opencode/easy-workflow/db"
import { KanbanServer } from "../.opencode/easy-workflow/server"
import { sendTelegramNotification } from "../.opencode/easy-workflow/telegram"

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

// ---- Run all tests ----

async function runAll() {
  testSendTelegramNotificationBuildsCorrectMessage()
  await testSendTelegramNotificationSkipsWhenNotConfigured()
  testDbPersistsTelegramOptions()
  testDbTaskStatusChangeListener()
  await testServerApiOptionsTelegram()
  console.log("\n✅ All Telegram tests passed!")
}

runAll().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
