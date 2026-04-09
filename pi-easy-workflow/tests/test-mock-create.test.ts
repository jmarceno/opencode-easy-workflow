import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Mock Creation Test", () => {
  it("should create a working mock", async () => {
    const root = mkdtempSync(join(tmpdir(), "test-"))
    
    // Copy the exact mock from gap2 test
    const filePath = join(root, "mock-pi.js")
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
  const params = request?.params || {}

  if (type === "initialize") {
    console.log(JSON.stringify({ id, type: "response", command: "initialize", success: true, data: { sessionId: "pi-session-" + id, sessionFile: "/tmp/mock-session" } }))
    return
  }

  if (type === "set_model") {
    console.log(JSON.stringify({ id, type: "response", command: "set_model", success: true }))
    return
  }

  if (type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: "set_thinking_level", success: true }))
    return
  }

  if (type === "prompt") {
    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true }))
    const messageId = "msg-" + Date.now()
    console.log(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_complete",
        text: "Mock response from Pi",
        messageId: messageId
      }
    }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  if (type === "get_messages") {
    console.log(JSON.stringify({ id, type: "response", command: "get_messages", success: true, data: { messages: [{ text: "snapshot" }] } }))
    return
  }

  console.log(JSON.stringify({ id, type: "response", command: type || "unknown", success: true }))
})
`
    writeFileSync(filePath, mockScript, "utf-8")
    chmodSync(filePath, 0o755)
    
    // Read it back and verify
    const content = readFileSync(filePath, "utf-8")
    console.log("Mock file created, length:", content.length)
    
    // Test it by spawning
    const proc = Bun.spawn({
      cmd: ["bun", filePath],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    
    // Send a test request
    proc.stdin.write('{"id":"req_1","type":"initialize"}\n')
    
    // Read response
    const reader = proc.stdout.getReader()
    const result = await reader.read()
    const response = new TextDecoder().decode(result.value)
    console.log("Response:", response)
    
    proc.kill()
    
    const parsed = JSON.parse(response.trim())
    expect(parsed.type).toBe("response")
    expect(parsed.success).toBe(true)
    expect(parsed.command).toBe("initialize")
    
    rmSync(root, { recursive: true, force: true })
  })
})
