#!/usr/bin/env bun
/**
 * End-to-end test for the Kanban Task Orchestrator
 * Creates two tasks with dependency: Task B depends on Task A
 * Both have review and auto-commit disabled for simplicity
 * Uses opencode-go/kimi-k2.5 model for all tasks
 */

import { createOpencode } from "@opencode-ai/sdk";
import { existsSync, unlinkSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = process.cwd();
const WORKFLOW_ROOT = join(TEST_DIR, ".opencode", "easy-workflow");
const DB_PATH = join(WORKFLOW_ROOT, "tasks.db");
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "debug.log");

// Test tasks
const TASK_A = {
  name: "Task A: Create hello.txt",
  prompt: "Create a file named hello.txt in the root directory with the content 'Hello from Task A!'",
  planModel: "opencode-go/kimi-k2.5",
  executionModel: "opencode-go/kimi-k2.5",
  planmode: false,
  review: false,
  autoCommit: false,
  requirements: [],
};

const TASK_B = {
  name: "Task B: Create goodbye.txt",
  prompt: "Create a file named goodbye.txt in the root directory with the content 'Goodbye from Task B!'",
  planModel: "opencode-go/kimi-k2.5",
  executionModel: "opencode-go/kimi-k2.5",
  planmode: false,
  review: false,
  autoCommit: false,
};

// Test artifacts to cleanup
const TEST_FILES = [
  join(TEST_DIR, "hello.txt"),
  join(TEST_DIR, "goodbye.txt"),
];

async function cleanup() {
  console.log("\nCleaning up test artifacts...");
  
  // Remove test files
  for (const file of TEST_FILES) {
    if (existsSync(file)) {
      unlinkSync(file);
      console.log(`Deleted ${file}`);
    }
  }
  
  // Clean database
  if (existsSync(DB_PATH)) {
    try {
      const { KanbanDB } = await import("../.opencode/easy-workflow/db.ts");
      const db = new KanbanDB(DB_PATH);
      const tasks = db.getTasks();
      for (const task of tasks) {
        db.deleteTask(task.id);
      }
      db.close();
      console.log("Cleaned up test tasks from database");
    } catch (e) {
      console.log("Note: Could not clean database (may not exist yet)");
    }
  }
}

function checkDebugLogs(): { 
  success: boolean; 
  logs: string[]; 
  taskACompleted: boolean;
  taskBCompleted: boolean;
  error?: string;
} {
  if (!existsSync(DEBUG_LOG_PATH)) {
    return { 
      success: false, 
      logs: [], 
      taskACompleted: false, 
      taskBCompleted: false,
      error: "Debug log not found" 
    };
  }

  const logContent = readFileSync(DEBUG_LOG_PATH, "utf-8");
  const lines = logContent.split("\n");
  
  // Get logs from this test run
  const recentLogs: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes("kanban server started") || line.includes("workflow plugin initialized")) {
      break;
    }
    recentLogs.unshift(line);
  }
  
  const taskACompleted = recentLogs.some(line => 
    line.includes("task completed") && line.includes("Task A")
  );
  const taskBCompleted = recentLogs.some(line => 
    line.includes("task completed") && line.includes("Task B")
  );
  const hasError = recentLogs.some(line => 
    line.includes("error") && !line.includes("kanban initialization failed")
  );
  
  return { 
    success: taskACompleted && taskBCompleted && !hasError, 
    logs: recentLogs,
    taskACompleted,
    taskBCompleted,
    error: hasError ? "Errors found in logs" : undefined
  };
}

function checkTestFiles(): {
  taskAFileExists: boolean;
  taskBFileExists: boolean;
  taskAContent: string | null;
  taskBContent: string | null;
} {
  const helloPath = TEST_FILES[0];
  const goodbyePath = TEST_FILES[1];
  
  return {
    taskAFileExists: existsSync(helloPath),
    taskBFileExists: existsSync(goodbyePath),
    taskAContent: existsSync(helloPath) ? readFileSync(helloPath, "utf-8") : null,
    taskBContent: existsSync(goodbyePath) ? readFileSync(goodbyePath, "utf-8") : null,
  };
}

async function waitFor(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 1000
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await waitFor(intervalMs);
  }
  return false;
}

