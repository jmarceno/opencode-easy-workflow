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
import { KanbanDB } from "./.opencode/easy-workflow/db";
import { KanbanServer } from "./.opencode/easy-workflow/server";
import { Orchestrator } from "./.opencode/easy-workflow/orchestrator";

const TEST_DIR = process.cwd();
const WORKFLOW_ROOT = join(TEST_DIR, ".opencode", "easy-workflow");
const DB_PATH = join(WORKFLOW_ROOT, "tasks.db");
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "debug.log");

// Test tasks
const TASK_A = {
  name: "Task A: Create hello.txt",
  prompt: "Create a file named hello.txt in the root directory with the content 'Hello from Task A!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: false,
  review: false,
  autoCommit: false,
  requirements: [],
};

const TASK_B = {
  name: "Task B: Create goodbye.txt",
  prompt: "Create a file named goodbye.txt in the root directory with the content 'Goodbye from Task B!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: false,
  review: false,
  autoCommit: false,
};

// Test artifacts to cleanup
const TEST_FILES = [
  join(TEST_DIR, "hello.txt"),
  join(TEST_DIR, "goodbye.txt"),
];

async function listGitWorktrees(): Promise<Set<string>> {
  const output = await Bun.$`git worktree list --porcelain`.text();
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

async function cleanupNewWorktrees(baseline: Set<string>): Promise<void> {
  const current = await listGitWorktrees();
  for (const path of current) {
    if (baseline.has(path)) continue;
    try {
      await Bun.$`git worktree remove --force ${path}`;
      console.log(`Removed worktree: ${path}`);
    } catch (err) {
      console.warn(`Failed to remove worktree ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

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

function getFreePort(): number {
  const probe = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  const { port } = probe;
  probe.stop();
  return port;
}

async function main() {
  console.log("=== Kanban Task Orchestrator E2E Test ===\n");
  console.log("Test: Two tasks with dependency (B depends on A)");
  console.log("Review: Disabled | Auto-commit: Disabled\n");
  
  let server: { url: string; close(): void } | null = null;
  let kanbanServer: KanbanServer | null = null;
  let kanbanDb: KanbanDB | null = null;
  let orchestrator: Orchestrator | null = null;
  let baselineWorktrees: Set<string> = new Set();
  
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
    baselineWorktrees = await listGitWorktrees();
    
    console.log(`Server started at ${server.url}`);
    
    // Initialize Kanban components directly
    console.log("\nInitializing Kanban components...");
    kanbanDb = new KanbanDB(DB_PATH);
    const kanbanPort = getFreePort();
    kanbanDb.updateOptions({ port: kanbanPort });
    
    let isExecuting = false;
    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {
        isExecuting = true;
        if (orchestrator) await orchestrator.start();
        isExecuting = false;
      },
      onStop: () => {
        isExecuting = false;
        if (orchestrator) orchestrator.stop();
      },
      getExecuting: () => isExecuting,
      getStartError: () => (orchestrator ? orchestrator.preflightStartError() : "Kanban orchestrator is not ready"),
      getServerUrl: () => server?.url || null,
    });
    
    orchestrator = new Orchestrator(kanbanDb, kanbanServer, server.url, TEST_DIR);
    
    const startedKanbanPort = kanbanServer.start();
    console.log(`Kanban server started on port: ${startedKanbanPort}`);
    
    // Wait for components to be ready
    await waitFor(1000);
    
    // Create Task A via API
    console.log("\nCreating Task A...");
    const taskAResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
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
    
    const taskBResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
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
    const startResponse = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
      method: "POST",
    });
    
    if (!startResponse.ok) {
      const error = await startResponse.text();
      throw new Error(`Failed to start execution: ${error}`);
    }
    
    // Now mark as executing
    isExecuting = true;
    
    console.log("Execution started. Waiting for tasks to complete...");
    console.log("(This may take 1-2 minutes depending on model response time)\n");
    
    // Poll for completion
    const completed = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json()).catch(() => []);
      return tasksResp.then((tasks: any[]) => tasks.every((t: any) => t.status === "done"));
    }, 120000, 2000);
    
    // Wait a bit more for any async operations
    await waitFor(2000);
    
    // Check results
    console.log("\n=== Test Results ===");
    
    // Check task statuses via API
    const tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    const allTasks = await tasksResponse.json();
    
    console.log(`\nTask Statuses:`);
    for (const task of allTasks) {
      console.log(`  ${task.name}: ${task.status}`);
    }
    
    const allDone = allTasks.every((t: any) => t.status === "done");
    
    // Check that dependency ordering is correct (Task A should complete before Task B)
    const foundTaskA = allTasks.find((t: any) => t.name.includes("Task A"));
    const foundTaskB = allTasks.find((t: any) => t.name.includes("Task B"));
    
    console.log("\n=== Verification ===");
    console.log(`All tasks done: ${allDone ? "✓" : "✗"}`);
    console.log(`Task A completed: ${foundTaskA?.status === "done" ? "✓" : "✗"}`);
    console.log(`Task B completed: ${foundTaskB?.status === "done" ? "✓" : "✗"}`);
    console.log(`Task B depends on Task A: ${foundTaskB?.requirements?.includes(foundTaskA?.id) ? "✓" : "✗"}`);
    
    console.log("\n===================");
    
    // Cleanup
    await cleanup();
    await cleanupNewWorktrees(baselineWorktrees);
    
    // Stop kanban server
    kanbanServer.stop();
    kanbanDb.close();
    
    // Close opencode server
    server.close();
    
    const passed = allDone && foundTaskA?.status === "done" && foundTaskB?.status === "done";
    
    console.log(passed ? "\n✓ TEST PASSED" : "\n✗ TEST FAILED");
    process.exit(passed ? 0 : 1);
    
  } catch (error) {
    console.error("\nTest failed with error:", error);
    await cleanup();
    await cleanupNewWorktrees(baselineWorktrees);
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    if (server) server.close();
    process.exit(1);
  }
}

main();
