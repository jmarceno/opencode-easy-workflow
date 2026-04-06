#!/usr/bin/env bun

import { createOpencode } from "@opencode-ai/sdk";
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { KanbanDB } from "../.opencode/easy-workflow/db";
import { KanbanServer } from "../.opencode/easy-workflow/server";
import { Orchestrator } from "../.opencode/easy-workflow/orchestrator";

const CLEANUP_TEST_ARTIFACTS = process.env.EWF_CLEANUP_TEST_ARTIFACTS === "1";

function cleanupTempDir(tempDir: string): void {
  if (!CLEANUP_TEST_ARTIFACTS) {
    console.log(`Preserving test database: ${join(tempDir, "tasks.db")} (set EWF_CLEANUP_TEST_ARTIFACTS=1 to remove it)`);
    return;
  }
  rmSync(tempDir, { recursive: true, force: true });
}

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

type SessionSummary = {
  id: string;
  title?: string;
};

type TestReport = {
  runId: string;
  timestamp: string;
  opencodeServerUrl: string;
  kanbanUrl: string;
  taskName: string;
  baselineSessionCount: number;
  startResponse: { status: number; ok: boolean; body: string } | null;
  taskSession: { id: string; title: string | null } | null;
  uiSessionUrl: string | null;
  sessionMessageCount: number;
  sessionExistsImmediately: boolean;
  sessionExistsAfterDelay: boolean;
  modelCatalogProviderCount: number;
  modelCatalogHasDefaultOption: boolean;
  selectedExecutionModel: string | null;
  persistedExecutionModel: string | null;
  persistedThinkingLevel: string | null;
  passed: boolean;
  error: string | null;
};

function unwrapData<T>(response: any): T {
  if (response && typeof response === "object" && "data" in response) {
    return response.data as T;
  }
  return response as T;
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

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs: number = 1000,
): Promise<T | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value !== null) return value;
    await waitFor(intervalMs);
  }
  return null;
}

async function listSessions(client: any): Promise<SessionSummary[]> {
  const response = await client.session.list();
  const data = unwrapData<any[]>(response);
  if (!Array.isArray(data)) return [];
  return data.filter((item) => item && typeof item.id === "string");
}

async function getSession(client: any, id: string): Promise<any | null> {
  try {
    const response = await client.session.get({ path: { id } });
    return unwrapData<any>(response);
  } catch {
    return null;
  }
}

