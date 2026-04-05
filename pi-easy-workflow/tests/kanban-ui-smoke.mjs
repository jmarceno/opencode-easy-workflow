import { spawn } from "child_process";
import { setTimeout as delay } from "timers/promises";
import assert from "assert/strict";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 3900 + Math.floor(Math.random() * 200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

const server = spawn("npx", ["tsx", "scripts/kanban-dev-server.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, KANBAN_PORT: String(PORT) },
});

let serverStdout = "";
let serverStderr = "";
server.stdout.on("data", (chunk) => {
  serverStdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverStderr += chunk.toString();
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleEntries = [];
const pageErrors = [];
const failedRequests = [];

page.on("console", (msg) => {
  consoleEntries.push({ type: msg.type(), text: msg.text() });
});
page.on("pageerror", (error) => {
  pageErrors.push(String(error));
});
page.on("requestfailed", (request) => {
  failedRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`);
});

try {
  await waitForServer(BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await expectVisible(page, "text=Easy Workflow Kanban");

  await page.click("text=+ Add Task");
  await page.locator("#taskName").evaluate((el) => {
    el.value = "Automated smoke task";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#taskPrompt").evaluate((el) => {
    el.value = "Created by automated Playwright smoke test.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#taskSaveBtn").click();
  await page.locator("#col-backlog .card .card-title", { hasText: "Automated smoke task" }).waitFor({ state: "visible", timeout: 10000 });

  await page.locator("#col-backlog .card").filter({ hasText: "Automated smoke task" }).locator("button").nth(2).click();
  await page.locator("#startSingleConfirmBtn").click();
  await page.waitForTimeout(1000);

  const counts = await page.evaluate(() => ({
    backlog: document.getElementById("count-backlog")?.textContent,
    executing: document.getElementById("count-executing")?.textContent,
    review: document.getElementById("count-review")?.textContent,
    logs: document.getElementById("eventLog")?.innerText ?? "",
  }));

  const significantConsole = consoleEntries.filter((entry) => {
    if (entry.text.includes("favicon.ico")) return false;
    return entry.type === "error" || entry.type === "warning";
  });

  assert.match(counts.logs, /Task created: Automated smoke task/);
  assert.ok(Number(counts.executing) >= 1, `Expected at least one executing task, got ${counts.executing}`);
  assert.equal(pageErrors.length, 0, `Unexpected page errors:\n${pageErrors.join("\n")}`);
  assert.equal(failedRequests.length, 0, `Unexpected failed requests:\n${failedRequests.join("\n")}`);
  assert.equal(significantConsole.length, 0, `Unexpected console warnings/errors:\n${significantConsole.map((entry) => `[${entry.type}] ${entry.text}`).join("\n")}`);

  console.log("Smoke test passed.");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await delay(500);
}

async function expectVisible(page, selector) {
  await page.locator(selector).waitFor({ state: "visible", timeout: 10000 });
}
