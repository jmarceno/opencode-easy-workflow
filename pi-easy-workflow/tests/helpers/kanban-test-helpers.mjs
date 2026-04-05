import { spawn } from "child_process";
import { setTimeout as delay } from "timers/promises";
import { chromium } from "playwright";

export const REAL_TEST_MODEL = process.env.KANBAN_REAL_MODEL || "minimax/MiniMax-M2.7";

export async function waitForServer(baseUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for server at ${baseUrl}`);
}

export function startDevServer({ cwd, port }) {
  const server = spawn("npx", ["tsx", "scripts/kanban-dev-server.ts"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, KANBAN_PORT: String(port) },
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    process: server,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async stop() {
      server.kill("SIGTERM");
      await delay(500);
    },
  };
}

export async function createBrowserPage() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleEntries = [];
  const pageErrors = [];
  const failedRequests = [];

  await page.addInitScript(() => {
    window.confirm = () => true;
    window.alert = () => undefined;
  });

  page.on("console", (msg) => {
    consoleEntries.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
  });

  return {
    browser,
    page,
    consoleEntries,
    pageErrors,
    failedRequests,
    async close() {
      await browser.close();
    },
  };
}

export async function setElementValue(page, selector, value) {
  await page.locator(selector).evaluate((el, nextValue) => {
    el.value = nextValue;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

export async function createTaskViaUi(page, task) {
  await page.locator("text=+ Add Task").click();
  await setElementValue(page, "#taskName", task.name);
  await setElementValue(page, "#taskPrompt", task.prompt);
  if (task.planModel) await setElementValue(page, "#taskPlanModel", task.planModel);
  if (task.executionModel) await setElementValue(page, "#taskExecModel", task.executionModel);
  if (task.planmode) await page.locator("#taskPlanmode").evaluate((el) => { el.checked = true; el.dispatchEvent(new Event("sl-change", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  if (task.review === false) await page.locator("#taskReview").evaluate((el) => { el.checked = false; el.dispatchEvent(new Event("sl-change", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.locator("#taskSaveBtn").click();
  await page.locator("#col-backlog .card").filter({ hasText: task.name }).waitFor({ state: "visible", timeout: 10000 });
}

export async function api(page, path, method = "GET", body) {
  return await page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(parsed?.error || text || `Request failed (${response.status})`);
    }
    return parsed;
  }, { path, method, body });
}

export async function assertCleanBrowser({ consoleEntries, pageErrors, failedRequests }) {
  const notableConsole = consoleEntries.filter((entry) => entry.type === "error" || entry.type === "warning");
  if (pageErrors.length > 0) {
    throw new Error(`Unexpected page errors:\n${pageErrors.join("\n")}`);
  }
  const notableFailedRequests = failedRequests.filter((entry) => !entry.startsWith("DELETE ") || !entry.includes("net::ERR_ABORTED"));
  if (notableFailedRequests.length > 0) {
    throw new Error(`Unexpected failed requests:\n${notableFailedRequests.join("\n")}`);
  }
  if (notableConsole.length > 0) {
    throw new Error(`Unexpected console entries:\n${notableConsole.map((entry) => `[${entry.type}] ${entry.text}`).join("\n")}`);
  }
}
