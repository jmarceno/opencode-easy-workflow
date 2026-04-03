#!/usr/bin/env bun
/**
 * End-to-end test for the Kanban Task Orchestrator
 * Creates two tasks with dependency: Task B depends on Task A
 * Both have review and auto-commit disabled for simplicity
 * Uses opencode-go/kimi-k2.5 model for all tasks
 */

import { createOpencode } from "@opencode-ai/sdk";
import { existsSync, mkdirSync, unlinkSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { KanbanDB } from "../.opencode/easy-workflow/db";
import { KanbanServer } from "../.opencode/easy-workflow/server";
import { Orchestrator } from "../.opencode/easy-workflow/orchestrator";

const TEST_DIR = process.cwd();
const WORKFLOW_ROOT = join(TEST_DIR, ".opencode", "easy-workflow");
const TEST_ARTIFACTS = join(WORKFLOW_ROOT, "test-artifacts");
const DB_PATH = join(TEST_ARTIFACTS, "tasks.db");
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "debug.log");
const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1";

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

// Plan-mode test task
const PLAN_TASK = {
  name: "Plan Task: Create readme.txt",
  prompt: "Create a file named readme.txt in the root directory with the content 'Hello from Plan Task!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: true,
  review: false,
  autoCommit: false,
  requirements: [],
};

// Plan-mode task with dependency
const PLAN_TASK_WITH_DEPS = {
  name: "Plan Task with Deps: Create deps.txt",
  prompt: "Create a file named deps.txt in the root directory with the content 'Depends on Plan Task!'",
  planModel: "default",
  executionModel: "minimax/minimax-m2.7",
  planmode: true,
  review: false,
  autoCommit: false,
};

