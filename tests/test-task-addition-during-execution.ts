#!/usr/bin/env bun
/**
 * Integration test for adding tasks during workflow execution
 * 
 * Test scenarios:
 * 1. Basic Flow: Start workflow with 2 tasks, add 1 task during execution, verify only original 2 complete
 * 2. New task created during execution should remain in backlog after execution ends
 * 3. New task should run on next workflow start
 */

import { createOpencode } from "@opencode-ai/sdk";
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { KanbanDB } from "../src/db";
import { KanbanServer } from "../src/server";
import { Orchestrator } from "../src/orchestrator";

const TEST_DIR = process.cwd();
const TEST_ARTIFACTS = join(TEST_DIR, "tests", "artifacts");
const WORKFLOW_ROOT = join(TEST_ARTIFACTS, "kanban-task-addition");
const DB_PATH = join(WORKFLOW_ROOT, "tasks.db");
const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1";

// Test tasks - these will be in the initial execution snapshot
const TASK_A = {
  name: "Task A: Create file-a.txt",
  prompt: "Create a file named file-a.txt in the root directory with the content 'Hello from Task A!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: false,
  review: false,
  autoCommit: false,
  requirements: [],
};

const TASK_B = {
  name: "Task B: Create file-b.txt",
  prompt: "Create a file named file-b.txt in the root directory with the content 'Hello from Task B!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: false,
  review: false,
  autoCommit: false,
  requirements: [],
};

// Task to be added during execution
const TASK_C = {
  name: "Task C: Create file-c.txt",
  prompt: "Create a file named file-c.txt in the root directory with the content 'Hello from Task C!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: false,
  review: false,
  autoCommit: false,
  requirements: [],
};

// Test files
const TEST_FILES = [
  join(TEST_DIR, "file-a.txt"),
  join(TEST_DIR, "file-b.txt"),
  join(TEST_DIR, "file-c.txt"),
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
  
  if (CLEANUP_TEST_ARTIFACTS) {
    const dbFile = DB_PATH;
    if (existsSync(dbFile)) {
      unlinkSync(dbFile);
      console.log(`Deleted database: ${dbFile}`);
    }
    if (existsSync(WORKFLOW_ROOT)) {
      const { rmSync } = await import("fs");
      rmSync(WORKFLOW_ROOT, { recursive: true, force: true });
      console.log(`Deleted test directory: ${WORKFLOW_ROOT}`);
    }
  } else {
    console.log(`Preserving test artifacts in: ${WORKFLOW_ROOT}`);
  }
}

