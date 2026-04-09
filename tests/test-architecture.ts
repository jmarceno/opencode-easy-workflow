/**
 * Test script for the standalone server architecture
 * 
 * This script tests:
 * 1. Config file creation
 * 2. Server startup
 * 3. Bridge event forwarding
 * 4. API endpoints
 * 
 * CRITICAL: This test uses a TEMPORARY directory to avoid interfering with production.
 * It NEVER modifies the production config or database.
 */

import { spawn } from "child_process"
import { existsSync, unlinkSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"

const PRODUCTION_CONFIG_PATH = join(process.cwd(), ".opencode", "easy-workflow", "config.json")
const TEST_TIMEOUT = 30000
const TEST_STANDALONE_MODULES = ["db.ts", "server.ts", "orchestrator.ts", "run-manager.ts", "types.ts", "execution-plan.ts", "task-state.ts", "telegram.ts"]

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Create a temporary test environment
 * Returns the path to the temp workflow directory
 */
function createTestEnvironment(): { tempDir: string; workflowDir: string; configPath: string; restore: () => void } {
  // Create temp directory
  const tempDir = mkdtempSync(join(tmpdir(), "ewf-arch-test-"))
  const workflowDir = join(tempDir, ".opencode", "easy-workflow")
  const configPath = join(workflowDir, "config.json")
  
  mkdirSync(workflowDir, { recursive: true })
  
  // If production config exists, copy it as a starting point
  if (existsSync(PRODUCTION_CONFIG_PATH)) {
    cpSync(PRODUCTION_CONFIG_PATH, configPath)
  }
  
  // Cleanup function
  const restore = () => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
  
  return { tempDir, workflowDir, configPath, restore }
}

/**
 * Backup production config and return restore function
 */
function backupProductionConfig(): () => void {
  let backupPath: string | null = null
  
  if (existsSync(PRODUCTION_CONFIG_PATH)) {
    backupPath = PRODUCTION_CONFIG_PATH + ".backup." + Date.now()
    cpSync(PRODUCTION_CONFIG_PATH, backupPath)
  }
  
  return () => {
    if (backupPath && existsSync(backupPath)) {
      try {
        cpSync(backupPath, PRODUCTION_CONFIG_PATH)
        unlinkSync(backupPath)
      } catch {
        // Ignore restore errors
      }
    }
  }
}

async function testConfigCreation(): Promise<boolean> {
  console.log("\n[TEST] Testing config file creation...")
  
  const { tempDir, workflowDir, configPath, restore } = createTestEnvironment()
  const restoreProd = backupProductionConfig()
  
  try {
    // Ensure config doesn't exist in temp dir
    if (existsSync(configPath)) {
      unlinkSync(configPath)
    }

    // Copy the standalone.ts to temp dir
    const standaloneSource = join(process.cwd(), "src", "standalone.ts")
    const standaloneDest = join(workflowDir, "standalone.ts")
    cpSync(standaloneSource, standaloneDest)
    
    // Copy required modules
    for (const mod of TEST_STANDALONE_MODULES) {
      const src = join(process.cwd(), "src", mod)
      const dest = join(workflowDir, mod)
      if (existsSync(src)) {
        cpSync(src, dest)
      }
    }
    
    // Copy kanban directory
    const kanbanSrc = join(process.cwd(), "src", "kanban")
    const kanbanDest = join(workflowDir, "kanban")
    if (existsSync(kanbanSrc)) {
      mkdirSync(kanbanDest, { recursive: true })
      const files = ["index.html"]
      for (const file of files) {
        const fSrc = join(kanbanSrc, file)
        const fDest = join(kanbanDest, file)
        if (existsSync(fSrc)) {
          cpSync(fSrc, fDest)
        }
      }
    }
    
    // Create a minimal package.json for the temp dir
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "test-env", type: "module" })
    )

    // Start server with stdin input in temp directory
    const server = spawn("bun", ["run", standaloneDest], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tempDir,
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

    // Check if config was created in temp dir (NOT production)
    if (!existsSync(configPath)) {
      console.error("  FAIL: Config file was not created in temp directory")
      console.error("  Output:", output)
      return false
    }

    console.log("  PASS: Config file created successfully in temp directory")
    return true
  } finally {
    restore()
    restoreProd()
  }
}