// Test artifacts to cleanup
const TEST_FILES = [
  join(TEST_DIR, "hello.txt"),
  join(TEST_DIR, "goodbye.txt"),
  join(TEST_DIR, "readme.txt"),
  join(TEST_DIR, "deps.txt"),
  join(TEST_DIR, "single-start-dependency.txt"),
  join(TEST_DIR, "single-start-target.txt"),
  join(TEST_DIR, "single-start-unrelated.txt"),
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
  
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${DB_PATH} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`);
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
    mkdirSync(TEST_ARTIFACTS, { recursive: true });
    
    // Pre-cleanup
    await cleanup();
    
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
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
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

async function testPlanModeApprovalWorkflow() {
console.log("\n\n=== Plan-Mode Approval Workflow Test ===\n");
  console.log("Test: Plan-mode task stops in review awaiting approval, then resumes after approval\n");
  
  let server: { url: string; close(): void } | null = null;
  let kanbanServer: KanbanServer | null = null;
  let kanbanDb: KanbanDB | null = null;
  let orchestrator: Orchestrator | null = null;
  let baselineWorktrees: Set<string> = new Set();
  
  try {
    await cleanup();
    
    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    baselineWorktrees = await listGitWorktrees();
    console.log(`Server started at ${server.url}`);

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
    
    await waitFor(1000);
    
    // Create plan-mode task
    console.log("\nCreating Plan Task...");
    const planTaskResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PLAN_TASK),
    });
    
    if (!planTaskResponse.ok) {
      throw new Error(`Failed to create Plan Task: ${planTaskResponse.statusText}`);
    }
    
    const planTask = await planTaskResponse.json();
    console.log(`Created Plan Task: ${planTask.id} - ${planTask.name}`);
    console.log(`  planmode: ${planTask.planmode}`);
    console.log(`  executionPhase: ${planTask.executionPhase}`);
    
    // Start execution - should stop after planning phase
    console.log("\nStarting task execution (should stop after planning)...");
    const startResponse = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
      method: "POST",
    });
    
    if (!startResponse.ok) {
      const error = await startResponse.text();
      throw new Error(`Failed to start execution: ${error}`);
    }
    
    isExecuting = true;
    
    // Poll for plan task to be in review with awaiting approval
    const planAwaitingApproval = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "review" && pt?.awaitingPlanApproval === true;
      });
    }, 60000, 2000);
    
    await waitFor(2000);
    
    // Check that plan task is in review awaiting approval
    let tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    let tasks = await tasksResponse.json();
    let foundPlanTask = tasks.find((t: any) => t.id === planTask.id);
    
    console.log("\n=== Phase 1: Plan Completion ===");
    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Awaiting Plan Approval: ${foundPlanTask?.awaitingPlanApproval}`);
    console.log(`Execution Phase: ${foundPlanTask?.executionPhase}`);
    
    if (!planAwaitingApproval || foundPlanTask?.status !== "review" || !foundPlanTask?.awaitingPlanApproval) {
      throw new Error(`Plan task did not enter awaiting approval state. Status: ${foundPlanTask?.status}, awaitingApproval: ${foundPlanTask?.awaitingPlanApproval}`);
    }
    console.log("✓ Plan task is in review awaiting approval");
    
    // Approve the plan
    console.log("\n=== Phase 2: Approving Plan ===");
    const approveResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
    });
    
    if (!approveResponse.ok) {
      const error = await approveResponse.text();
      throw new Error(`Failed to approve plan: ${error}`);
    }
    console.log("Plan approved via API");
    
    await waitFor(1000);
    
    // Check task is now eligible for implementation
    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);
    
    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Execution Phase: ${foundPlanTask?.executionPhase}`);
    console.log(`Awaiting Plan Approval: ${foundPlanTask?.awaitingPlanApproval}`);
    
    const approvedForImplementation = foundPlanTask?.executionPhase === "implementation_pending"
      || foundPlanTask?.executionPhase === "implementation_done";
    const implementationResumed = ["backlog", "executing", "done"].includes(foundPlanTask?.status);
    if (!approvedForImplementation || !implementationResumed || foundPlanTask?.awaitingPlanApproval) {
      throw new Error(`Plan approval did not transition correctly. Status: ${foundPlanTask?.status}, phase: ${foundPlanTask?.executionPhase}`);
    }
    console.log("✓ Plan transitioned to implementation_pending");
    
    // Wait for task to complete (it should resume execution)
    console.log("\n=== Phase 3: Implementation ===");
    console.log("Waiting for implementation to complete...");
    
    const implementationComplete = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "done";
      });
    }, 120000, 2000);
    
    await waitFor(2000);
    
    // Final check
    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);
    
    console.log("\n=== Final Results ===");
    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Execution Phase: ${foundPlanTask?.executionPhase}`);
    
    // Cleanup
    await cleanup();
    await cleanupNewWorktrees(baselineWorktrees);
    kanbanServer.stop();
    kanbanDb.close();
    server.close();
    
    if (!implementationComplete || foundPlanTask?.status !== "done" || foundPlanTask?.executionPhase !== "implementation_done") {
      console.log("\n✗ TEST FAILED: Plan task did not complete");
      process.exit(1);
    }
    
    // Verify file was created
    const readmePath = join(TEST_DIR, "readme.txt");
    if (!existsSync(readmePath)) {
      console.log("\n✗ TEST FAILED: readme.txt was not created");
      process.exit(1);
    }
    
    const readmeContent = readFileSync(readmePath, "utf-8");
    console.log(`readme.txt content: ${readmeContent}`);
    
    console.log("\n✓ TEST PASSED");
    process.exit(0);
    
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

