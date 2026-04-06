#!/usr/bin/env bun
/**
 * Easy Workflow - Install/Uninstall Script
 * 
 * This script installs Easy Workflow to the OpenCode global plugins directory
 * and sets up the standalone server to auto-start with OpenCode.
 * 
 * Usage:
 *   ./install.ts [install|remove|status]
 * 
 * Install: Copies plugin and creates startup hooks
 * Remove: Removes plugin and startup hooks  
 * Status: Shows current installation status
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync, statSync } from "fs"
import { join, resolve, dirname } from "path"
import { homedir } from "os"

// ---- Configuration ----

const OPENCODE_GLOBAL_DIR = join(homedir(), ".config", "opencode", "plugins")
const PLUGIN_NAME = "easy-workflow"

// Get project root from CWD (where the script is run from)
const PROJECT_ROOT = process.cwd()
const PLUGIN_SOURCE_DIR = join(PROJECT_ROOT, ".opencode", "plugins")
const WORKFLOW_DIR = join(PROJECT_ROOT, ".opencode", "easy-workflow")
const SKILL_DIR = join(PROJECT_ROOT, ".opencode", "skills", "workflow-task-setup")

// Files to copy to global plugins directory
const FILES_TO_COPY = [
  { source: "easy-workflow.ts", dest: "easy-workflow.ts" },
  { source: "easy-workflow.ts.bak", dest: "easy-workflow.ts.bak", optional: true },
]

// ---- Utility Functions ----

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function copyRecursive(src: string, dest: string): void {
  const stats = statSync(src)
  if (stats.isDirectory()) {
    ensureDir(dest)
    const entries = readdirSync(src)
    for (const entry of entries) {
      copyRecursive(join(src, entry), join(dest, entry))
    }
  } else {
    copyFileSync(src, dest)
  }
}

function removeRecursive(dir: string): void {
  if (!existsSync(dir)) return
  
  const entries = readdirSync(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      removeRecursive(fullPath)
      rmdirSync(fullPath)
    } else {
      unlinkSync(fullPath)
    }
  }
  rmdirSync(dir)
}

function printUsage(): void {
  console.log(`
Easy Workflow Installer

Usage: ./install.ts <command>

Commands:
  install    Install Easy Workflow to OpenCode global plugins
  remove     Remove Easy Workflow from OpenCode global plugins
  status     Show installation status

This will:
  - Copy the bridge plugin to ~/.config/opencode/plugins/easy-workflow/
  - Create startup hooks for auto-starting the standalone server
  - Preserve your local workflow configuration and database
`)
}

// ---- Commands ----

function getInstallPath(): string {
  return join(OPENCODE_GLOBAL_DIR, PLUGIN_NAME)
}

function getStartupScriptPath(): string {
  return join(OPENCODE_GLOBAL_DIR, `${PLUGIN_NAME}-startup.ts`)
}

function status(): void {
  console.log("\n=== Easy Workflow Installation Status ===\n")
  
  const installPath = getInstallPath()
  const startupPath = getStartupScriptPath()
  
  console.log(`Global plugins directory: ${OPENCODE_GLOBAL_DIR}`)
  console.log(`Install path: ${installPath}`)
  console.log(`Startup script: ${startupPath}`)
  console.log("")
  
  if (existsSync(installPath)) {
    console.log("Plugin: INSTALLED")
    const files = readdirSync(installPath)
    console.log(`  Files: ${files.join(", ")}`)
  } else {
    console.log("Plugin: NOT INSTALLED")
  }
  
  if (existsSync(startupPath)) {
    console.log("Startup hook: INSTALLED")
  } else {
    console.log("Startup hook: NOT INSTALLED")
  }
  
  console.log("")
  console.log(`Local workflow directory: ${WORKFLOW_DIR}`)
  if (existsSync(WORKFLOW_DIR)) {
    console.log("Status: EXISTS")
    const files = readdirSync(WORKFLOW_DIR)
    console.log(`  Contents: ${files.length} items`)
  } else {
    console.log("Status: NOT FOUND")
  }
  
  console.log("")
}

function install(): void {
  console.log("\n=== Installing Easy Workflow ===\n")
  
  // 1. Ensure global plugins directory exists
  ensureDir(OPENCODE_GLOBAL_DIR)
  console.log(`✓ Ensured global plugins directory: ${OPENCODE_GLOBAL_DIR}`)
  
  // 2. Copy plugin files
  const installPath = getInstallPath()
  ensureDir(installPath)
  
  for (const file of FILES_TO_COPY) {
    const sourcePath = join(PLUGIN_SOURCE_DIR, file.source)
    const destPath = join(installPath, file.dest)
    
    if (!existsSync(sourcePath)) {
      if (file.optional) {
        console.log(`○ Skipped optional file: ${file.source}`)
        continue
      }
      console.error(`✗ Missing required file: ${sourcePath}`)
      process.exit(1)
    }
    
    copyFileSync(sourcePath, destPath)
    console.log(`✓ Copied: ${file.source} → ${destPath}`)
  }
  
  // 3. Create startup script
  const startupPath = getStartupScriptPath()
  const startupScript = `/**
 * Easy Workflow - Auto-startup Script
 * 
 * This script is loaded by OpenCode and auto-starts the standalone server.
 */

