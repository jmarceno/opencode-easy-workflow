#!/usr/bin/env bun
/**
 * Test script for the workflow plugin
 * Tests goal extraction with the prompt: "Add a CLAUDE.md to the repo with the same content as AGENTS.md #workflow"
 */

import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk";
import { existsSync, unlinkSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const TEST_PROMPT = "Add a CLAUDE.md to the repo with the same content as AGENTS.md #workflow";
const CLAUDE_MD_PATH = join(process.cwd(), "CLAUDE.md");
const DEBUG_LOG_PATH = join(process.cwd(), ".opencode", "easy-workflow", "debug.log");
const RUNS_DIR = join(process.cwd(), ".opencode", "easy-workflow", "runs");

async function cleanup() {
  console.log("\nCleaning up...");
  if (existsSync(CLAUDE_MD_PATH)) {
    unlinkSync(CLAUDE_MD_PATH);
    console.log("Deleted CLAUDE.md");
  }
}

function checkLogs(): { success: boolean; logs: string[]; error?: string } {
  if (!existsSync(DEBUG_LOG_PATH)) {
    return { success: false, logs: [], error: "Debug log not found" };
  }

  const logContent = readFileSync(DEBUG_LOG_PATH, "utf-8");
  const lines = logContent.split("\n");
  
  // Find the most recent workflow activation attempt
  const recentLogs: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes("workflow plugin initialized")) {
      // Found start of current session
      break;
    }
    recentLogs.unshift(line);
  }
  
  const hasSuccess = recentLogs.some(line => line.includes("workflow activation succeeded"));
  const hasError = recentLogs.some(line => line.includes("goal extraction failed") || line.includes("run blocked due to error"));
  
  return { 
    success: hasSuccess && !hasError, 
    logs: recentLogs,
    error: hasError ? "Workflow activation failed" : undefined
  };
}

function checkRunFile(): { exists: boolean; path?: string; content?: string } {
  if (!existsSync(RUNS_DIR)) {
    return { exists: false };
  }

  const files = readdirSync(RUNS_DIR).filter(f => f.endsWith(".md"));
  if (files.length === 0) {
    return { exists: false };
  }

  // Get most recent by modification time
  const mostRecent = files
    .map(f => ({ name: f, path: join(RUNS_DIR, f) }))
    .sort((a, b) => {
      const statA = Bun.file(a.path).stat();
      const statB = Bun.file(b.path).stat();
      return (statB.mtime?.getTime() || 0) - (statA.mtime?.getTime() || 0);
    })[0];

  const content = readFileSync(mostRecent.path, "utf-8");
  return { exists: true, path: mostRecent.path, content };
}

async function main() {
  console.log("=== Workflow Plugin Test ===\n");
  console.log(`Test prompt: ${TEST_PROMPT}\n`);
  
  let server: { url: string; close(): void } | null = null;
  
  try {
    // Start OpenCode server on a different port
    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    const client = opencode.client;
    
    console.log(`Server started at ${server.url}`);
    
    // Clear old debug log
    if (existsSync(DEBUG_LOG_PATH)) {
      unlinkSync(DEBUG_LOG_PATH);
    }
    
    // Create a test session
    const sessionResponse = await client.session.create({
      body: { title: "Workflow Plugin Test" },
    });
    
    const session = sessionResponse.data;
    if (!session?.id) {
      throw new Error("Failed to create test session");
    }
    
    console.log(`Created test session: ${session.id}`);
    
    // Send the test prompt
    console.log("\nSending test prompt...");
    await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: TEST_PROMPT }],
      },
    });
    
    console.log("Prompt sent, waiting for workflow activation...");
    
    // Wait for plugin to process
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check results
    const logResult = checkLogs();
    const runResult = checkRunFile();
    
    console.log("\n=== Test Results ===");
    console.log(`Log success: ${logResult.success}`);
    if (logResult.error) {
      console.log(`Error: ${logResult.error}`);
    }
    console.log(`Run file created: ${runResult.exists}`);
    if (runResult.path) {
      console.log(`Run file: ${runResult.path}`);
    }
    console.log("===================\n");
    
    // Show recent logs
    if (logResult.logs.length > 0) {
      console.log("=== Recent Workflow Logs ===");
      logResult.logs.forEach(line => {
        if (line.includes("error")) {
          console.log("\x1b[31m" + line + "\x1b[0m"); // Red for errors
        } else if (line.includes("succeeded")) {
          console.log("\x1b[32m" + line + "\x1b[0m"); // Green for success
        } else {
          console.log(line);
        }
      });
      console.log("===========================\n");
    }
    
    // Show run file content
    if (runResult.exists && runResult.content) {
      console.log("=== Run File Content ===");
      console.log(runResult.content.slice(0, 1500));
      if (runResult.content.length > 1500) {
        console.log("... (truncated)");
      }
      console.log("========================\n");
    }
    
    // Cleanup
    await cleanup();
    
    // Close server
    server.close();
    
    const passed = logResult.success && runResult.exists;
    console.log(passed ? "\n✓ TEST PASSED" : "\n✗ TEST FAILED");
    process.exit(passed ? 0 : 1);
    
  } catch (error) {
    console.error("\nTest failed with error:", error);
    await cleanup();
    if (server) server.close();
    process.exit(1);
  }
}

main();
