import { spawn } from "child_process";
import { setTimeout as delay } from "timers/promises";
import assert from "assert/strict";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 3847;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, timeoutMs = 20000) {
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
  throw new Error(`Timed out waiting for Pi-started kanban server at ${url}`);
}

const session = spawn(
  "script",
  ["-q", "-c", "pi --offline -e .", "/tmp/pi-easy-workflow-runtime.typescript"],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  },
);

let stdout = "";
let stderr = "";
session.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
session.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
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

  await page.locator("text=Easy Workflow Kanban").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("text=+ Add Task").click();

  await page.locator("#taskName").evaluate((el) => {
    el.value = "Pi runtime validation task";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#taskPrompt").evaluate((el) => {
    el.value = "Created while the server is started by Pi itself.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#taskSaveBtn").click();
  await page.locator("#col-backlog .card").filter({ hasText: "Pi runtime validation task" }).waitFor({ state: "visible", timeout: 10000 });

  const state = await page.evaluate(() => ({
    backlog: document.getElementById("count-backlog")?.textContent,
    logs: document.getElementById("eventLog")?.innerText ?? "",
  }));

  assert.match(stdout, /Easy Workflow kanban server started/);
  assert.match(state.logs, /Task created: Pi runtime validation task/);
  assert.ok(Number(state.backlog) >= 1, `Expected backlog count >= 1, got ${state.backlog}`);
  assert.equal(pageErrors.length, 0, `Unexpected page errors:\n${pageErrors.join("\n")}`);
  assert.equal(failedRequests.length, 0, `Unexpected failed requests:\n${failedRequests.join("\n")}`);
  assert.equal(consoleEntries.filter((entry) => entry.type === "error" || entry.type === "warning").length, 0, `Unexpected console entries:\n${consoleEntries.map((entry) => `[${entry.type}] ${entry.text}`).join("\n")}`);

  console.log("Pi runtime smoke test passed.");
} finally {
  await browser.close();
  session.kill("SIGTERM");
  await delay(500);
}