async function testPlanModeWithDependencies() {
  console.log("\n\n=== Plan-Mode with Dependencies Test ===\n");
  console.log("Test: Dependencies stay blocked until plan approval and implementation completion\n");
  
  let server: { url: string; close(): void } | null = null;
  let kanbanServer: KanbanServer | null = null;
  let kanbanDb: KanbanDB | null = null;
  let orchestrator: Orchestrator | null = null;
  let baselineWorktrees: Set<string> = new Set();
  
  try {
    await cleanup();
    
    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    baselineWorktrees = await listGitWorktrees();
    console.log(`Server started at ${server.url}`);
    
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
    
    await waitFor(1000);
    
    // Create plan-mode task (dependency)
    console.log("\nCreating Plan Task (dependency)...");
    const planTaskResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PLAN_TASK),
    });
    
    if (!planTaskResponse.ok) {
      throw new Error(`Failed to create Plan Task: ${planTaskResponse.statusText}`);
    }
    
    const planTask = await planTaskResponse.json();
    console.log(`Created Plan Task: ${planTask.id} - ${planTask.name}`);
    
    // Create plan-mode task with dependency on first plan task
    console.log("\nCreating Dependent Plan Task...");
    const depTaskWithDep = {
      ...PLAN_TASK_WITH_DEPS,
      requirements: [planTask.id],
    };
    
    const depTaskResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(depTaskWithDep),
    });
    
    if (!depTaskResponse.ok) {
      throw new Error(`Failed to create Dependent Plan Task: ${depTaskResponse.statusText}`);
    }
    
    const depTask = await depTaskResponse.json();
    console.log(`Created Dependent Plan Task: ${depTask.id} - ${depTask.name}`);
    console.log(`Dependencies: ${depTask.requirements.join(", ")}`);
    
    // Start execution - should stop first plan task in review
    console.log("\nStarting task execution...");
    const startResponse = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
      method: "POST",
    });
    
    if (!startResponse.ok) {
      const error = await startResponse.text();
      throw new Error(`Failed to start execution: ${error}`);
    }
    
    isExecuting = true;
    
    // Wait for first plan task to be in review awaiting approval
    const planAwaitingApproval = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "review" && pt?.awaitingPlanApproval === true;
      });
    }, 60000, 2000);
    
    await waitFor(2000);
    
    // Check statuses - dependent task should still be in backlog (blocked)
    let tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    let tasks = await tasksResponse.json();
    let foundPlanTask = tasks.find((t: any) => t.id === planTask.id);
    let foundDepTask = tasks.find((t: any) => t.id === depTask.id);
    
    console.log("\n=== Phase 1: First Task Awaiting Approval ===");
    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Dependent Task Status: ${foundDepTask?.status}`);
    
    if (foundDepTask?.status !== "backlog") {
      throw new Error(`Dependent task should be in backlog, but is: ${foundDepTask?.status}`);
    }
    console.log("✓ Dependent task stays in backlog (blocked)");
    
    // Approve the first plan
    console.log("\n=== Phase 2: Approving First Plan ===");
    const approveResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
    });
    
    if (!approveResponse.ok) {
      throw new Error(`Failed to approve plan`);
    }
    
    // Wait for first task to complete
    console.log("Waiting for first task to complete...");
    const firstComplete = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "done";
      });
    }, 120000, 2000);
    
    await waitFor(2000);
    
    // Check that dependent task now enters its own approval state
    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);
    foundDepTask = tasks.find((t: any) => t.id === depTask.id);
    
    console.log("\n=== Phase 3: First Task Complete ===");
    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Dependent Task Status: ${foundDepTask?.status}`);
    
    if (foundPlanTask?.status !== "done") {
      throw new Error(`First task should be done, but is: ${foundPlanTask?.status}`);
    }

    const dependentAwaitingApproval = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((taskList: any[]) => {
        const dependent = taskList.find((t: any) => t.id === depTask.id);
        return dependent?.status === "review" && dependent?.awaitingPlanApproval === true;
      });
    }, 60000, 2000);

    if (!dependentAwaitingApproval) {
      throw new Error(`Dependent task did not enter plan approval state. Status: ${foundDepTask?.status}, awaitingApproval: ${foundDepTask?.awaitingPlanApproval}`);
    }

    console.log("✓ First task completed, dependent task is now awaiting plan approval");
    
    // Cleanup
    await cleanup();
    await cleanupNewWorktrees(baselineWorktrees);
    kanbanServer.stop();
    kanbanDb.close();
    server.close();
    
    console.log("\n✓ TEST PASSED");
    process.exit(0);
    
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

