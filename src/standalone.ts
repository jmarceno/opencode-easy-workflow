/**
 * Easy Workflow Standalone Server
 * 
 * This is the standalone server that runs outside of OpenCode.
 * It reads configuration from .opencode/easy-workflow/config.json
 * and provides the kanban web UI and task orchestration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, resolve } from "path"
import { createInterface } from "readline"
import { KanbanDB } from "./db"
import { KanbanServer } from "./server"
import { WorkflowRunManager } from "./run-manager"

const WORKFLOW_DIR = join(process.cwd(), ".opencode", "easy-workflow")
const CONFIG_PATH = join(WORKFLOW_DIR, "config.json")
const DB_PATH = join(WORKFLOW_DIR, "tasks.db")

interface Config {
  opencodeServerUrl: string
  projectDirectory: string
  kanbanPort?: number
}

function ensureWorkflowDir(): void {
  mkdirSync(WORKFLOW_DIR, { recursive: true })
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) {
    return null
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    return {
      opencodeServerUrl: parsed.opencodeServerUrl,
      projectDirectory: parsed.projectDirectory || process.cwd(),
      kanbanPort: parsed.kanbanPort ? Number(parsed.kanbanPort) : undefined,
    }
  } catch (err) {
    console.error("[config] Failed to load config:", err instanceof Error ? err.message : String(err))
    return null
  }
}

function saveConfig(config: Config): void {
  ensureWorkflowDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8")
}

async function promptForUrl(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question("Enter OpenCode server URL (e.g., http://localhost:4096): ", (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

async function initializeConfig(): Promise<Config> {
  console.log("[config] Configuration file not found.")
  console.log("[config] Auto-creating configuration with default settings.")
  
  // Use default URL instead of prompting (stdin is often not available when spawned)
  const defaultUrl = "http://localhost:4096"
  console.log(`[config] Using default OpenCode server URL: ${defaultUrl}`)
  console.log(`[config] To change this, edit: ${CONFIG_PATH}`)

  const config: Config = {
    opencodeServerUrl: defaultUrl,
    projectDirectory: resolve(process.cwd()),
  }

  saveConfig(config)
  
  console.log("[config] Configuration saved to:", CONFIG_PATH)
  console.log("[config] OpenCode Server URL:", config.opencodeServerUrl)
  console.log("[config] Project Directory:", config.projectDirectory)

  return config
}

async function main() {
  console.log("============================================")
  console.log("  Easy Workflow Standalone Server")
  console.log("============================================\n")

  // Load or create config
  let config = loadConfig()
  if (!config) {
    config = await initializeConfig()
  } else {
    console.log("[config] Loaded configuration from:", CONFIG_PATH)
    console.log("[config] OpenCode Server URL:", config.opencodeServerUrl)
    console.log("[config] Project Directory:", config.projectDirectory)
    console.log("")
    
    // Validate that config.projectDirectory matches current working directory
    // This prevents using a stale config when the server is started from a different directory
    const actualCwd = resolve(process.cwd())
    const configProjectDir = resolve(config.projectDirectory)
    if (actualCwd !== configProjectDir) {
      console.log("[config] WARNING: Config projectDirectory doesn't match current directory")
      console.log("[config]   Config says:", configProjectDir)
      console.log("[config]   Actually running from:", actualCwd)
      console.log("[config] Updating to use current directory...\n")
      config.projectDirectory = actualCwd
      saveConfig(config)
    }
  }

  // Validate config
  if (!validateUrl(config.opencodeServerUrl)) {
    console.error("[config] Invalid OpenCode server URL in config:", config.opencodeServerUrl)
    console.error("[config] Please delete", CONFIG_PATH, "and restart to reconfigure.")
    process.exit(1)
  }

  // Initialize database
  console.log("[db] Initializing database at:", DB_PATH)
  const db = new KanbanDB(DB_PATH)
  db.cleanupStaleWorkflowSessions()

  // Override database port with config value if available, to ensure consistency
  if (config.kanbanPort) {
    db.updateOptions({ port: config.kanbanPort })
  }
  console.log("[db] Database ready\n")

  // Create server URL resolver function
  const getServerUrl = (): string | null => {
    return config!.opencodeServerUrl
  }

  let runManager: WorkflowRunManager | null = null

  // Initialize kanban server
  const kanbanServer = new KanbanServer(db, {
    onStart: async () => {
      if (!runManager) throw new Error("Run manager not initialized")
      return runManager.startAll()
    },
    onStartSingle: async (taskId: string) => {
      if (!runManager) throw new Error("Run manager not initialized")
      return runManager.startSingle(taskId)
    },
    onStop: async () => {
      if (runManager) await runManager.stopAllActiveRuns()
    },
    onPauseRun: async (runId: string) => {
      if (!runManager) throw new Error("Run manager not initialized")
      return runManager.pauseRun(runId)
    },
    onResumeRun: async (runId: string) => {
      if (!runManager) throw new Error("Run manager not initialized")
      return runManager.resumeRun(runId)
    },
    onStopRun: async (runId: string) => {
      if (!runManager) throw new Error("Run manager not initialized")
      return runManager.stopRun(runId)
    },
    getExecuting: () => runManager?.hasRunningRuns() ?? false,
    getStartError: (taskId?: string) => {
      return runManager ? runManager.getRunStartError(taskId) : "Run manager not initialized"
    },
    getServerUrl,
    ownerDirectory: config.projectDirectory,
  })

  runManager = new WorkflowRunManager(db, kanbanServer, getServerUrl, config.projectDirectory)

  // Start server
  const port = kanbanServer.start()
  
  // Update config with kanban port for bridge plugin
  const configWithPort = {
    ...config,
    kanbanPort: port,
  }
  saveConfig(configWithPort)

  const staleRuns = await runManager.recoverStaleRuns(async (taskId: string) => {
    await kanbanServer.repairTaskState(
      taskId,
      "Startup stale run recovery: inspect the interrupted task and choose the safest resume/reset/done/fail outcome.",
    )
  })
  if (staleRuns.length > 0) {
    console.log(`[server] Recovered ${staleRuns.length} stale workflow run(s)`) 
  }
  
  console.log("============================================")
  console.log("  Server Started Successfully!")
  console.log("============================================")
  console.log("  Kanban UI: http://0.0.0.0:" + port + " (accessible on all network interfaces)")
  console.log("  OpenCode: " + config.opencodeServerUrl)
  console.log("============================================\n")

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[server] Shutting down gracefully...")
    kanbanServer.stop()
    db.close()
    console.log("[server] Goodbye!")
    process.exit(0)
  })

  process.on("SIGTERM", () => {
    console.log("\n[server] Shutting down gracefully...")
    kanbanServer.stop()
    db.close()
    console.log("[server] Goodbye!")
    process.exit(0)
  })
}

main().catch((err) => {
  console.error("[server] Fatal error:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