async function listSessionMessages(client: any, id: string): Promise<any[]> {
  try {
    const response = await client.session.messages({ path: { id } });
    const data = unwrapData<any[]>(response);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function resolveServerUrlFromClient(client: any): string | null {
  const raw =
    client?.client?.getConfig?.()?.baseUrl ??
    client?._client?.getConfig?.()?.baseUrl ??
    client?.baseUrl ??
    client?.url ??
    null;
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.port === "0") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

async function main() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskName = `UI Session Probe ${runId}`;
  const taskPrompt = [
    `Create a file named .kanban-ui-proof-${runId}.txt in the repository root.`,
    `Write exactly this content in the file: UI_PROBE_${runId}`,
  ].join(" ");

  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-web-ui-${runId}.json`);

  const report: TestReport = {
    runId,
    timestamp: new Date().toISOString(),
    opencodeServerUrl: "",
    kanbanUrl: "",
    taskName,
    baselineSessionCount: 0,
    startResponse: null,
    taskSession: null,
    uiSessionUrl: null,
    sessionMessageCount: 0,
    sessionExistsImmediately: false,
    sessionExistsAfterDelay: false,
    modelCatalogProviderCount: 0,
    modelCatalogHasDefaultOption: false,
    selectedExecutionModel: null,
    persistedExecutionModel: null,
    persistedThinkingLevel: null,
    passed: false,
    error: null,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-ui-"));
  const dbPath = join(tempDir, "tasks.db");

  let opencode: Awaited<ReturnType<typeof createOpencode>> | null = null;
  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let orchestrator: Orchestrator | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let baselineWorktrees: Set<string> = new Set();

  try {
    console.log("=== Kanban Web UI Session Routing Test ===");

    opencode = await createOpencode({ port: 0 });
    const client = opencode.client;
    report.opencodeServerUrl = opencode.server.url;
    console.log(`OpenCode server: ${report.opencodeServerUrl}`);

    const baselineSessions = await listSessions(client);
    const baselineIds = new Set(baselineSessions.map((s) => s.id));
    report.baselineSessionCount = baselineSessions.length;
    baselineWorktrees = await listGitWorktrees();

    const kanbanPort = getFreePort();
    report.kanbanUrl = `http://127.0.0.1:${kanbanPort}`;

    kanbanDb = new KanbanDB(dbPath);
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 1, command: "" });

    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {
        if (orchestrator) await orchestrator.start();
      },
      onStop: () => {
        if (orchestrator) orchestrator.stop();
      },
      getExecuting: () => orchestrator?.isExecuting() ?? false,
      getStartError: () => (orchestrator ? orchestrator.preflightStartError() : "Kanban orchestrator is not ready"),
      getServerUrl: () => resolveServerUrlFromClient(opencode?.client),
    });

    orchestrator = new Orchestrator(
      kanbanDb,
      kanbanServer,
      () => resolveServerUrlFromClient(opencode?.client),
      process.cwd(),
    );

    kanbanServer.start();
    console.log(`Kanban UI: ${report.kanbanUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(report.kanbanUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    const modelCatalogResponse = await page.request.get(`${report.kanbanUrl}/api/models`);
    if (!modelCatalogResponse.ok()) {
      throw new Error(`Failed to load model catalog: HTTP ${modelCatalogResponse.status()} ${await modelCatalogResponse.text()}`);
    }
    const modelCatalog = await modelCatalogResponse.json();
    if (!Array.isArray(modelCatalog?.providers)) {
      throw new Error("/api/models returned invalid shape: providers must be an array");
    }
    report.modelCatalogProviderCount = modelCatalog.providers.length;

    await page.click(".topbar button:has-text('Options')");
    await page.waitForFunction(
      () => document.getElementById("optionsModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );
    const optionPlanCount = await page.locator("#optPlanModel-suggestions option").count();
    const optionExecCount = await page.locator("#optExecModel-suggestions option").count();
    if (optionPlanCount < 1 || optionExecCount < 1) {
      throw new Error("Model suggestion lists in options modal did not populate");
    }
    report.modelCatalogHasDefaultOption = await page.locator("#optExecModel-suggestions option[value='default']").count() > 0;
    if (!report.modelCatalogHasDefaultOption) {
      throw new Error("Model dropdown is missing required default option");
    }
    await page.selectOption("#optThinkingLevel", "medium");
    await page.click("#optionsModal .btn.btn-primary");
    await page.waitForFunction(
      () => document.getElementById("optionsModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );

    await page.click("#col-backlog .add-task-btn");
    await page.fill("#taskName", taskName);
    await page.fill("#taskPrompt", taskPrompt);

    const firstNonDefaultModel = modelCatalog.providers
      .flatMap((provider: any) => Array.isArray(provider?.models) ? provider.models : [])
      .map((model: any) => model?.value)
      .find((value: unknown) => typeof value === "string" && value !== "default") as string | undefined;
    if (!firstNonDefaultModel) {
      throw new Error("No non-default execution model available in /api/models catalog");
    }
    report.selectedExecutionModel = firstNonDefaultModel;
    await page.fill("#taskExecModel", firstNonDefaultModel);
    await page.dispatchEvent("#taskExecModel", "blur");
    await page.selectOption("#taskThinkingLevel", "high");

    if (await page.isChecked("#taskReview")) {
      await page.click("#taskReview");
    }
    if (await page.isChecked("#taskAutoCommit")) {
      await page.click("#taskAutoCommit");
    }

    await page.click("#taskModal .btn.btn-primary");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );
    await page.locator(".card-title", { hasText: taskName }).first().waitFor({ timeout: 10000 });

    const persistedTasksResponse = await page.request.get(`${report.kanbanUrl}/api/tasks`);
    if (!persistedTasksResponse.ok()) {
      throw new Error(`Failed to load persisted tasks: HTTP ${persistedTasksResponse.status()} ${await persistedTasksResponse.text()}`);
    }
    const persistedTasks = await persistedTasksResponse.json();
    const createdTask = Array.isArray(persistedTasks)
      ? persistedTasks.find((task: any) => task?.name === taskName)
      : null;
    if (!createdTask) {
      throw new Error("Created task not found in persisted task list");
    }
    report.persistedExecutionModel = createdTask.executionModel ?? null;
    report.persistedThinkingLevel = createdTask.thinkingLevel ?? null;

    if (report.persistedExecutionModel !== report.selectedExecutionModel) {
      throw new Error(`Execution model persistence mismatch: expected ${report.selectedExecutionModel}, got ${report.persistedExecutionModel}`);
    }
    if (report.persistedThinkingLevel !== "high") {
      throw new Error(`Thinking level persistence mismatch: expected high, got ${report.persistedThinkingLevel}`);
    }

    const createdTaskCard = page.locator(".card", {
      has: page.locator(".card-title", { hasText: taskName }),
    }).first();
    await createdTaskCard.locator(".card-actions button[title='Edit Task']").click();
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );
    const modalExecModel = await page.inputValue("#taskExecModel");
    const modalThinking = await page.inputValue("#taskThinkingLevel");
    if (modalExecModel !== report.selectedExecutionModel) {
      throw new Error(`Task modal did not hydrate execution model. Expected ${report.selectedExecutionModel}, got ${modalExecModel}`);
    }
    if (modalThinking !== "high") {
      throw new Error(`Task modal did not hydrate thinking level. Expected high, got ${modalThinking}`);
    }
    await page.click("#taskModal .btn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );

    const startResponsePromise = page.waitForResponse(
      (response) => response.url().endsWith("/api/start") && response.request().method() === "POST",
      { timeout: 15000 },
    );
    await page.click("#startBtn");

    const startResponse = await startResponsePromise;
    report.startResponse = {
      status: startResponse.status(),
      ok: startResponse.ok(),
      body: await startResponse.text(),
    };

    if (!report.startResponse.ok) {
      throw new Error(`Start failed from web UI: HTTP ${report.startResponse.status} ${report.startResponse.body}`);
    }

    const discoveredSession = await pollFor(async () => {
      const sessions = await listSessions(client);
      return sessions.find((session) => !baselineIds.has(session.id) && session.title === `Task: ${taskName}`) || null;
    }, 120000, 1500);

    if (!discoveredSession) {
      throw new Error("No task session was created on the expected OpenCode server");
    }

    report.taskSession = {
      id: discoveredSession.id,
      title: discoveredSession.title ?? null,
    };

    const taskLink = page.locator(`a.card-title:has-text("${taskName}")`).first();
    if ((await taskLink.count()) > 0) {
      report.uiSessionUrl = await taskLink.getAttribute("href");
    }

    const immediateSession = await getSession(client, discoveredSession.id);
    report.sessionExistsImmediately = Boolean(immediateSession?.id === discoveredSession.id);

    await waitFor(4000);

    const delayedSession = await getSession(client, discoveredSession.id);
    report.sessionExistsAfterDelay = Boolean(delayedSession?.id === discoveredSession.id);

    const messages = await listSessionMessages(client, discoveredSession.id);
    report.sessionMessageCount = messages.length;

    if (!report.sessionExistsImmediately || !report.sessionExistsAfterDelay) {
      throw new Error("Task session was deleted unexpectedly after task start");
    }

    if (report.uiSessionUrl && !report.uiSessionUrl.startsWith(report.opencodeServerUrl)) {
      throw new Error(
        `Card session URL points to a different server: ${report.uiSessionUrl} (expected prefix ${report.opencodeServerUrl})`,
      );
    }

    report.passed = true;
    console.log("\nEvidence report:", reportPath);
    console.log(`Session created: ${report.taskSession.id}`);
    console.log(`Session persisted: ${report.sessionExistsAfterDelay}`);
    console.log(`Session messages: ${report.sessionMessageCount}`);
    console.log("\n✓ TEST PASSED");
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    if (opencode) opencode.server.close();
    await cleanupNewWorktrees(baselineWorktrees);
    cleanupTempDir(tempDir);
  }
}

type PlanModeReport = {
  runId: string;
  timestamp: string;
  opencodeServerUrl: string;
  kanbanUrl: string;
  taskName: string;
  taskId: string | null;
  taskStatusBeforeApproval: string | null;
  awaitingPlanApprovalBeforeApproval: boolean;
  executionPhaseBeforeApproval: string | null;
  approveButtonVisible: boolean;
  approveApiCallSuccess: boolean;
  taskStatusAfterApproval: string | null;
  executionPhaseAfterApproval: string | null;
  passed: boolean;
  error: string | null;
};

async function testPlanModeApprovalUI() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskName = `Plan Mode UI Test ${runId}`;
  const taskPrompt = [
    `Create a file named .plan-ui-proof-${runId}.txt in the repository root.`,
    `Write exactly this content in the file: PLAN_UI_PROBE_${runId}`,
  ].join(" ");

  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-plan-ui-${runId}.json`);

  const report: PlanModeReport = {
    runId,
    timestamp: new Date().toISOString(),
    opencodeServerUrl: "",
    kanbanUrl: "",
    taskName,
    taskId: null,
    taskStatusBeforeApproval: null,
    awaitingPlanApprovalBeforeApproval: false,
    executionPhaseBeforeApproval: null,
    approveButtonVisible: false,
    approveApiCallSuccess: false,
    taskStatusAfterApproval: null,
    executionPhaseAfterApproval: null,
    passed: false,
    error: null,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-plan-ui-"));
  const dbPath = join(tempDir, "tasks.db");

  let opencode: Awaited<ReturnType<typeof createOpencode>> | null = null;
  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let orchestrator: Orchestrator | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let baselineWorktrees: Set<string> = new Set();

  try {
    console.log("=== Plan-Mode Approval UI Test ===");

    opencode = await createOpencode({ port: 0 });
    const client = opencode.client;
    report.opencodeServerUrl = opencode.server.url;
    console.log(`OpenCode server: ${report.opencodeServerUrl}`);

    baselineWorktrees = await listGitWorktrees();

    const kanbanPort = getFreePort();
    report.kanbanUrl = `http://127.0.0.1:${kanbanPort}`;

    kanbanDb = new KanbanDB(dbPath);
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 1, command: "" });

    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {
        if (orchestrator) await orchestrator.start();
      },
      onStop: () => {
        if (orchestrator) orchestrator.stop();
      },
      getExecuting: () => orchestrator?.isExecuting() ?? false,
      getStartError: () => (orchestrator ? orchestrator.preflightStartError() : "Kanban orchestrator is not ready"),
      getServerUrl: () => resolveServerUrlFromClient(opencode?.client),
    });

    orchestrator = new Orchestrator(
      kanbanDb,
      kanbanServer,
      () => resolveServerUrlFromClient(opencode?.client),
      process.cwd(),
    );

    kanbanServer.start();
    console.log(`Kanban UI: ${report.kanbanUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(report.kanbanUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Create plan-mode task via API
    console.log("\nCreating plan-mode task...");
    const createResponse = await page.request.post(`${report.kanbanUrl}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: {
        name: taskName,
        prompt: taskPrompt,
        planmode: true,
        review: false,
        autoCommit: false,
      },
    });

    if (!createResponse.ok()) {
      throw new Error(`Failed to create task: HTTP ${createResponse.status()} ${await createResponse.text()}`);
    }

    const createdTask = await createResponse.json();
    report.taskId = createdTask.id;
    console.log(`Created task: ${createdTask.id}`);

    // Wait for card to appear
    await page.waitForSelector(`.card-title:has-text("${taskName}")`, { timeout: 10000 });

    // Start execution
    console.log("Starting task execution...");
    await page.click("#startBtn");

    // Wait for task to be in review awaiting approval
    const taskInApprovalState = await pollFor(async () => {
      const resp = await page.request.get(`${report.kanbanUrl}/api/tasks`);
      if (!resp.ok()) return false;
      const tasks = await resp.json();
      const task = tasks.find((t: any) => t.id === createdTask.id);
      return task?.status === "review" && task?.awaitingPlanApproval === true;
    }, 60000, 2000);

    if (!taskInApprovalState) {
      const resp = await page.request.get(`${report.kanbanUrl}/api/tasks`);
      const tasks = await resp.json();
      const task = tasks.find((t: any) => t.id === createdTask.id);
      throw new Error(`Task did not enter approval state. Status: ${task?.status}, awaitingApproval: ${task?.awaitingPlanApproval}`);
    }

    console.log("Task is in review awaiting approval");

    // Check API state
    const tasksRespBefore = await page.request.get(`${report.kanbanUrl}/api/tasks`);
    const tasksBefore = await tasksRespBefore.json();
    const taskBefore = tasksBefore.find((t: any) => t.id === createdTask.id);
    report.taskStatusBeforeApproval = taskBefore.status;
    report.awaitingPlanApprovalBeforeApproval = taskBefore.awaitingPlanApproval;
    report.executionPhaseBeforeApproval = taskBefore.executionPhase;

    // Check that "plan approval pending" badge is visible
    const badgeVisible = await page.locator(`.card:has-text("${taskName}") .badge-approval`).isVisible();
    console.log(`Badge visible: ${badgeVisible}`);
    if (!badgeVisible) {
      throw new Error("Plan approval badge is not visible");
    }

    // Check that "Approve Plan" button is visible
    const approveBtnVisible = await page.locator(`.card:has-text("${taskName}") button:has-text("Approve Plan")`).isVisible();
    report.approveButtonVisible = approveBtnVisible;
    console.log(`Approve Plan button visible: ${approveBtnVisible}`);

    if (!approveBtnVisible) {
      throw new Error("Approve Plan button is not visible");
    }

    // Click the Approve Plan button
    console.log("Clicking Approve Plan button...");
    await page.locator(`.card:has-text("${taskName}") button:has-text("Approve Plan")`).click();

    // Wait for state transition
    const resumedTask = await pollFor(async () => {
      const resp = await page.request.get(`${report.kanbanUrl}/api/tasks`);
      if (!resp.ok()) return null;
      const tasks = await resp.json();
      const task = tasks.find((t: any) => t.id === createdTask.id);
      if (!task) return null;
      const resumed = ["backlog", "executing", "done"].includes(task.status)
        && ["implementation_pending", "implementation_done"].includes(task.executionPhase)
        && task.awaitingPlanApproval === false;
      return resumed ? task : null;
    }, 10000, 1000);

    if (!resumedTask) {
      throw new Error("Task did not resume implementation after plan approval");
    }

    // Check API state after approval
    const tasksRespAfter = await page.request.get(`${report.kanbanUrl}/api/tasks`);
    const tasksAfter = await tasksRespAfter.json();
    const taskAfter = tasksAfter.find((t: any) => t.id === createdTask.id);
    report.taskStatusAfterApproval = taskAfter.status;
    report.executionPhaseAfterApproval = taskAfter.executionPhase;

    console.log(`Task status after approval: ${taskAfter.status}`);
    console.log(`Execution phase after approval: ${taskAfter.executionPhase}`);

    if (taskAfter.awaitingPlanApproval !== false) {
      throw new Error(`Task is still awaiting approval after approve action. Status: ${taskAfter.status}, phase: ${taskAfter.executionPhase}`);
    }

    if (!["implementation_pending", "implementation_done"].includes(taskAfter.executionPhase) || !["backlog", "executing", "done"].includes(taskAfter.status)) {
      throw new Error(`Unexpected state after approval. Status: ${taskAfter.status}, phase: ${taskAfter.executionPhase}`);
    }

    report.approveApiCallSuccess = true;
    report.passed = true;
    console.log("\n✓ TEST PASSED");

  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    if (opencode) opencode.server.close();
    await cleanupNewWorktrees(baselineWorktrees);
    cleanupTempDir(tempDir);
  }
}

