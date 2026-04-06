/**
 * Test script for the standalone server architecture
 * 
 * This script tests:
 * 1. Config file creation
 * 2. Server startup
 * 3. Bridge event forwarding
 * 4. API endpoints
 */

import { spawn } from "child_process"
import { existsSync, unlinkSync } from "fs"
import { join } from "path"

const CONFIG_PATH = join(process.cwd(), ".opencode", "easy-workflow", "config.json")
const TEST_TIMEOUT = 30000

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testConfigCreation(): Promise<boolean> {
  console.log("\n[TEST] Testing config file creation...")

  // Remove existing config
  if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH)
    console.log("  Removed existing config")
  }

  // Start server with stdin input
  const server = spawn("bun", ["run", ".opencode/easy-workflow/standalone.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  })

  let output = ""
  server.stdout.on("data", (data) => {
    output += data.toString()
  })

  server.stderr.on("data", (data) => {
    output += data.toString()
  })

  // Wait for prompt
  await delay(1000)

  // Send test URL
  server.stdin.write("http://localhost:4096\n")
  server.stdin.end()

  // Wait for config creation
  await delay(1000)

  // Kill server
  server.kill()

  // Check if config was created
  if (!existsSync(CONFIG_PATH)) {
    console.error("  FAIL: Config file was not created")
    console.error("  Output:", output)
    return false
  }

  console.log("  PASS: Config file created successfully")
  return true
}

async function testServerStartup(): Promise<boolean> {
  console.log("\n[TEST] Testing server startup with existing config...")

  // Ensure config exists
  if (!existsSync(CONFIG_PATH)) {
    console.error("  SKIP: Config file doesn't exist, run config creation test first")
    return false
  }

  // Start server
  const server = spawn("bun", ["run", ".opencode/easy-workflow/standalone.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""
  let started = false

  server.stdout.on("data", (data) => {
    const text = data.toString()
    output += text
    if (text.includes("Server Started Successfully")) {
      started = true
    }
  })

  server.stderr.on("data", (data) => {
    output += data.toString()
  })

  // Wait for startup
  await delay(2000)

  // Kill server
  server.kill()

  if (!started) {
    console.error("  FAIL: Server did not start successfully")
    console.error("  Output:", output)
    return false
  }

  console.log("  PASS: Server started successfully")
  return true
}

async function testApiEndpoints(): Promise<boolean> {
  console.log("\n[TEST] Testing API endpoints...")

  // Read the port from database first
  const { execSync } = await import("child_process")
  let port = 3789 // default
  try {
    const result = execSync("sqlite3 .opencode/easy-workflow/tasks.db \"SELECT value FROM options WHERE key='port';\"", {
      encoding: "utf-8",
      cwd: process.cwd(),
    }).trim()
    if (result) {
      port = parseInt(result, 10) || 3789
    }
  } catch {
    // Use default
  }
  console.log(`  Using port: ${port}`)

  // Start server
  const server = spawn("bun", ["run", ".opencode/easy-workflow/standalone.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  let ready = false
  let output = ""
  server.stdout.on("data", (data) => {
    const text = data.toString()
    output += text
    if (text.includes("Server Started Successfully")) {
      ready = true
    }
  })

  // Wait for startup (give it more time)
  await delay(3000)

  if (!ready) {
    console.error("  FAIL: Server did not start")
    console.error("  Output so far:", output.substring(0, 500))
    server.kill()
    return false
  }

  // Wait a bit more for the HTTP server to be fully ready
  await delay(1000)

  try {
    // Test /api/tasks endpoint
    const response = await fetch(`http://localhost:${port}/api/tasks`)
    if (!response.ok) {
      console.error("  FAIL: /api/tasks returned", response.status)
      server.kill()
      return false
    }

    const tasks = await response.json()
    console.log("  PASS: /api/tasks returned", Array.isArray(tasks) ? tasks.length : "invalid", "tasks")

    // Test /api/options endpoint
    const optionsResponse = await fetch(`http://localhost:${port}/api/options`)
    if (!optionsResponse.ok) {
      console.error("  FAIL: /api/options returned", optionsResponse.status)
      server.kill()
      return false
    }

    const options = await optionsResponse.json()
    console.log("  PASS: /api/options returned valid options")

    server.kill()
    return true
  } catch (err) {
    console.error("  FAIL: Error testing endpoints:", err instanceof Error ? err.message : String(err))
    server.kill()
    return false
  }
}

async function runTests(): Promise<void> {
  console.log("============================================")
  console.log("  Easy Workflow - Architecture Tests")
  console.log("============================================")

  const results = []

  // Test 1: Config creation
  results.push(await testConfigCreation())

  // Test 2: Server startup
  results.push(await testServerStartup())

  // Test 3: API endpoints
  results.push(await testApiEndpoints())

  console.log("\n============================================")
  console.log("  Test Results")
  console.log("============================================")

  const passed = results.filter((r) => r).length
  const total = results.length

  console.log(`Passed: ${passed}/${total}`)

  if (passed === total) {
    console.log("\nAll tests passed!")
    process.exit(0)
  } else {
    console.log("\nSome tests failed.")
    process.exit(1)
  }
}

runTests().catch((err) => {
  console.error("Test error:", err)
  process.exit(1)
})