import { spawn } from "child_process"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

const WORKFLOW_DIR = join(process.cwd(), ".opencode", "easy-workflow")
const CONFIG_PATH = join(WORKFLOW_DIR, "config.json")
const PID_FILE = join(WORKFLOW_DIR, ".server.pid")

function findProjectRoot(startDir: string): string | null {
  let current = startDir
  while (current !== "/") {
    if (existsSync(join(current, ".opencode", "easy-workflow"))) {
      return current
    }
    const parent = join(current, "..")
    if (parent === current) break
    current = parent
  }
  return null
}

function isServerRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const EasyWorkflowStartup = async () => {
  // Only auto-start if we're in a project with easy-workflow
  const projectRoot = findProjectRoot(process.cwd())
  if (!projectRoot) {
    return {}
  }
  
  const workflowDir = join(projectRoot, ".opencode", "easy-workflow")
  const configPath = join(workflowDir, "config.json")
  const pidFile = join(workflowDir, ".server.pid")
  
  // Check if already running
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8"), 10)
    if (!isNaN(pid) && isServerRunning(pid)) {
      console.log(\`[easy-workflow] Server already running (PID: \${pid})\`)
      return {}
    }
  }
  
  // Check if config exists (user has initialized the server before)
  if (!existsSync(configPath)) {
    console.log("[easy-workflow] Config not found. Run 'bun run .opencode/easy-workflow/standalone.ts' to initialize.")
    return {}
  }
  
  // Start the standalone server detached
  const standalonePath = join(workflowDir, "standalone.ts")
  if (!existsSync(standalonePath)) {
    console.error("[easy-workflow] Standalone server not found:", standalonePath)
    return {}
  }
  
  console.log("[easy-workflow] Starting standalone server...")
  
  const child = spawn("bun", ["run", standalonePath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    cwd: projectRoot,
  })
  
  child.unref()
  
  // Save PID
  writeFileSync(pidFile, String(child.pid), "utf-8")
  
  console.log(\`[easy-workflow] Server started (PID: \${child.pid})\`)
  
  // Give it a moment to start
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  return {}
}

export default EasyWorkflowStartup
`
  
  writeFileSync(startupPath, startupScript, "utf-8")
  console.log(`✓ Created startup script: ${startupPath}`)
  
  // 4. Copy skill if not exists
  const globalSkillDir = join(homedir(), ".config", "opencode", "skills", "workflow-task-setup")
  if (existsSync(SKILL_DIR)) {
    ensureDir(dirname(globalSkillDir))
    copyRecursive(SKILL_DIR, globalSkillDir)
    console.log(`✓ Copied skill: ${globalSkillDir}`)
  }
  
  console.log("\n=== Installation Complete ===\n")
  console.log("The Easy Workflow plugin is now installed globally.")
  console.log("")
  console.log("Next steps:")
  console.log("  1. OpenCode will auto-load the plugin for all projects")
  console.log("  2. The plugin will auto-start the standalone server when you open a project with .opencode/easy-workflow/")
  console.log("  3. First time: Run 'bun run .opencode/easy-workflow/standalone.ts' to configure the OpenCode server URL")
  console.log("")
  console.log("To uninstall: ./install.ts remove")
  console.log("")
}

function remove(): void {
  console.log("\n=== Removing Easy Workflow ===\n")
  
  const installPath = getInstallPath()
  const startupPath = getStartupScriptPath()
  const globalSkillDir = join(homedir(), ".config", "opencode", "skills", "workflow-task-setup")
  
  // Stop any running server
  const pidFile = join(process.cwd(), ".opencode", "easy-workflow", ".server.pid")
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8"), 10)
      if (!isNaN(pid)) {
        process.kill(pid, "SIGTERM")
        console.log(`✓ Stopped server (PID: ${pid})`)
      }
      unlinkSync(pidFile)
    } catch {
      // Ignore errors
    }
  }
  
  // Remove plugin directory
  if (existsSync(installPath)) {
    removeRecursive(installPath)
    console.log(`✓ Removed: ${installPath}`)
  } else {
    console.log(`○ Not installed: ${installPath}`)
  }
  
  // Remove startup script
  if (existsSync(startupPath)) {
    unlinkSync(startupPath)
    console.log(`✓ Removed: ${startupPath}`)
  } else {
    console.log(`○ Not installed: ${startupPath}`)
  }
  
  // Remove skill
  if (existsSync(globalSkillDir)) {
    removeRecursive(globalSkillDir)
    console.log(`✓ Removed skill: ${globalSkillDir}`)
  }
  
  console.log("\n=== Removal Complete ===\n")
  console.log("Note: Your local workflow configuration and database were NOT removed.")
  console.log(`They remain at: ${WORKFLOW_DIR}`)
  console.log("")
}

// ---- Main ----

function main(): void {
  const command = process.argv[2]
  
  switch (command) {
    case "install":
      install()
      break
    case "remove":
      remove()
      break
    case "status":
      status()
      break
    default:
      printUsage()
      break
  }
}

main()