async function testSkipPermissionAskingUI() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-skip-perm-ui-${runId}.json`);

  type SkipPermReport = {
    runId: string;
    timestamp: string;
    kanbanUrl: string;
    newTaskSkipPermTrue: boolean;
    newTaskPayloadSkipPerm: boolean | null;
    toggleAndSaveSuccess: boolean;
    toggledTaskSkipPerm: boolean;
    templateSkipPermFalse: boolean;
    deployedTaskSkipPerm: boolean;
    passed: boolean;
    error: string | null;
  };

  const report: SkipPermReport = {
    runId,
    timestamp: new Date().toISOString(),
    kanbanUrl: "",
    newTaskSkipPermTrue: false,
    newTaskPayloadSkipPerm: null,
    toggleAndSaveSuccess: false,
    toggledTaskSkipPerm: false,
    templateSkipPermFalse: false,
    deployedTaskSkipPerm: false,
    passed: false,
    error: null,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "ewf-skip-perm-ui-"));
  const dbPath = join(tempDir, "tasks.db");

  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    console.log("=== Skip Permission Asking UI Test ===");

    kanbanDb = new KanbanDB(dbPath);
    const kanbanPort = getFreePort();
    report.kanbanUrl = `http://127.0.0.1:${kanbanPort}`;
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 1, command: "" });

    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {},
      onStop: () => {},
      getExecuting: () => false,
      getStartError: () => null,
      getServerUrl: () => report.kanbanUrl,
    });
    kanbanServer.start();
    console.log(`Kanban UI: ${report.kanbanUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(report.kanbanUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Intercept POST /api/tasks to capture the payload
    let capturedPostPayload: any = null;
    page.on("response", async (response) => {
      if (response.url().endsWith("/api/tasks") && response.request().method() === "POST") {
        try {
          capturedPostPayload = await response.json();
        } catch {}
      }
    });

    // Test 1: Create a new task via UI and verify POST payload has skipPermissionAsking: true
    console.log("\n-- Test 1: New task default skipPermissionAsking --");
    const newTaskName = `Skip Perm New Task ${runId}`;
    await page.click("#col-backlog .add-task-btn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );
    await page.locator("#taskName input").fill(newTaskName);
    await page.locator("#taskPrompt textarea").fill("test prompt");

    // Verify checkbox is checked by default
    const defaultChecked = await page.evaluate(() => {
      const el = document.getElementById("taskSkipPermissionAsking");
      return el?.checked;
    });
    report.newTaskSkipPermTrue = defaultChecked === true;
    console.log(`New task checkbox default checked: ${defaultChecked}`);
    if (defaultChecked !== true) {
      throw new Error(`Expected skipPermissionAsking default to be true, got ${defaultChecked}`);
    }

    await page.locator("#taskSaveBtn").click();
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );
    await page.waitForSelector(`.card-title:has-text("${newTaskName}")`, { timeout: 5000 });
    console.log(`Task created: ${newTaskName}`);

    // Wait for POST response to be captured
    await pollFor(async () => capturedPostPayload !== null, 5000, 200);
    report.newTaskPayloadSkipPerm = capturedPostPayload?.skipPermissionAsking ?? null;
    console.log(`POST payload skipPermissionAsking: ${report.newTaskPayloadSkipPerm}`);
    if (report.newTaskPayloadSkipPerm !== true) {
      throw new Error(`Expected POST payload skipPermissionAsking=true, got ${report.newTaskPayloadSkipPerm}`);
    }

    // Test 2: Open task for edit, toggle checkbox, save, verify PATCH
    console.log("\n-- Test 2: Toggle and save skipPermissionAsking --");
    const createdTask = capturedPostPayload;
    const taskId = createdTask?.id;

    // Open edit modal
    await page.click(`.card:has-text("${newTaskName}") button[title="Edit Task"]`);
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );

    // Verify initial state
    const editInitialChecked = await page.evaluate(() => {
      const el = document.getElementById("taskSkipPermissionAsking");
      return el?.checked;
    });
    console.log(`Edit initial state: skipPermissionAsking=${editInitialChecked}`);
    if (editInitialChecked !== true) {
      throw new Error(`Expected initial edit state to be true, got ${editInitialChecked}`);
    }

    // Intercept PATCH request
    let patchPayload: any = null;
    page.on("response", async (response) => {
      if (response.url().endsWith(`/api/tasks/${taskId}`) && response.request().method() === "PATCH") {
        try {
          patchPayload = await response.json();
        } catch {}
      }
    });

    // Toggle checkbox to false
    await page.locator("#taskSkipPermissionAsking").click();
    const afterToggleChecked = await page.evaluate(() => {
      const el = document.getElementById("taskSkipPermissionAsking");
      return el?.checked;
    });
    console.log(`After toggle: skipPermissionAsking=${afterToggleChecked}`);
    if (afterToggleChecked !== false) {
      throw new Error(`Expected toggle to false, got ${afterToggleChecked}`);
    }

    // Save
    await page.click("#taskSaveBtn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );
    console.log("Task saved after toggle");

    // Wait for PATCH response
    await pollFor(async () => patchPayload !== null, 5000, 200);
    report.toggledTaskSkipPerm = patchPayload?.skipPermissionAsking ?? null;
    console.log(`PATCH payload skipPermissionAsking: ${report.toggledTaskSkipPerm}`);
    if (report.toggledTaskSkipPerm !== false) {
      throw new Error(`Expected PATCH payload skipPermissionAsking=false, got ${report.toggledTaskSkipPerm}`);
    }
    report.toggleAndSaveSuccess = true;

    // Test 3: Create template with skipPermissionAsking=false, deploy, verify
    console.log("\n-- Test 3: Template deploy preserves skipPermissionAsking=false --");

    // Create a template with skipPermissionAsking=false via API
    const templateResp = await page.request.post(`${report.kanbanUrl}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: {
        name: `Skip Perm Template ${runId}`,
        prompt: "template prompt",
        status: "template",
        skipPermissionAsking: false,
        review: false,
        autoCommit: false,
      },
    });
    if (!templateResp.ok()) {
      throw new Error(`Template creation failed: ${templateResp.status()}`);
    }
    const template = await templateResp.json();
    report.templateSkipPermFalse = template.skipPermissionAsking === false;
    console.log(`Template created with skipPermissionAsking=false: ${template.id}`);
    if (template.skipPermissionAsking !== false) {
      throw new Error(`Template should have skipPermissionAsking=false, got ${template.skipPermissionAsking}`);
    }

    // Reload to pick up the new template
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Deploy the template
    await page.click(`.card:has-text("Skip Perm Template ${runId}") button[title="Deploy to Backlog"]`);
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );

    // Verify deployed task has checkbox unchecked
    const deployedChecked = await page.evaluate(() => {
      const el = document.getElementById("taskSkipPermissionAsking");
      return el?.checked;
    });
    console.log(`Deployed task skipPermissionAsking: ${deployedChecked}`);
    report.deployedTaskSkipPerm = deployedChecked === false;
    if (deployedChecked !== false) {
      throw new Error(`Expected deployed task to have skipPermissionAsking=false, got ${deployedChecked}`);
    }

    // Save the deployed task
    await page.click("#taskSaveBtn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );
    console.log("Deployed task saved");

    // Verify the deployed task persisted correctly - find it in the backlog column
    const deployedTaskSelector = `#col-backlog .card:has-text("Skip Perm Template ${runId}")`;
    await page.waitForSelector(deployedTaskSelector, { timeout: 5000 });
    const deployedTaskCard = page.locator(deployedTaskSelector);
    await deployedTaskCard.locator(".card-actions button[title='Edit Task']").click();
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );

    const reOpenedChecked = await page.evaluate(() => {
      const el = document.getElementById("taskSkipPermissionAsking");
      return el?.checked;
    });
    console.log(`Re-opened deployed task skipPermissionAsking: ${reOpenedChecked}`);
    if (reOpenedChecked !== false) {
      throw new Error(`Expected re-opened deployed task to have skipPermissionAsking=false, got ${reOpenedChecked}`);
    }

    await page.locator("#taskModal sl-button:has-text('Cancel')").click();
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );

    report.passed = true;
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nEvidence report: ${reportPath}`);
    console.log("\n✓ TEST PASSED");

  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    cleanupTempDir(tempDir);
  }
}

async function testKeyboardShortcutsDoNotFireInModalsOrInputs() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-shortcuts-ui-${runId}.json`);

  type ShortcutsReport = {
    runId: string;
    timestamp: string;
    kanbanUrl: string;
    shortcutsBlockedInModal: boolean;
    shortcutsBlockedInInput: boolean;
    shortcutsBlockedInTextarea: boolean;
    shortcutsBlockedInSelect: boolean;
    shortcutsBlockedInContenteditable: boolean;
    escapeClosesModal: boolean;
    shortcutsWorkWhenNoModalOrInput: boolean;
    passed: boolean;
    error: string | null;
  };

  const report: ShortcutsReport = {
    runId,
    timestamp: new Date().toISOString(),
    kanbanUrl: "",
    shortcutsBlockedInModal: false,
    shortcutsBlockedInInput: false,
    shortcutsBlockedInTextarea: false,
    shortcutsBlockedInSelect: false,
    shortcutsBlockedInContenteditable: false,
    escapeClosesModal: false,
    shortcutsWorkWhenNoModalOrInput: false,
    passed: false,
    error: null,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "ewf-shortcuts-ui-"));
  const dbPath = join(tempDir, "tasks.db");

  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    console.log("=== Keyboard Shortcuts UI Test ===");

    kanbanDb = new KanbanDB(dbPath);
    const kanbanPort = getFreePort();
    report.kanbanUrl = `http://127.0.0.1:${kanbanPort}`;
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 1, command: "" });

    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {},
      onStop: () => {},
      getExecuting: () => false,
      getStartError: () => null,
      getServerUrl: () => report.kanbanUrl,
    });
    kanbanServer.start();
    console.log(`Kanban UI: ${report.kanbanUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(report.kanbanUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Helper: check if a modal is open
    const isModalOpen = async (modalId: string) =>
      page.evaluate((id) => {
        const el = document.getElementById(id);
        return el && !el.classList.contains("hidden");
      }, modalId);

    // Helper: check if getOpenModalIds returns non-empty
    const isAnyModalOpen = async () =>
      page.evaluate(() => {
        try {
          // @ts-ignore - getOpenModalIds is a global function in the kanban page
          const openModals = typeof getOpenModalIds === "function" ? getOpenModalIds() : [];
          return Array.isArray(openModals) && openModals.length > 0;
        } catch {
          return false;
        }
      });

    // Helper: press a key and return whether a modal opened (or the board state changed)
    const pressKeyAndCheckNoSideEffect = async (key: string) => {
      const modalCountBefore = await page.evaluate(() =>
        document.querySelectorAll(".modal-overlay:not(.hidden)").length
      );
      await page.keyboard.press(key);
      await page.waitForTimeout(100);
      const modalCountAfter = await page.evaluate(() =>
        document.querySelectorAll(".modal-overlay:not(.hidden)").length
      );
      return modalCountBefore === modalCountAfter;
    };

    // ---- Test 1: Shortcuts blocked when modal is open ----
    console.log("\n-- Test 1: Shortcuts blocked when modal is open --");

    // Open the task modal via click (not a shortcut)
    await page.click("#col-backlog .add-task-btn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 }
    );

    // Verify modal is open
    const modalOpen = await isModalOpen("taskModal");
    if (!modalOpen) {
      throw new Error("Task modal should be open");
    }

    // Try T, B, S, D keys - none should open a new modal
    for (const key of ["T", "B", "S", "D"]) {
      const noSideEffect = await pressKeyAndCheckNoSideEffect(key);
      if (!noSideEffect) {
        throw new Error(`Key ${key} should not open a modal when task modal is already open`);
      }
    }

    // Modal should still be open
    const modalStillOpen = await isModalOpen("taskModal");
    if (!modalStillOpen) {
      throw new Error("Task modal should still be open after shortcut keys");
    }
    report.shortcutsBlockedInModal = true;
    console.log("Shortcuts blocked while modal open: PASS");

    // ---- Test 2: Escape closes the modal ----
    console.log("\n-- Test 2: Escape closes the topmost modal --");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const modalClosedByEscape = !(await isModalOpen("taskModal"));
    if (!modalClosedByEscape) {
      throw new Error("Escape should close the task modal");
    }
    report.escapeClosesModal = true;
    console.log("Escape closes modal: PASS");

    // ---- Test 3: Shortcuts blocked when focus is in an input ----
    console.log("\n-- Test 3: Shortcuts blocked when focus is in input --");

    // Create a task first so we have a card to edit
    await page.click("#col-backlog .add-task-btn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 }
    );
    await page.fill("#taskName", "Shortcut Test Task");
    await page.fill("#taskPrompt", "Test prompt");

    // Focus the taskName input
    const taskNameInput = page.locator("#taskName input");
    await taskNameInput.focus();

    // Verify focus is in input
    const inputFocused = await page.evaluate(() => {
      const el = document.getElementById("taskName");
      const active = el?.shadowRoot?.activeElement || document.activeElement;
      return el?.shadowRoot?.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "INPUT";
    });
    if (!inputFocused) {
      throw new Error("taskName input should be focused");
    }

    // Press shortcut keys - modal count should not change
    for (const key of ["T", "B", "S", "D"]) {
      const noSideEffect = await pressKeyAndCheckNoSideEffect(key);
      if (!noSideEffect) {
        throw new Error(`Key ${key} should not open a modal when input is focused`);
      }
    }
    report.shortcutsBlockedInInput = true;
    console.log("Shortcuts blocked while input focused: PASS");

    // ---- Test 4: Shortcuts blocked when focus is in a textarea ----
    console.log("\n-- Test 4: Shortcuts blocked when focus is in textarea --");

    const taskPromptTextarea = page.locator("#taskPrompt textarea");
    await taskPromptTextarea.focus();

    const textareaFocused = await page.evaluate(() => {
      const el = document.getElementById("taskPrompt");
      const active = el?.shadowRoot?.activeElement || document.activeElement;
      return el?.shadowRoot?.activeElement?.tagName === "TEXTAREA" || document.activeElement?.tagName === "TEXTAREA";
    });
    if (!textareaFocused) {
      throw new Error("taskPrompt textarea should be focused");
    }

    for (const key of ["T", "B", "S", "D"]) {
      const noSideEffect = await pressKeyAndCheckNoSideEffect(key);
      if (!noSideEffect) {
        throw new Error(`Key ${key} should not open a modal when textarea is focused`);
      }
    }
    report.shortcutsBlockedInTextarea = true;
    console.log("Shortcuts blocked while textarea focused: PASS");

    // Close modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ---- Test 5: Shortcuts blocked when focus is in a select (sl-select) ----
    console.log("\n-- Test 5: Shortcuts blocked when focus is in sl-select --");

    await page.click("#col-backlog .add-task-btn");
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 }
    );

    // Open the thinking level select
    const selectTrigger = page.locator("#taskThinkingLevel").locator("sl-select");
    const selectEl = page.locator("#taskThinkingLevel");
    await selectEl.click();
    await page.waitForTimeout(200);

    // Check if a dropdown is open
    const selectOpened = await page.evaluate(() => {
      const el = document.getElementById("taskThinkingLevel");
      const listbox = el?.shadowRoot?.querySelector('[slot="trigger"]') || el?.shadowRoot?.querySelector("sl-button");
      return listbox !== null;
    });

    // Press shortcut keys
    for (const key of ["T", "B", "S", "D"]) {
      const noSideEffect = await pressKeyAndCheckNoSideEffect(key);
      if (!noSideEffect) {
        throw new Error(`Key ${key} should not open a modal when select is focused`);
      }
    }
    report.shortcutsBlockedInSelect = true;
    console.log("Shortcuts blocked while select focused: PASS");

    // Close modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ---- Test 6: Shortcuts blocked when focus is in a contenteditable element ----
    console.log("\n-- Test 6: Shortcuts blocked when focus is in contenteditable --");

    // Inject a temporary contenteditable div
    await page.evaluate(() => {
      const div = document.createElement("div");
      div.id = "test-contenteditable";
      div.contentEditable = "true";
      div.style.cssText = "position:fixed;top:0;left:0;width:100px;height:100px;opacity:0;z-index:-1;";
      div.textContent = "test element";
      document.body.appendChild(div);
    });

    // Focus the contenteditable element
    await page.evaluate(() => {
      const el = document.getElementById("test-contenteditable");
      if (el) el.focus();
    });

    // Verify focus is in contenteditable
    const contenteditableFocused = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.id === "test-contenteditable" && active?.isContentEditable === true;
    });
    if (!contenteditableFocused) {
      throw new Error("contenteditable element should be focused");
    }

    // Press shortcut keys - modal count should not change
    for (const key of ["T", "B", "S", "D"]) {
      const noSideEffect = await pressKeyAndCheckNoSideEffect(key);
      if (!noSideEffect) {
        throw new Error(`Key ${key} should not open a modal when contenteditable is focused`);
      }
    }
    report.shortcutsBlockedInContenteditable = true;
    console.log("Shortcuts blocked while contenteditable focused: PASS");

    // Clean up the injected element
    await page.evaluate(() => {
      const el = document.getElementById("test-contenteditable");
      if (el) el.remove();
    });

    // ---- Test 7: Shortcuts work when no modal is open and no input is focused ----
    console.log("\n-- Test 7: Shortcuts work when no modal or input is focused --");

    // Click on the board background to ensure no input is focused
    await page.click(".board", { position: { x: 10, y: 10 } });
    await page.waitForTimeout(100);

    // Verify no modal is open
    const noModalOpen = !(await isAnyModalOpen());
    if (!noModalOpen) {
      throw new Error("No modal should be open at start of this test");
    }

    // Press T - should open template modal
    const templateOpened = await pressKeyAndCheckNoSideEffect("t");
    if (templateOpened) {
      throw new Error("Key T should open the template modal when no modal/input is active");
    }

    const templateModalOpen = await isModalOpen("taskModal");
    if (!templateModalOpen) {
      throw new Error("Template modal (taskModal) should open on T key");
    }

    // Close it
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Press B - should open backlog modal
    const backlogOpened = await pressKeyAndCheckNoSideEffect("b");
    if (backlogOpened) {
      throw new Error("Key B should open the backlog modal when no modal/input is active");
    }

    const backlogModalOpen = await isModalOpen("taskModal");
    if (!backlogModalOpen) {
      throw new Error("Task modal (backlog) should open on B key");
    }

    report.shortcutsWorkWhenNoModalOrInput = true;
    console.log("Shortcuts work when no modal/input: PASS");

    report.passed = true;
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nEvidence report: ${reportPath}`);
    console.log("\n✓ TEST PASSED");
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    cleanupTempDir(tempDir);
  }
}

