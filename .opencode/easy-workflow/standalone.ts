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
import { Orchestrator } from "./orchestrator"

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
  console.log("[config] Please provide the OpenCode server URL.")
  console.log("[config] You can find this in the OpenCode app settings or logs.\n")

  let url = await promptForUrl()
  
  while (!validateUrl(url)) {
    console.log("[config] Invalid URL. Please enter a valid HTTP/HTTPS URL.")
    url = await promptForUrl()
  }

  // Remove trailing slash
  url = url.replace(/\/$/, "")

  const config: Config = {
    opencodeServerUrl: url,
    projectDirectory: resolve(process.cwd()),
  }

  saveConfig(config)
  
  console.log("\n[config] Configuration saved to:", CONFIG_PATH)
  console.log("[config] OpenCode Server URL:", config.opencodeServerUrl)
  console.log("[config] Project Directory:", config.projectDirectory)
  console.log("\n[config] You can edit this file manually if needed.\n")

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

  // Initialize orchestrator (created before server to pass to it)
  let orchestrator: Orchestrator | null = null

  // Initialize kanban server
  const kanbanServer = new KanbanServer(db, {
    onStart: async () => {
      if (orchestrator) await orchestrator.start()
    },
    onStartSingle: async (taskId: string) => {
      if (orchestrator) await orchestrator.startSingle(taskId)
    },
    onStop: () => {
      if (orchestrator) orchestrator.stop()
    },
    getExecuting: () => orchestrator?.isExecuting() ?? false,
    getStartError: (taskId?: string) => {
      return orchestrator ? orchestrator.preflightStartError(taskId) : "Orchestrator not initialized"
    },
    getServerUrl,
    ownerDirectory: config.projectDirectory,
  })

  // Initialize orchestrator
  orchestrator = new Orchestrator(
    db,
    kanbanServer,
    getServerUrl,
    config.projectDirectory,
    config.projectDirectory,
  )

  // Start server
  const port = kanbanServer.start()
  
  // Update config with kanban port for bridge plugin
  const configWithPort = {
    ...config,
    kanbanPort: port,
  }
  saveConfig(configWithPort)
  
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