async function waitFor(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 500
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

interface TestResult {
  success: boolean;
  error?: string;
  details?: {
    taskACompleted: boolean;
    taskBCompleted: boolean;
    taskCCreatedDuringExecution: boolean;
    taskCStatusAfterFirstRun: string | null;
    taskCCompletedAfterSecondRun: boolean;
    allTasks: Array<{ id: string; name: string; status: string }>;
  };
}

async function main(): Promise<TestResult> {
  console.log("=== Task Addition During Execution Integration Test ===\n");
  
  let server: { url: string; close(): void } | null = null;
  let kanbanServer: KanbanServer | null = null;
  let kanbanDb: KanbanDB | null = null;
  let orchestrator: Orchestrator | null = null;
  let baselineWorktrees: Set<string> = new Set();
  
  try {
    mkdirSync(TEST_ARTIFACTS, { recursive: true });
    mkdirSync(WORKFLOW_ROOT, { recursive: true });
    
    // Pre-cleanup
    await cleanup();
    
    // Start OpenCode server
    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    baselineWorktrees = await listGitWorktrees();
    console.log(`Server started at ${server.url}`);
    
    // Initialize Kanban components
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
    
    // ===== PHASE 1: Create initial tasks (Task A and Task B) =====
    console.log("\n--- Phase 1: Creating initial tasks ---");
    
    const taskAResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TASK_A),
    });
    if (!taskAResponse.ok) {
      throw new Error(`Failed to create Task A: ${taskAResponse.statusText}`);
    }
    const taskA = await taskAResponse.json();
    console.log(`Created Task A: ${taskA.id}`);
    
    const taskBResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TASK_B),
    });
    if (!taskBResponse.ok) {
      throw new Error(`Failed to create Task B: ${taskBResponse.statusText}`);
    }
    const taskB = await taskBResponse.json();
    console.log(`Created Task B: ${taskB.id}`);
    
    // ===== PHASE 2: Start execution and add Task C during execution =====
    console.log("\n--- Phase 2: Starting execution and adding task during execution ---");
    
    // Start execution in background
    const executionPromise = (async () => {
      const response = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Failed to start execution: ${response.statusText}`);
      }
    })();
    
    // Wait for execution to start
    await waitFor(2000);
    
    // Check that Task A and Task B are being executed (not in backlog anymore)
    let taskAStatus = (await (await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${taskA.id}`)).json()).status;
    let taskBStatus = (await (await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${taskB.id}`)).json()).status;
    console.log(`During execution - Task A status: ${taskAStatus}, Task B status: ${taskBStatus}`);
    
    // Add Task C during execution
    console.log("\nAdding Task C during execution...");
    const taskCResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TASK_C),
    });
    if (!taskCResponse.ok) {
      throw new Error(`Failed to create Task C: ${taskCResponse.statusText}`);
    }
    const taskC = await taskCResponse.json();
    console.log(`Created Task C: ${taskC.id}`);
    
    // Wait for execution to complete (with timeout)
    console.log("\nWaiting for execution to complete...");
    const executionCompleted = await pollForCondition(
      () => !isExecuting,
      120000, // 2 minute timeout for execution
      1000
    );
    
    if (!executionCompleted) {
      console.log("Execution timed out, stopping...");
      if (orchestrator) orchestrator.stop();
      await waitFor(2000);
    }
    
    // ===== PHASE 3: Verify results =====
    console.log("\n--- Phase 3: Verifying results ---");
    
    // Check final task statuses
    const allTasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    const allTasks = await allTasksResponse.json();
    
    const finalTaskA = allTasks.find((t: any) => t.id === taskA.id);
    const finalTaskB = allTasks.find((t: any) => t.id === taskB.id);
    const finalTaskC = allTasks.find((t: any) => t.id === taskC.id);
    
    console.log(`\nFinal statuses:`);
    console.log(`  Task A: ${finalTaskA?.status}`);
    console.log(`  Task B: ${finalTaskB?.status}`);
    console.log(`  Task C: ${finalTaskC?.status}`);
    
    const taskACompleted = finalTaskA?.status === "done";
    const taskBCompleted = finalTaskB?.status === "done";
    const taskCCreatedDuringExecution = true;
    const taskCStatusAfterFirstRun = finalTaskC?.status;
    
    // Verify Task A and Task B completed
    if (!taskACompleted) {
      return {
        success: false,
        error: `Task A did not complete (status: ${finalTaskA?.status})`,
        details: {
          taskACompleted,
          taskBCompleted,
          taskCCreatedDuringExecution,
          taskCStatusAfterFirstRun,
          taskCCompletedAfterSecondRun: false,
          allTasks,
        },
      };
    }
    
    if (!taskBCompleted) {
      return {
        success: false,
        error: `Task B did not complete (status: ${finalTaskB?.status})`,
        details: {
          taskACompleted,
          taskBCompleted,
          taskCCreatedDuringExecution,
          taskCStatusAfterFirstRun,
          taskCCompletedAfterSecondRun: false,
          allTasks,
        },
      };
    }
    
    // Verify Task C was created during execution but did NOT run automatically
    if (taskCStatusAfterFirstRun !== "backlog") {
      return {
        success: false,
        error: `Task C should be in backlog after first execution, but is: ${taskCStatusAfterFirstRun}`,
        details: {
          taskACompleted,
          taskBCompleted,
          taskCCreatedDuringExecution,
          taskCStatusAfterFirstRun,
          taskCCompletedAfterSecondRun: false,
          allTasks,
        },
      };
    }
    
    console.log("\n✅ Phase 3 passed: Task C remained in backlog during first execution");
    
    // ===== PHASE 4: Start second execution and verify Task C runs =====
    console.log("\n--- Phase 4: Starting second execution to run Task C ---");
    
    const execution2Promise = (async () => {
      const response = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Failed to start second execution: ${response.statusText}`);
      }
    })();
    
    // Wait for second execution to complete
    await waitFor(2000);
    
    console.log("Waiting for second execution to complete...");
    const execution2Completed = await pollForCondition(
      () => !isExecuting,
      120000, // 2 minute timeout
      1000
    );
    
    if (!execution2Completed) {
      console.log("Second execution timed out, stopping...");
      if (orchestrator) orchestrator.stop();
      await waitFor(2000);
    }
    
    // Check Task C final status
    const finalTasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    const finalTasks = await finalTasksResponse.json();
    const finalTaskCStatus = finalTasks.find((t: any) => t.id === taskC.id);
    
    console.log(`\nTask C final status: ${finalTaskCStatus?.status}`);
    
    const taskCCompletedAfterSecondRun = finalTaskCStatus?.status === "done";
    
    if (!taskCCompletedAfterSecondRun) {
      return {
        success: false,
        error: `Task C did not complete after second execution (status: ${finalTaskCStatus?.status})`,
        details: {
          taskACompleted,
          taskBCompleted,
          taskCCreatedDuringExecution,
          taskCStatusAfterFirstRun,
          taskCCompletedAfterSecondRun,
          allTasks: finalTasks,
        },
      };
    }
    
    console.log("\n✅ Phase 4 passed: Task C completed on second execution");
    
    // ===== SUCCESS =====
    console.log("\n=== All tests passed! ===");
    
    // Cleanup worktrees created during test
    await cleanupNewWorktrees(baselineWorktrees);
    
    return {
      success: true,
      details: {
        taskACompleted,
        taskBCompleted,
        taskCCreatedDuringExecution,
        taskCStatusAfterFirstRun,
        taskCCompletedAfterSecondRun,
        allTasks: finalTasks,
      },
    };
    
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Test failed with error: ${message}`);
    
    // Try to cleanup worktrees on error
    try {
      await cleanupNewWorktrees(baselineWorktrees);
    } catch {
      // ignore cleanup errors
    }
    
    return {
      success: false,
      error: message,
    };
    
  } finally {
    // Cleanup
    if (kanbanServer) {
      kanbanServer.stop();
      console.log("\nKanban server stopped");
    }
    if (server) {
      server.close();
      console.log("OpenCode server stopped");
    }
    await cleanup();
  }
}

// Run the test
const result = await main();
process.exit(result.success ? 0 : 1);