async function testReviewActivityUI() {
  console.log("\n=== Review Activity UI Test ===");

  const tempDir = mkdtempSync(join(tmpdir(), "easy-workflow-review-activity-"));
  const dbPath = join(tempDir, "tasks.db");
  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-review-activity-${Date.now()}.json`);

  const report = {
    taskId: null as string | null,
    reviewActivityIdleBadges: [] as string[],
    reviewActivityRunningSpinners: [] as string[],
    passed: false,
    error: null as string | null,
  };

  let opencode: Awaited<ReturnType<typeof createOpencode>> | null = null;
  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    // Start OpenCode server
    opencode = await createOpencode({ port: 0 });
    report.kanbanUrl = `http://localhost:${0}`;
    console.log(`OpenCode server started`);

    // Initialize Kanban
    kanbanDb = new KanbanDB(dbPath);
    const kanbanPort = getFreePort();
    kanbanDb.updateOptions({ port: kanbanPort });

    let isExecuting = false;
    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => { isExecuting = true; },
      onStop: () => { isExecuting = false; },
      getExecuting: () => isExecuting,
      getStartError: () => "not ready",
      getServerUrl: () => opencode?.server.url || null,
    });

    const startedKanbanPort = kanbanServer.start();
    const kanbanUrl = `http://localhost:${startedKanbanPort}`;
    report.kanbanUrl = kanbanUrl;
    console.log(`Kanban server started on port ${startedKanbanPort}`);

    // Create a task with review enabled
    console.log("\nCreating task with review enabled...");
    const createResponse = await fetch(`${kanbanUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Review Activity Test Task",
        prompt: "Test prompt",
        review: true,
        autoCommit: false,
      }),
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create task: ${createResponse.statusText()}`);
    }

    const createdTask = await createResponse.json();
    report.taskId = createdTask.id;
    console.log(`Created task: ${createdTask.id}`);

    // Launch browser
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Load the kanban UI
    await page.goto(kanbanUrl);
    await page.waitForTimeout(1000);

    // Test 1: Task in review with reviewActivity = 'idle' should show "waiting for human" badge
    console.log("\n=== Test 1: reviewActivity = 'idle' shows 'waiting for human' badge ===");
    
    // Update task to review status with reviewActivity = 'idle'
    await fetch(`${kanbanUrl}/api/tasks/${createdTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "review", reviewActivity: "idle" }),
    });

    await page.reload();
    await page.waitForTimeout(1000);

    // Check for "waiting for human" badge in the review column
    const waitingBadge = await page.locator(".card").filter({ hasText: "Review Activity Test Task" }).filter({ hasText: "waiting for human" }).count();
    console.log(`Found ${waitingBadge} card(s) with 'waiting for human' badge`);
    if (waitingBadge === 0) {
      throw new Error("Expected 'waiting for human' badge when reviewActivity = 'idle'");
    }
    report.reviewActivityIdleBadges.push("waiting for human badge present");
    console.log("✓ Task shows 'waiting for human' badge when reviewActivity = 'idle'");

    // Verify no "reviewing" spinner when reviewActivity = 'idle'
    const reviewingSpinner = await page.locator(".card").filter({ hasText: "Review Activity Test Task" }).locator(".spinner").count();
    console.log(`Found ${reviewingSpinner} spinner(s) when reviewActivity = 'idle'`);
    if (reviewingSpinner > 0) {
      throw new Error("Should not show reviewing spinner when reviewActivity = 'idle'");
    }
    console.log("✓ No reviewing spinner when reviewActivity = 'idle'");

    // Test 2: Task in review with reviewActivity = 'running' should show "reviewing" spinner
    console.log("\n=== Test 2: reviewActivity = 'running' shows 'reviewing' spinner ===");
    
    // Update task to review status with reviewActivity = 'running'
    await fetch(`${kanbanUrl}/api/tasks/${createdTask.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "review", reviewActivity: "running" }),
    });

    await page.reload();
    await page.waitForTimeout(1000);

    // Check for "reviewing" text and spinner in the review column
    const reviewingLabel = await page.locator(".card").filter({ hasText: "Review Activity Test Task" }).filter({ hasText: "reviewing" }).count();
    console.log(`Found ${reviewingLabel} card(s) with 'reviewing' label`);
    if (reviewingLabel === 0) {
      throw new Error("Expected 'reviewing' label when reviewActivity = 'running'");
    }
    report.reviewActivityRunningSpinners.push("reviewing label present");
    console.log("✓ Task shows 'reviewing' label when reviewActivity = 'running'");

    // Check for spinner
    const spinnerCount = await page.locator(".card").filter({ hasText: "Review Activity Test Task" }).locator(".spinner").count();
    console.log(`Found ${spinnerCount} spinner(s) when reviewActivity = 'running'`);
    if (spinnerCount === 0) {
      throw new Error("Expected spinner when reviewActivity = 'running'");
    }
    console.log("✓ Task shows spinner when reviewActivity = 'running'");

    report.passed = true;
    console.log("\n✓ ALL REVIEW ACTIVITY UI TESTS PASSED");
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    if (opencode) opencode.server.close();
    cleanupTempDir(tempDir);
  }
}