async function testPlanModeRevisionLoop() {
  console.log("\n\n=== Plan-Mode Revision Loop E2E Test ===\n");
  console.log("Test: Plan → Request Revision → Revised Plan → Approve → Implement\n");

  let server: { url: string; close(): void } | null = null;
  let kanbanServer: KanbanServer | null = null;
  let kanbanDb: KanbanDB | null = null;
  let orchestrator: Orchestrator | null = null;
  let baselineWorktrees: Set<string> = new Set();

  try {
    await cleanup();

    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    baselineWorktrees = await listGitWorktrees();
    console.log(`Server started at ${server.url}`);

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

    await waitFor(1000);

    // Create plan-mode task
    console.log("\nCreating Plan-Mode Task...");
    const planTaskResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PLAN_TASK),
    });

    if (!planTaskResponse.ok) {
      throw new Error(`Failed to create Plan Task: ${planTaskResponse.statusText}`);
    }

    const planTask = await planTaskResponse.json();
    console.log(`Created Plan Task: ${planTask.id} - ${planTask.name}`);

    // Phase 1: Run orchestrator → plan generated → task in review
    console.log("\n=== Phase 1: Initial Planning ===");
    console.log("Starting execution to generate initial plan...");
    const startResponse = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
      method: "POST",
    });

    if (!startResponse.ok) {
      throw new Error(`Failed to start execution: ${await startResponse.text()}`);
    }

    isExecuting = true;

    const planGenerated = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "review" && pt?.awaitingPlanApproval === true;
      });
    }, 60000, 2000);

    await waitFor(2000);

    let tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    let tasks = await tasksResponse.json();
    let foundPlanTask = tasks.find((t: any) => t.id === planTask.id);

    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Awaiting Plan Approval: ${foundPlanTask?.awaitingPlanApproval}`);
    console.log(`Execution Phase: ${foundPlanTask?.executionPhase}`);
    console.log(`Plan Revision Count: ${foundPlanTask?.planRevisionCount}`);

    if (!planGenerated || foundPlanTask?.status !== "review" || !foundPlanTask?.awaitingPlanApproval) {
      throw new Error(`Plan task did not enter awaiting approval state. Status: ${foundPlanTask?.status}`);
    }
    console.log("✓ Initial plan generated, task in review");

    // Phase 2: Request revision via API
    console.log("\n=== Phase 2: Requesting Plan Revision ===");
    const revisionResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${planTask.id}/request-plan-revision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Please add more detail about error handling" }),
    });

    if (!revisionResponse.ok) {
      throw new Error(`Failed to request revision: ${await revisionResponse.text()}`);
    }
    console.log("Revision requested successfully");

    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);

    console.log(`After Revision Request — Status: ${foundPlanTask?.status}, Phase: ${foundPlanTask?.executionPhase}, RevCount: ${foundPlanTask?.planRevisionCount}`);

    if (foundPlanTask?.executionPhase !== "plan_revision_pending") {
      throw new Error(`Expected plan_revision_pending, got ${foundPlanTask?.executionPhase}`);
    }
    if (foundPlanTask?.planRevisionCount !== 1) {
      throw new Error(`Expected planRevisionCount=1, got ${foundPlanTask?.planRevisionCount}`);
    }
    console.log("✓ Task transitioned to plan_revision_pending with count=1");

    // Phase 3: Run orchestrator again → revised plan generated → task back in review
    console.log("\n=== Phase 3: Re-Planning with Feedback ===");
    isExecuting = true;
    const startResponse2 = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
      method: "POST",
    });

    if (!startResponse2.ok) {
      throw new Error(`Failed to restart execution: ${await startResponse2.text()}`);
    }

    const revisedPlanGenerated = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "review" && pt?.awaitingPlanApproval === true && pt?.executionPhase === "plan_complete_waiting_approval";
      });
    }, 60000, 2000);

    await waitFor(2000);

    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);

    console.log(`After Re-Plan — Status: ${foundPlanTask?.status}, Phase: ${foundPlanTask?.executionPhase}, RevCount: ${foundPlanTask?.planRevisionCount}`);

    if (!revisedPlanGenerated) {
      throw new Error(`Revised plan was not generated. Status: ${foundPlanTask?.status}, Phase: ${foundPlanTask?.executionPhase}`);
    }
    console.log("✓ Revised plan generated, task back in review");

    // Phase 4: Approve via API
    console.log("\n=== Phase 4: Approving Revised Plan ===");
    const approveResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${planTask.id}/approve-plan`, {
      method: "POST",
    });

    if (!approveResponse.ok) {
      throw new Error(`Failed to approve revised plan: ${await approveResponse.text()}`);
    }
    console.log("Revised plan approved");

    await waitFor(1000);

    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);

    console.log(`After Approval — Status: ${foundPlanTask?.status}, Phase: ${foundPlanTask?.executionPhase}`);

    const approvedForImplementation = foundPlanTask?.executionPhase === "implementation_pending"
      || foundPlanTask?.executionPhase === "implementation_done";
    if (!approvedForImplementation) {
      throw new Error(`Plan approval did not transition to implementation. Phase: ${foundPlanTask?.executionPhase}`);
    }
    console.log("✓ Task transitioned to implementation");

    // Phase 5: Run orchestrator → implementation runs → task done
    console.log("\n=== Phase 5: Implementation ===");
    isExecuting = true;
    const startResponse3 = await fetch(`http://localhost:${startedKanbanPort}/api/start`, {
      method: "POST",
    });

    if (!startResponse3.ok) {
      throw new Error(`Failed to start implementation: ${await startResponse3.text()}`);
    }

    const implementationComplete = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then(r => r.json());
      return tasksResp.then((tasks: any[]) => {
        const pt = tasks.find((t: any) => t.id === planTask.id);
        return pt?.status === "done";
      });
    }, 120000, 2000);

    await waitFor(2000);

    tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    tasks = await tasksResponse.json();
    foundPlanTask = tasks.find((t: any) => t.id === planTask.id);

    console.log(`\n=== Final Results ===`);
    console.log(`Plan Task Status: ${foundPlanTask?.status}`);
    console.log(`Execution Phase: ${foundPlanTask?.executionPhase}`);
    console.log(`Plan Revision Count: ${foundPlanTask?.planRevisionCount}`);

    // Cleanup
    await cleanup();
    await cleanupNewWorktrees(baselineWorktrees);
    kanbanServer.stop();
    kanbanDb.close();
    server.close();

    if (!implementationComplete || foundPlanTask?.status !== "done") {
      console.log("\n✗ TEST FAILED: Plan task did not complete after revision loop");
      process.exit(1);
    }

    // Verify file was created
    const readmePath = join(TEST_DIR, "readme.txt");
    if (!existsSync(readmePath)) {
      console.log("\n✗ TEST FAILED: readme.txt was not created during implementation");
      process.exit(1);
    }

    const readmeContent = readFileSync(readmePath, "utf-8");
    console.log(`readme.txt content: ${readmeContent}`);

    console.log("\n✓ TEST PASSED: Full revision loop completed successfully");
    process.exit(0);

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