async function main() {
  console.log("=== Kanban Task Orchestrator E2E Test ===\n");
  console.log("Test: Two tasks with dependency (B depends on A)");
  console.log("Review: Disabled | Auto-commit: Disabled\n");
  
  let server: { url: string; close(): void } | null = null;
  
  try {
    // Pre-cleanup
    await cleanup();
    
    // Clear old debug log
    if (existsSync(DEBUG_LOG_PATH)) {
      unlinkSync(DEBUG_LOG_PATH);
    }
    
    // Start OpenCode server
    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    const client = opencode.client;
    
    console.log(`Server started at ${server.url}`);
    
    // Wait for plugin to initialize
    console.log("\nWaiting for kanban plugin to initialize...");
    await waitFor(2000);
    
    // Get kanban server port from logs or use default
    let kanbanPort = 3789;
    if (existsSync(DEBUG_LOG_PATH)) {
      const logContent = readFileSync(DEBUG_LOG_PATH, "utf-8");
      const portMatch = logContent.match(/kanban server started.*port["']?\s*[:=]\s*(\d+)/i);
      if (portMatch) {
        kanbanPort = parseInt(portMatch[1], 10);
      }
    }
    
    console.log(`Kanban server expected on port: ${kanbanPort}`);
    
    // Create Task A via API
    console.log("\nCreating Task A...");
    const taskAResponse = await fetch(`http://localhost:${kanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TASK_A),
    });
    
    if (!taskAResponse.ok) {
      throw new Error(`Failed to create Task A: ${taskAResponse.statusText}`);
    }
    
    const taskA = await taskAResponse.json();
    console.log(`Created Task A: ${taskA.id} - ${taskA.name}`);
    
    // Create Task B with dependency on Task A
    console.log("\nCreating Task B (depends on Task A)...");
    const taskBWithDep = {
      ...TASK_B,
      requirements: [taskA.id],
    };
    
    const taskBResponse = await fetch(`http://localhost:${kanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskBWithDep),
    });
    
    if (!taskBResponse.ok) {
      throw new Error(`Failed to create Task B: ${taskBResponse.statusText}`);
    }
    
    const taskB = await taskBResponse.json();
    console.log(`Created Task B: ${taskB.id} - ${taskB.name}`);
    console.log(`Dependencies: ${taskB.requirements.join(", ")}`);
    
    // Start execution
    console.log("\nStarting task execution...");
    const startResponse = await fetch(`http://localhost:${kanbanPort}/api/start`, {
      method: "POST",
    });
    
    if (!startResponse.ok) {
      const error = await startResponse.text();
      throw new Error(`Failed to start execution: ${error}`);
    }
    
    console.log("Execution started. Waiting for tasks to complete...");
    console.log("(This may take 1-2 minutes depending on model response time)\n");
    
    // Poll for completion
    const completed = await pollForCondition(() => {
      const check = checkDebugLogs();
      return check.taskACompleted && check.taskBCompleted;
    }, 120000, 2000);
    
    // Wait a bit more for file writes
    await waitFor(2000);
    
    // Check results
    console.log("\n=== Test Results ===");
    
    const logResult = checkDebugLogs();
    const fileResult = checkTestFiles();
    
    console.log(`\nLog Status:`);
    console.log(`  Task A completed: ${logResult.taskACompleted ? "✓" : "✗"}`);
    console.log(`  Task B completed: ${logResult.taskBCompleted ? "✓" : "✗"}`);
    if (logResult.error) {
      console.log(`  Error: ${logResult.error}`);
    }
    
    console.log(`\nFile Verification:`);
    console.log(`  hello.txt exists: ${fileResult.taskAFileExists ? "✓" : "✗"}`);
    console.log(`  goodbye.txt exists: ${fileResult.taskBFileExists ? "✓" : "✗"}`);
    
    if (fileResult.taskAContent) {
      console.log(`  hello.txt content: "${fileResult.taskAContent.trim()}"`);
    }
    if (fileResult.taskBContent) {
      console.log(`  goodbye.txt content: "${fileResult.taskBContent.trim()}"`);
    }
    
    // Check task statuses via API
    const tasksResponse = await fetch(`http://localhost:${kanbanPort}/api/tasks`);
    const tasks = await tasksResponse.json();
    
    console.log(`\nTask Statuses:`);
    for (const task of tasks) {
      console.log(`  ${task.name}: ${task.status}`);
    }
    
    const allDone = tasks.every((t: any) => t.status === "done");
    
    console.log("\n===================");
    
    // Show recent logs
    if (logResult.logs.length > 0) {
      console.log("\n=== Recent Orchestrator Logs ===");
      logResult.logs.slice(-20).forEach(line => {
        if (line.includes("error")) {
          console.log("\x1b[31m" + line + "\x1b[0m");
        } else if (line.includes("completed")) {
          console.log("\x1b[32m" + line + "\x1b[0m");
        } else if (line.trim()) {
          console.log(line);
        }
      });
      console.log("================================\n");
    }
    
    // Cleanup
    await cleanup();
    
    // Close server
    server.close();
    
    const passed = allDone && 
                   logResult.taskACompleted && 
                   logResult.taskBCompleted &&
                   fileResult.taskAFileExists && 
                   fileResult.taskBFileExists;
    
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