async function testDoneColumnNewestFirstOrdering() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-done-ordering-${runId}.json`);

  type DoneOrderingReport = {
    runId: string;
    timestamp: string;
    kanbanUrl: string;
    taskNames: string[];
    completedAts: number[];
    doneCardOrder: string[];
    newestFirstCorrect: boolean;
    passed: boolean;
    error: string | null;
  };

  const report: DoneOrderingReport = {
    runId,
    timestamp: new Date().toISOString(),
    kanbanUrl: "",
    taskNames: [],
    completedAts: [],
    doneCardOrder: [],
    newestFirstCorrect: false,
    passed: false,
    error: null,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "ewf-done-ordering-"));
  const dbPath = join(tempDir, "tasks.db");

  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    console.log("=== Done Column Newest-First Ordering Test ===");

    kanbanDb = new KanbanDB(dbPath);
    const kanbanPort = getFreePort();
    report.kanbanUrl = `http://127.0.0.1:${kanbanPort}`;
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 1, command: "" });

    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {},
      onStop: () => {},
      getExecuting: () => false,
      getStartError: () => null,
      getServerUrl: () => report.kanbanUrl,
    });
    kanbanServer.start();
    console.log(`Kanban UI: ${report.kanbanUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(report.kanbanUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Create 4 tasks via API as "done", then PATCH each with different completedAt timestamps
    // Note: createTask doesn't accept completedAt, so we set it via PATCH after creation
    const baseTime = Math.floor(Date.now() / 1000);
    const taskNames = [];
    const completedAts = [];
    const taskIds: string[] = [];

    // First create all 4 tasks as done (without completedAt - will be set via PATCH)
    for (let i = 0; i < 4; i++) {
      const taskName = `Done Ordering Task ${i + 1} ${runId}`;
      taskNames.push(taskName);
      // completedAts: [baseTime - 300, baseTime - 200, baseTime - 100, baseTime]
      // So taskNames[0] is oldest, taskNames[3] is newest
      completedAts.push(baseTime - (300 - i * 100));

      const createResp = await page.request.post(`${report.kanbanUrl}/api/tasks`, {
        headers: { "Content-Type": "application/json" },
        data: {
          name: taskName,
          prompt: `Test prompt for task ${i + 1}`,
          status: "done",
        },
      });
      if (!createResp.ok()) {
        throw new Error(`Failed to create task ${i + 1}: ${createResp.status()}`);
      }
      const createdTask = await createResp.json();
      taskIds.push(createdTask.id);
    }

    // Now PATCH each task to set completedAt (and updatedAt for proper fallback testing)
    for (let i = 0; i < 4; i++) {
      const patchResp = await page.request.patch(`${report.kanbanUrl}/api/tasks/${taskIds[i]}`, {
        headers: { "Content-Type": "application/json" },
        data: {
          completedAt: completedAts[i],
          updatedAt: completedAts[i],
        },
      });
      if (!patchResp.ok()) {
        throw new Error(`Failed to patch task ${i + 1}: ${patchResp.status()}`);
      }
    }

    report.taskNames = taskNames;
    report.completedAts = completedAts;
    console.log(`Created ${taskNames.length} done tasks with staggered completedAt values`);

    // Reload the page to pick up the new tasks
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Wait for done column to be populated
    await page.waitForFunction(
      () => document.querySelectorAll("#col-done .card").length === 4,
      undefined,
      { timeout: 5000 },
    );

    // Read the done card order by reading the card-title text content
    const doneCardOrder: string[] = await page.evaluate(() => {
      const cards = document.querySelectorAll("#col-done .card");
      const names: string[] = [];
      for (const card of cards) {
        const titleEl = card.querySelector(".card-title");
        if (titleEl) names.push(titleEl.textContent || "");
      }
      return names;
    });

    report.doneCardOrder = doneCardOrder;
    console.log(`Done card order: ${JSON.stringify(doneCardOrder)}`);
    console.log(`Expected order (newest first): ${JSON.stringify([taskNames[3], taskNames[2], taskNames[1], taskNames[0]])}`);

    // Verify newest-first ordering: taskNames[3] (newest) should be first, taskNames[0] (oldest) last
    const newestFirstCorrect =
      doneCardOrder[0] === taskNames[3] &&
      doneCardOrder[1] === taskNames[2] &&
      doneCardOrder[2] === taskNames[1] &&
      doneCardOrder[3] === taskNames[0];

    report.newestFirstCorrect = newestFirstCorrect;
    console.log(`Newest-first correct: ${newestFirstCorrect}`);

    if (!newestFirstCorrect) {
      throw new Error(
        `Done column not ordered newest-first. Got: ${JSON.stringify(doneCardOrder)}, expected: ${JSON.stringify([taskNames[3], taskNames[2], taskNames[1], taskNames[0]])}`,
      );
    }

    report.passed = true;
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nEvidence report: ${reportPath}`);
    console.log("\n✓ TEST PASSED");

  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    cleanupTempDir(tempDir);
  }
}