async function testSingleTaskStartWithDependencies() {
  console.log("\n\n=== Single Task Start With Dependencies Test ===\n");
  console.log("Test: Start one task and run only its unresolved dependencies\n");

  let server: { url: string; close(): void } | null = null;
  let kanbanServer: KanbanServer | null = null;
  let kanbanDb: KanbanDB | null = null;
  let orchestrator: Orchestrator | null = null;
  let baselineWorktrees: Set<string> = new Set();

  try {
    await cleanup();

    if (existsSync(DEBUG_LOG_PATH)) {
      unlinkSync(DEBUG_LOG_PATH);
    }

    console.log("Starting OpenCode server...");
    const opencode = await createOpencode({ port: 0 });
    server = opencode.server;
    baselineWorktrees = await listGitWorktrees();
    console.log(`Server started at ${server.url}`);

    console.log("\nInitializing Kanban components...");
    kanbanDb = new KanbanDB(DB_PATH);
    const kanbanPort = getFreePort();
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 2 });

    let isExecuting = false;
    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {
        isExecuting = true;
        if (orchestrator) await orchestrator.start();
        isExecuting = false;
      },
      onStartSingle: async (taskId: string) => {
        isExecuting = true;
        if (orchestrator) await orchestrator.startSingle(taskId);
        isExecuting = false;
      },
      onStop: () => {
        isExecuting = false;
        if (orchestrator) orchestrator.stop();
      },
      getExecuting: () => isExecuting,
      getStartError: (taskId?: string) => (orchestrator ? orchestrator.preflightStartError(taskId) : "Kanban orchestrator is not ready"),
      getServerUrl: () => server?.url || null,
    });

    orchestrator = new Orchestrator(kanbanDb, kanbanServer, server.url, TEST_DIR);

    const startedKanbanPort = kanbanServer.start();
    console.log(`Kanban server started on port: ${startedKanbanPort}`);

    await waitFor(1000);

    const dependencyTaskPayload = {
      name: "Single Start Dependency Task",
      prompt: "Create a file named single-start-dependency.txt in the root directory with the exact content 'single-start dependency'.",
      branch: "master",
      planModel: "default",
      executionModel: "minimax/minimax-m2.7",
      planmode: false,
      review: false,
      autoCommit: false,
      requirements: [],
    };

    const dependencyResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dependencyTaskPayload),
    });
    if (!dependencyResponse.ok) {
      throw new Error(`Failed to create dependency task: ${dependencyResponse.statusText}`);
    }
    const dependencyTask = await dependencyResponse.json();

    const targetTaskPayload = {
      name: "Single Start Target Task",
      prompt: "Create a file named single-start-target.txt in the root directory with the exact content 'single-start target'.",
      branch: "master",
      planModel: "default",
      executionModel: "minimax/minimax-m2.7",
      planmode: false,
      review: false,
      autoCommit: false,
      requirements: [dependencyTask.id],
    };

    const targetResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetTaskPayload),
    });
    if (!targetResponse.ok) {
      throw new Error(`Failed to create target task: ${targetResponse.statusText}`);
    }
    const targetTask = await targetResponse.json();

    const unrelatedTaskPayload = {
      name: "Single Start Unrelated Task",
      prompt: "Create a file named single-start-unrelated.txt in the root directory with the exact content 'single-start unrelated'.",
      branch: "master",
      planModel: "default",
      executionModel: "minimax/minimax-m2.7",
      planmode: false,
      review: false,
      autoCommit: false,
      requirements: [],
    };

    const unrelatedResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(unrelatedTaskPayload),
    });
    if (!unrelatedResponse.ok) {
      throw new Error(`Failed to create unrelated task: ${unrelatedResponse.statusText}`);
    }
    const unrelatedTask = await unrelatedResponse.json();

    const startSelectedResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks/${targetTask.id}/start`, {
      method: "POST",
    });
    if (!startSelectedResponse.ok) {
      const error = await startSelectedResponse.text();
      throw new Error(`Failed to start selected task execution: ${error}`);
    }

    const reachedExpectedState = await pollForCondition(() => {
      const tasksResp = fetch(`http://localhost:${startedKanbanPort}/api/tasks`).then((r) => r.json()).catch(() => []);
      return tasksResp.then((tasks: any[]) => {
        const dep = tasks.find((t: any) => t.id === dependencyTask.id);
        const target = tasks.find((t: any) => t.id === targetTask.id);
        const unrelated = tasks.find((t: any) => t.id === unrelatedTask.id);
        const expected = dep?.status === "done" && target?.status === "done" && unrelated?.status === "backlog";
        const failed = dep?.status === "failed" || target?.status === "failed" || unrelated?.status === "failed";
        return expected || failed;
      });
    }, 180000, 2000);

    await waitFor(2000);

    const tasksResponse = await fetch(`http://localhost:${startedKanbanPort}/api/tasks`);
    const tasks = await tasksResponse.json();

    const depTask = tasks.find((t: any) => t.id === dependencyTask.id);
    const selectedTask = tasks.find((t: any) => t.id === targetTask.id);
    const unrelated = tasks.find((t: any) => t.id === unrelatedTask.id);

    const depFilePath = join(TEST_DIR, "single-start-dependency.txt");
    const targetFilePath = join(TEST_DIR, "single-start-target.txt");
    const unrelatedFilePath = join(TEST_DIR, "single-start-unrelated.txt");

    const dependencyRan = depTask?.status === "done" && existsSync(depFilePath);
    const targetRan = selectedTask?.status === "done" && existsSync(targetFilePath);
    const unrelatedSkipped = unrelated?.status === "backlog" && !existsSync(unrelatedFilePath);
    const dependencyBeforeTarget = typeof depTask?.completedAt === "number"
      && typeof selectedTask?.completedAt === "number"
      && depTask.completedAt <= selectedTask.completedAt;

    await cleanup();
    await cleanupNewWorktrees(baselineWorktrees);
    kanbanServer.stop();
    kanbanDb.close();
    server.close();

    if (!reachedExpectedState || !dependencyRan || !targetRan || !unrelatedSkipped || !dependencyBeforeTarget) {
      console.log("\n✗ TEST FAILED");
      process.exit(1);
    }

    console.log("\n✓ TEST PASSED");
    process.exit(0);
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

// Run plan-mode tests if PLAN_MODE_TEST env is set
if (process.env.SINGLE_TASK_START_TEST === "1") {
  testSingleTaskStartWithDependencies();
} else if (process.env.PLAN_MODE_TEST === "1") {
  testPlanModeApprovalWorkflow();
} else if (process.env.PLAN_MODE_TEST === "2") {
  testPlanModeWithDependencies();
} else if (process.env.PLAN_MODE_TEST === "3") {
  testPlanModeRevisionLoop();
} else {
  main();
}
