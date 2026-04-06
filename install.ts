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
  - The plugin auto-starts the standalone server when you open a project
  - Preserve your local workflow configuration and database
`)
}

// ---- Commands ----

function getInstallPath(): string {
  return join(OPENCODE_GLOBAL_DIR, PLUGIN_NAME)
}

function status(): void {
  console.log("\n=== Easy Workflow Installation Status ===\n")
  
  const installPath = getInstallPath()
  
  console.log(`Global plugins directory: ${OPENCODE_GLOBAL_DIR}`)
  console.log(`Install path: ${installPath}`)
  console.log("")
  
  if (existsSync(installPath)) {
    console.log("Plugin: INSTALLED")
    const files = readdirSync(installPath)
    console.log(`  Files: ${files.join(", ")}`)
  } else {
    console.log("Plugin: NOT INSTALLED")
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
  
  // 3. Copy skill if not exists
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
  const globalSkillDir = join(homedir(), ".config", "opencode", "skills", "workflow-task-setup")
  
  // Remove plugin directory
  if (existsSync(installPath)) {
    removeRecursive(installPath)
    console.log(`✓ Removed: ${installPath}`)
  } else {
    console.log(`○ Not installed: ${installPath}`)
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
  console.log("To start fresh, you can manually delete:")
  console.log(`  rm -rf ${WORKFLOW_DIR}`)
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