async function testDependencyBadgeUI() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const reportDir = join(process.cwd(), ".opencode", "easy-workflow", "test-artifacts");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `kanban-dep-badge-${runId}.json`);

  type DepBadgeReport = {
    runId: string;
    timestamp: string;
    kanbanUrl: string;
    task1Id: string | null;
    task2Id: string | null;
    task3Id: string | null;
    task1Idx: number;
    task2Idx: number;
    task3Idx: number;
    cardBadgeText: string | null;
    modalShowsFullNames: boolean;
    modalDepItemText: string | null;
    orphanedDepBadgeText: string | null;
    orphanedDepCardRenders: boolean;
    orphanedDepJsErrors: string[];
    nullReqsBadgeText: string | null;
    nullReqsCardRenders: boolean;
    nullReqsJsErrors: string[];
    passed: boolean;
    error: string | null;
  };

  const report: DepBadgeReport = {
    runId,
    timestamp: new Date().toISOString(),
    kanbanUrl: "",
    task1Id: null,
    task2Id: null,
    task3Id: null,
    task1Idx: 0,
    task2Idx: 0,
    task3Idx: 0,
    cardBadgeText: null,
    modalShowsFullNames: false,
    modalDepItemText: null,
    orphanedDepBadgeText: null,
    orphanedDepCardRenders: false,
    orphanedDepJsErrors: [],
    nullReqsBadgeText: null,
    nullReqsCardRenders: false,
    nullReqsJsErrors: [],
    passed: false,
    error: null,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "ewf-dep-badge-"));
  const dbPath = join(tempDir, "tasks.db");

  let kanbanDb: KanbanDB | null = null;
  let kanbanServer: KanbanServer | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    console.log("=== Dependency Badge UI Test ===");

    kanbanDb = new KanbanDB(dbPath);
    const kanbanPort = getFreePort();
    report.kanbanUrl = `http://127.0.0.1:${kanbanPort}`;
    kanbanDb.updateOptions({ port: kanbanPort, parallelTasks: 1, command: "" });

    kanbanServer = new KanbanServer(kanbanDb, {
      onStart: async () => {},
      onStop: () => {},
      getExecuting: () => false,
      getStartError: () => null,
      getServerUrl: () => report.kanbanUrl,
    });
    kanbanServer.start();
    console.log(`Kanban UI: ${report.kanbanUrl}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(report.kanbanUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Create three tasks via API (they get idx 0, 1, 2 respectively)
    // task1: no dependencies
    // task2: depends on task1
    // task3: depends on task1 and task2

    const task1Resp = await page.request.post(`${report.kanbanUrl}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: { name: `Dep Test Task 1 ${runId}`, prompt: "test prompt 1", status: "backlog" },
    });
    if (!task1Resp.ok()) throw new Error(`Failed to create task1: ${task1Resp.status()}`);
    const task1 = await task1Resp.json();
    report.task1Id = task1.id;
    report.task1Idx = task1.idx;
    console.log(`Created task1: id=${task1.id}, idx=${task1.idx}`);

    const task2Resp = await page.request.post(`${report.kanbanUrl}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: { name: `Dep Test Task 2 ${runId}`, prompt: "test prompt 2", status: "backlog", requirements: [task1.id] },
    });
    if (!task2Resp.ok()) throw new Error(`Failed to create task2: ${task2Resp.status()}`);
    const task2 = await task2Resp.json();
    report.task2Id = task2.id;
    report.task2Idx = task2.idx;
    console.log(`Created task2: id=${task2.id}, idx=${task2.idx}, deps=[${task2.requirements}]`);

    const task3Resp = await page.request.post(`${report.kanbanUrl}/api/tasks`, {
      headers: { "Content-Type": "application/json" },
      data: { name: `Dep Test Task 3 ${runId}`, prompt: "test prompt 3", status: "backlog", requirements: [task1.id, task2.id] },
    });
    if (!task3Resp.ok()) throw new Error(`Failed to create task3: ${task3Resp.status()}`);
    const task3 = await task3Resp.json();
    report.task3Id = task3.id;
    report.task3Idx = task3.idx;
    console.log(`Created task3: id=${task3.id}, idx=${task3.idx}, deps=[${task3.requirements}]`);

    // Reload to pick up all tasks
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // --- Test 1: Card badge shows numeric dependency labels ---
    console.log("\n-- Test 1: Card badge shows numeric dependency labels --");

    // Find task3's card and read its dependency badge
    const task3CardBadge = await page.locator(`.card:has(.card-title:has-text("Dep Test Task 3 ${runId}")) .badge-dep`).first().textContent();
    report.cardBadgeText = task3CardBadge;
    console.log(`Task3 dependency badge text: "${task3CardBadge}"`);

    // Badge should be "deps: #<idx1>, #<idx2>" where idx1/idx2 are 1-indexed
    // task3 depends on task1 and task2, so badge should show their 1-indexed idx values
    const expectedBadgePattern = `deps: #${task1.idx + 1}, #${task2.idx + 1}`;
    if (task3CardBadge !== expectedBadgePattern) {
      throw new Error(`Expected badge "${expectedBadgePattern}", got "${task3CardBadge}"`);
    }
    console.log(`✓ Task3 card badge shows numeric deps: ${task3CardBadge}`);

    // Also verify task2's badge shows only its dependency (task1)
    const task2CardBadge = await page.locator(`.card:has(.card-title:has-text("Dep Test Task 2 ${runId}")) .badge-dep`).first().textContent();
    const expectedTask2Badge = `deps: #${task1.idx + 1}`;
    if (task2CardBadge !== expectedTask2Badge) {
      throw new Error(`Expected task2 badge "${expectedTask2Badge}", got "${task2CardBadge}"`);
    }
    console.log(`✓ Task2 card badge shows numeric deps: ${task2CardBadge}`);

    // Task1 should have no dependency badge
    const task1HasDepBadge = await page.locator(`.card:has(.card-title:has-text("Dep Test Task 1 ${runId}")) .badge-dep`).count();
    if (task1HasDepBadge > 0) {
      throw new Error("Task1 should not have a dependency badge");
    }
    console.log("✓ Task1 has no dependency badge (correct)");

    // --- Test 2: Modal dependency selector shows full task names ---
    console.log("\n-- Test 2: Modal dependency selector shows full task names --");

    // Open task3's edit modal
    await page.locator(`.card:has(.card-title:has-text("Dep Test Task 3 ${runId}")) button[title="Edit Task"]`).click();
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === false,
      undefined,
      { timeout: 5000 },
    );

    // Read the requirement list items in the modal
    const reqItems = await page.locator("#taskReqs .req-item").allTextContents();
    console.log(`Modal requirement items: ${JSON.stringify(reqItems)}`);

    // Verify each item contains a full task name (not just #number)
    // The selector shows " ${t.name} (#${t.idx + 1})" format
    const task1FullName = `Dep Test Task 1 ${runId}`;
    const task2FullName = `Dep Test Task 2 ${runId}`;

    report.modalShowsFullNames = reqItems.some(text => text.includes(task1FullName) && text.includes(`#${task1.idx + 1}`));
    if (!report.modalShowsFullNames) {
      throw new Error(`Modal selector should show full task names. Got: ${JSON.stringify(reqItems)}`);
    }
    console.log(`✓ Modal selector shows full task names: ${JSON.stringify(reqItems)}`);

    // Also check that the checkboxes are correctly checked for task1 and task2
    const checkedReqs = await page.locator("#taskReqs input:checked").evaluateAll(els => els.map(el => (el as HTMLInputElement).value));
    console.log(`Checked requirement IDs: ${JSON.stringify(checkedReqs)}`);

    if (!checkedReqs.includes(task1.id) || !checkedReqs.includes(task2.id)) {
      throw new Error(`Expected requirements [${task1.id}, ${task2.id}] to be checked. Got: ${JSON.stringify(checkedReqs)}`);
    }
    console.log("✓ Modal correctly shows checked dependencies");

    // Close modal
    await page.locator("#taskModal .modal-close").click();
    await page.waitForFunction(
      () => document.getElementById("taskModal")?.classList.contains("hidden") === true,
      undefined,
      { timeout: 5000 },
    );

    // --- Test 3: Orphaned (non-existent) dependency reference is handled safely ---
    console.log("\n-- Test 3: Orphaned dependency reference handled safely --");

    // Capture console errors
    const orphanedDepErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        orphanedDepErrors.push(msg.text());
      }
    });

    // Patch task3 to have a non-existent dependency ID mixed with a valid one
    const nonExistentId = `non-existent-dep-${runId}`;
    const patchOrphanedResp = await page.request.patch(`${report.kanbanUrl}/api/tasks/${task3.id}`, {
      headers: { "Content-Type": "application/json" },
      data: { requirements: [task1.id, nonExistentId] },
    });
    if (!patchOrphanedResp.ok()) {
      throw new Error(`Failed to patch task3 with orphaned dep: ${patchOrphanedResp.status()}`);
    }
    console.log(`Patched task3 requirements to include orphaned ID: ${nonExistentId}`);

    // Reload the page
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Verify card still renders
    const orphanedCardCount = await page.locator(`.card-title:has-text("Dep Test Task 3 ${runId}")`).count();
    report.orphanedDepCardRenders = orphanedCardCount > 0;
    if (!report.orphanedDepCardRenders) {
      throw new Error("Task3 card should still render with orphaned dependency");
    }
    console.log("✓ Task3 card still renders with orphaned dependency");

    // Verify badge shows only the valid dependency (not the orphaned one)
    const orphanedBadgeText = await page.locator(`.card:has(.card-title:has-text("Dep Test Task 3 ${runId}")) .badge-dep`).first().textContent();
    report.orphanedDepBadgeText = orphanedBadgeText;
    const expectedOrphanedBadge = `deps: #${task1.idx + 1}`;
    if (orphanedBadgeText !== expectedOrphanedBadge) {
      throw new Error(`Expected badge "${expectedOrphanedBadge}" with orphaned dep, got "${orphanedBadgeText}"`);
    }
    console.log(`✓ Orphaned dependency filtered out, badge shows: ${orphanedBadgeText}`);

    // Check for JS errors
    report.orphanedDepJsErrors = orphanedDepErrors.filter(e => !e.includes("Failed to fetch model catalog"));
    if (report.orphanedDepJsErrors.length > 0) {
      throw new Error(`JS errors found with orphaned dep: ${report.orphanedDepJsErrors.join("; ")}`);
    }
    console.log("✓ No JS errors with orphaned dependency");

    // --- Test 4: Task with requirements: null renders without errors ---
    console.log("\n-- Test 4: requirements: null handled safely --");

    // Capture console errors
    const nullReqsErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        nullReqsErrors.push(msg.text());
      }
    });

    // Patch task2 to have requirements: null
    const patchNullReqsResp = await page.request.patch(`${report.kanbanUrl}/api/tasks/${task2.id}`, {
      headers: { "Content-Type": "application/json" },
      data: { requirements: null },
    });
    if (!patchNullReqsResp.ok()) {
      throw new Error(`Failed to patch task2 with null requirements: ${patchNullReqsResp.status()}`);
    }
    console.log("Patched task2 requirements to null");

    // Reload the page
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".conn-status.connected", { timeout: 10000 });

    // Verify task2 card still renders
    const nullReqsCardCount = await page.locator(`.card-title:has-text("Dep Test Task 2 ${runId}")`).count();
    report.nullReqsCardRenders = nullReqsCardCount > 0;
    if (!report.nullReqsCardRenders) {
      throw new Error("Task2 card should still render with null requirements");
    }
    console.log("✓ Task2 card still renders with requirements: null");

    // Verify task2 has NO dependency badge
    const nullReqsBadgeCount = await page.locator(`.card:has(.card-title:has-text("Dep Test Task 2 ${runId}")) .badge-dep`).count();
    report.nullReqsBadgeText = nullReqsBadgeCount > 0
      ? await page.locator(`.card:has(.card-title:has-text("Dep Test Task 2 ${runId}")) .badge-dep`).first().textContent()
      : null;
    if (nullReqsBadgeCount > 0) {
      throw new Error(`Task2 should have no dependency badge with null requirements, got: ${report.nullReqsBadgeText}`);
    }
    console.log("✓ Task2 has no dependency badge (correct)");

    // Check for JS errors
    report.nullReqsJsErrors = nullReqsErrors.filter(e => !e.includes("Failed to fetch model catalog"));
    if (report.nullReqsJsErrors.length > 0) {
      throw new Error(`JS errors found with null requirements: ${report.nullReqsJsErrors.join("; ")}`);
    }
    console.log("✓ No JS errors with requirements: null");

    report.passed = true;
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nEvidence report: ${reportPath}`);
    console.log("\n✓ TEST PASSED");

  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.error("\n✗ TEST FAILED");
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    cleanupTempDir(tempDir);
  }
}

if (process.env.PLAN_UI_TEST === "1") {
  testPlanModeApprovalUI();
} else if (process.env.SKIP_PERM_TEST === "1") {
  testSkipPermissionAskingUI();
} else if (process.env.SHORTCUTS_TEST === "1") {
  testKeyboardShortcutsDoNotFireInModalsOrInputs();
} else if (process.env.REVIEW_ACTIVITY_UI_TEST === "1") {
  testReviewActivityUI();
} else if (process.env.DONE_ORDERING_TEST === "1") {
  testDoneColumnNewestFirstOrdering();
} else if (process.env.DEP_BADGE_TEST === "1") {
  testDependencyBadgeUI();
} else {
  await main();
}