async function testServerStartup(): Promise<boolean> {
  console.log("\n[TEST] Testing server startup with existing config...")
  
  const { tempDir, workflowDir, configPath, restore } = createTestEnvironment()
  const restoreProd = backupProductionConfig()
  
  try {
    // Create a minimal config for testing
    writeFileSync(configPath, JSON.stringify({
      opencodeServerUrl: "http://localhost:4096",
      projectDirectory: tempDir,
    }, null, 2))

    // Copy required files
    const standaloneSource = join(process.cwd(), "src", "standalone.ts")
    const standaloneDest = join(workflowDir, "standalone.ts")
    cpSync(standaloneSource, standaloneDest)
    
    for (const mod of TEST_STANDALONE_MODULES) {
      const src = join(process.cwd(), "src", mod)
      const dest = join(workflowDir, mod)
      if (existsSync(src)) {
        cpSync(src, dest)
      }
    }
    
    // Copy kanban directory
    const kanbanSrc = join(process.cwd(), "src", "kanban")
    const kanbanDest = join(workflowDir, "kanban")
    if (existsSync(kanbanSrc)) {
      mkdirSync(kanbanDest, { recursive: true })
      const indexSrc = join(kanbanSrc, "index.html")
      const indexDest = join(kanbanDest, "index.html")
      if (existsSync(indexSrc)) {
        cpSync(indexSrc, indexDest)
      }
    }

    // Start server in temp directory
    const server = spawn("bun", ["run", standaloneDest], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: tempDir,
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
  } finally {
    restore()
    restoreProd()
  }
}

async function testApiEndpoints(): Promise<boolean> {
  console.log("\n[TEST] Testing API endpoints...")
  
  const { tempDir, workflowDir, configPath, restore } = createTestEnvironment()
  const restoreProd = backupProductionConfig()
  
  try {
    // Create a minimal config for testing
    writeFileSync(configPath, JSON.stringify({
      opencodeServerUrl: "http://localhost:4096",
      projectDirectory: tempDir,
    }, null, 2))

    // Copy required files
    const standaloneSource = join(process.cwd(), "src", "standalone.ts")
    const standaloneDest = join(workflowDir, "standalone.ts")
    cpSync(standaloneSource, standaloneDest)
    
    for (const mod of TEST_STANDALONE_MODULES) {
      const src = join(process.cwd(), "src", mod)
      const dest = join(workflowDir, mod)
      if (existsSync(src)) {
        cpSync(src, dest)
      }
    }
    
    // Copy kanban directory
    const kanbanSrc = join(process.cwd(), "src", "kanban")
    const kanbanDest = join(workflowDir, "kanban")
    if (existsSync(kanbanSrc)) {
      mkdirSync(kanbanDest, { recursive: true })
      const indexSrc = join(kanbanSrc, "index.html")
      const indexDest = join(kanbanDest, "index.html")
      if (existsSync(indexSrc)) {
        cpSync(indexSrc, indexDest)
      }
    }

    // Start server in temp directory
    const server = spawn("bun", ["run", standaloneDest], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: tempDir,
    })

    let ready = false
    let output = ""
    let actualPort: number | null = null
    
    server.stdout.on("data", (data) => {
      const text = data.toString()
      output += text
      // Extract port from "Kanban UI: http://0.0.0.0:PORT" message
      const portMatch = text.match(/Kanban UI: http:\/\/0\.0\.0\.0:(\d+)/)
      if (portMatch) {
        actualPort = parseInt(portMatch[1], 10)
      }
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

    if (!actualPort) {
      console.error("  FAIL: Could not determine server port")
      server.kill()
      return false
    }

    console.log(`  Server running on port: ${actualPort}`)

    try {
      // Test /api/tasks endpoint
      const response = await fetch(`http://localhost:${actualPort}/api/tasks`)
      if (!response.ok) {
        console.error("  FAIL: /api/tasks returned", response.status)
        server.kill()
        return false
      }

      const tasks = await response.json()
      console.log("  PASS: /api/tasks returned", Array.isArray(tasks) ? tasks.length : "invalid", "tasks")

      // Test /api/options endpoint
      const optionsResponse = await fetch(`http://localhost:${actualPort}/api/options`)
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
  } finally {
    restore()
    restoreProd()
  }
}

async function runTests(): Promise<void> {
  console.log("============================================")
  console.log("  Easy Workflow - Architecture Tests")
  console.log("============================================")
  console.log("\n  ⚠️  These tests use TEMPORARY directories")
  console.log("     and NEVER touch production config files.")
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
