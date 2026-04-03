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
    const optionPlanCount = await page.locator("#optPlanModel option").count();
    const optionExecCount = await page.locator("#optExecModel option").count();
    if (optionPlanCount < 1 || optionExecCount < 1) {
      throw new Error("Model dropdowns in options modal did not populate");
    }
    report.modelCatalogHasDefaultOption = await page.locator("#optExecModel option[value='default']").count() > 0;
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
    await page.selectOption("#taskExecModel", firstNonDefaultModel);
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

    await page.locator(`.card-title:has-text("${taskName}")`).first().click({ button: "right" });
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

if (process.env.PLAN_UI_TEST === "1") {
  testPlanModeApprovalUI();
} else {
  await main();
}
