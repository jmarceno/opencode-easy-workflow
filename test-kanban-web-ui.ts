#!/usr/bin/env bun

import { createOpencode } from "@opencode-ai/sdk";
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { KanbanDB } from "./.opencode/easy-workflow/db";
import { KanbanServer } from "./.opencode/easy-workflow/server";
import { Orchestrator } from "./.opencode/easy-workflow/orchestrator";

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

    await page.click("#col-backlog .add-task-btn");
    await page.fill("#taskName", taskName);
    await page.fill("#taskPrompt", taskPrompt);

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
    if (browser) await browser.close().catch(() => undefined);
    if (kanbanServer) kanbanServer.stop();
    if (kanbanDb) kanbanDb.close();
    if (opencode) opencode.server.close();
    await cleanupNewWorktrees(baselineWorktrees);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
