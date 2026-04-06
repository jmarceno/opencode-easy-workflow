#!/usr/bin/env bun
/**
 * Easy Workflow - Install/Uninstall Script
 * 
 * This script installs Easy Workflow to the OpenCode global config directory.
 * 
 * Usage:
 *   ./install.ts [install|remove|status]
 * 
 * Install: Copies plugin, agents, skills, and easy-workflow/ to ~/.config/opencode/
 * Remove:  Removes all copied files from ~/.config/opencode/
 * Status:  Shows current installation status
 */

import { existsSync, mkdirSync, copyFileSync, unlinkSync, rmdirSync, readdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { fileURLToPath } from "url"

// ---- Configuration ----

const OPENCODE_DIR = join(homedir(), ".config", "opencode")
const PLUGIN_NAME = "easy-workflow"

// Get project root from the directory where this script is located
const __filename = fileURLToPath(import.meta.url)
const PROJECT_ROOT = dirname(__filename)

// Source directories (in the project repo)
const SOURCE_PLUGIN_DIR = join(PROJECT_ROOT, ".opencode", "plugins")
const SOURCE_AGENTS_DIR = join(PROJECT_ROOT, ".opencode", "agents")
const SOURCE_SKILL_DIR = join(PROJECT_ROOT, ".opencode", "skills", "workflow-task-setup")
const SOURCE_WORKFLOW_DIR = join(PROJECT_ROOT, ".opencode", "easy-workflow")

// Destination directories (in user's home)
const DEST_PLUGIN_DIR = join(OPENCODE_DIR, "plugins", PLUGIN_NAME)
const DEST_AGENTS_DIR = join(OPENCODE_DIR, "agents")
const DEST_SKILL_DIR = join(OPENCODE_DIR, "skills", "workflow-task-setup")
const DEST_WORKFLOW_DIR = join(OPENCODE_DIR, "easy-workflow")

// Explicit list of files to copy from easy-workflow directory (NO recursive copy)
const WORKFLOW_FILES = [
  "server.ts",
  "db.ts",
  "types.ts",
  "task-state.ts",
  "telegram.ts",
  "orchestrator.ts",
  "standalone.ts",
  "execution-plan.ts",
  "workflow.md",
  "kanban/index.html",
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
  install    Install Easy Workflow to ~/.config/opencode/
  remove     Remove Easy Workflow from ~/.config/opencode/
  status     Show installation status
`)
}

// ---- Commands ----

function status(): void {
  console.log("\n=== Easy Workflow Installation Status ===\n")
  
  console.log(`Global opencode directory: ${OPENCODE_DIR}`)
  console.log("")
  
  // Plugin status
  if (existsSync(DEST_PLUGIN_DIR)) {
    console.log(`Plugin (${PLUGIN_NAME}): INSTALLED`)
    console.log(`  Location: ${DEST_PLUGIN_DIR}`)
  } else {
    console.log(`Plugin (${PLUGIN_NAME}): NOT INSTALLED`)
  }
  
  // Easy-workflow dir status
  if (existsSync(DEST_WORKFLOW_DIR)) {
    console.log("")
    console.log(`Easy-Workflow: INSTALLED`)
    console.log(`  Location: ${DEST_WORKFLOW_DIR}`)
    const entries = readdirSync(DEST_WORKFLOW_DIR)
    console.log(`  Files: ${entries.filter(e => e.endsWith('.ts')).join(", ")}`)
  } else {
    console.log("")
    console.log(`Easy-Workflow: NOT INSTALLED`)
  }
  
  // Agents status
  if (existsSync(SOURCE_AGENTS_DIR)) {
    const sourceAgents = readdirSync(SOURCE_AGENTS_DIR).filter(f => f.endsWith('.md'))
    const installedAgents: string[] = []
    const missingAgents: string[] = []
    
    for (const agent of sourceAgents) {
      if (existsSync(join(DEST_AGENTS_DIR, agent))) {
        installedAgents.push(agent)
      } else {
        missingAgents.push(agent)
      }
    }
    
    console.log("")
    console.log(`Agents: ${installedAgents.length}/${sourceAgents.length} installed`)
    if (missingAgents.length > 0) {
      console.log(`  Missing: ${missingAgents.join(", ")}`)
    }
  }
  
  // Skill status
  console.log("")
  if (existsSync(DEST_SKILL_DIR)) {
    console.log("Skill (workflow-task-setup): INSTALLED")
    console.log(`  Location: ${DEST_SKILL_DIR}`)
  } else {
    console.log("Skill (workflow-task-setup): NOT INSTALLED")
  }
  
  console.log("")
}

function install(): void {
  console.log("\n=== Installing Easy Workflow ===\n")
  
  // 1. Copy plugin
  const pluginSource = join(SOURCE_PLUGIN_DIR, "easy-workflow.ts")
  if (!existsSync(pluginSource)) {
    console.error(`✗ Plugin file not found: ${pluginSource}`)
    process.exit(1)
  }
  
  ensureDir(DEST_PLUGIN_DIR)
  copyFileSync(pluginSource, join(DEST_PLUGIN_DIR, "easy-workflow.ts"))
  console.log(`✓ Copied plugin to ${DEST_PLUGIN_DIR}`)
  
  // 2. Copy easy-workflow files (explicit list - NO recursive copy)
  ensureDir(DEST_WORKFLOW_DIR)
  ensureDir(join(DEST_WORKFLOW_DIR, "kanban"))
  
  let copiedCount = 0
  for (const file of WORKFLOW_FILES) {
    const sourcePath = join(SOURCE_WORKFLOW_DIR, file)
    const destPath = join(DEST_WORKFLOW_DIR, file)
    
    if (!existsSync(sourcePath)) {
      console.error(`✗ Missing required file: ${sourcePath}`)
      process.exit(1)
    }
    
    copyFileSync(sourcePath, destPath)
    copiedCount++
  }
  
  console.log(`✓ Copied ${copiedCount} files to ${DEST_WORKFLOW_DIR}`)
  
  // 3. Copy agents
  if (existsSync(SOURCE_AGENTS_DIR)) {
    ensureDir(DEST_AGENTS_DIR)
    const agentFiles = readdirSync(SOURCE_AGENTS_DIR).filter(f => f.endsWith('.md'))
    
    for (const agentFile of agentFiles) {
      const sourcePath = join(SOURCE_AGENTS_DIR, agentFile)
      const destPath = join(DEST_AGENTS_DIR, agentFile)
      copyFileSync(sourcePath, destPath)
    }
    
    if (agentFiles.length > 0) {
      console.log(`✓ Copied ${agentFiles.length} agent(s) to ${DEST_AGENTS_DIR}`)
    }
  }
  
  // 4. Copy skill (skill is small, recursive is fine here)
  if (existsSync(SOURCE_SKILL_DIR)) {
    ensureDir(dirname(DEST_SKILL_DIR))
    copyRecursive(SOURCE_SKILL_DIR, DEST_SKILL_DIR)
    console.log(`✓ Copied skill to ${DEST_SKILL_DIR}`)
  }
  
  console.log("\n=== Installation Complete ===\n")
  console.log("Easy Workflow is now installed globally.")
  console.log("")
  console.log("To uninstall: ./install.ts remove")
  console.log("")
}

function remove(): void {
  console.log("\n=== Removing Easy Workflow ===\n")
  
  // 1. Remove plugin
  if (existsSync(DEST_PLUGIN_DIR)) {
    removeRecursive(DEST_PLUGIN_DIR)
    console.log(`✓ Removed plugin: ${DEST_PLUGIN_DIR}`)
  } else {
    console.log(`○ Plugin not installed: ${DEST_PLUGIN_DIR}`)
  }
  
  // 2. Remove easy-workflow directory and all its files
  if (existsSync(DEST_WORKFLOW_DIR)) {
    removeRecursive(DEST_WORKFLOW_DIR)
    console.log(`✓ Removed easy-workflow: ${DEST_WORKFLOW_DIR}`)
  } else {
    console.log(`○ Easy-workflow not installed: ${DEST_WORKFLOW_DIR}`)
  }
  
  // 3. Remove agents
  if (existsSync(SOURCE_AGENTS_DIR)) {
    const agentFiles = readdirSync(SOURCE_AGENTS_DIR).filter(f => f.endsWith('.md'))
    let removedCount = 0
    
    for (const agentFile of agentFiles) {
      const destPath = join(DEST_AGENTS_DIR, agentFile)
      if (existsSync(destPath)) {
        unlinkSync(destPath)
        removedCount++
      }
    }
    
    if (removedCount > 0) {
      console.log(`✓ Removed ${removedCount} agent(s) from ${DEST_AGENTS_DIR}`)
    }
  }
  
  // 4. Remove skill
  if (existsSync(DEST_SKILL_DIR)) {
    removeRecursive(DEST_SKILL_DIR)
    console.log(`✓ Removed skill: ${DEST_SKILL_DIR}`)
  } else {
    console.log(`○ Skill not installed: ${DEST_SKILL_DIR}`)
  }
  
  console.log("\n=== Removal Complete ===\n")
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
