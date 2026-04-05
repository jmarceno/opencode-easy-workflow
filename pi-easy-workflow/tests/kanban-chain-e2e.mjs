import assert from "assert/strict";
import {
  REAL_TEST_MODEL,
  api,
  assertCleanBrowser,
  createBrowserPage,
  startDevServer,
  waitForServer,
} from "./helpers/kanban-test-helpers.mjs";

const ROOT = process.cwd();
const PORT = 4300 + Math.floor(Math.random() * 200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Note: this test simulates the full chain locally. If future orchestration paths
// require a real model/API call, the only allowed default test model is REAL_TEST_MODEL.
const server = startDevServer({ cwd: ROOT, port: PORT });
const browserCtx = await createBrowserPage();
const { page } = browserCtx;

try {
  await waitForServer(BASE_URL);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  const existingTasks = await api(page, "/api/tasks");
  for (const task of existingTasks) {
    await api(page, `/api/tasks/${task.id}`, "DELETE");
  }
  await page.reload({ waitUntil: "networkidle" });

  await api(page, "/api/options", "PUT", {
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    reviewModel: REAL_TEST_MODEL,
    parallelTasks: 1,
    showExecutionGraph: true,
  });

  const foundation = await api(page, "/api/tasks", "POST", {
    name: "Foundation",
    prompt: "Set up shared types and utilities.",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    review: true,
    status: "backlog",
  });
  const apiTask = await api(page, "/api/tasks", "POST", {
    name: "API Layer",
    prompt: "Build the service layer.",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    review: true,
    requirements: [foundation.id],
    status: "backlog",
  });
  const uiTask = await api(page, "/api/tasks", "POST", {
    name: "UI Layer",
    prompt: "Build the front-end experience.",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    review: true,
    requirements: [apiTask.id],
    status: "backlog",
  });
  const releasePlan = await api(page, "/api/tasks", "POST", {
    name: "Release plan",
    prompt: "Plan the rollout and validation.",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    planmode: true,
    review: true,
    status: "backlog",
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const response = await fetch('/api/execution-graph');
    const graph = await response.json();
    renderGraphModal(graph);
    document.getElementById('graphModal').classList.remove('hidden');
  });
  await page.waitForFunction(() => !document.getElementById("graphModal")?.classList.contains("hidden"));
  const graphText = await page.locator("#graphContent").innerText();
  assert.match(graphText, /4 tasks? in 4 batches?/i);
  await page.evaluate(() => confirmExecution());
  await page.waitForTimeout(400);

  await api(page, `/api/tasks/${foundation.id}/start`, "POST");
  await api(page, `/api/tasks/${foundation.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: false,
    executionPhase: "implementation_done",
    agentOutput: "Implementation completed successfully.",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "Foundation" }).locator("text=Mark Done").click();
  await page.waitForTimeout(500);

  await api(page, `/api/tasks/${apiTask.id}/start`, "POST");
  await api(page, `/api/tasks/${apiTask.id}`, "PATCH", {
    status: "failed",
    errorMessage: "Tests failed",
    agentOutput: "Need to rerun after fixing generated files.",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "API Layer" }).locator("text=Smart Repair").click();
  await page.waitForTimeout(700);
  await api(page, `/api/tasks/${apiTask.id}/start`, "POST");
  await api(page, `/api/tasks/${apiTask.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: false,
    executionPhase: "implementation_done",
    agentOutput: "API layer is complete.",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "API Layer" }).locator("text=Mark Done").click();
  await page.waitForTimeout(500);

  await api(page, `/api/tasks/${uiTask.id}/start`, "POST");
  await api(page, `/api/tasks/${uiTask.id}`, "PATCH", {
    status: "stuck",
    errorMessage: "Manual verification required",
    agentOutput: "UI complete but waiting for sign-off.",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "UI Layer" }).locator("text=Mark Done").click();
  await page.waitForTimeout(500);

  await api(page, `/api/tasks/${releasePlan.id}/start`, "POST");
  await api(page, `/api/tasks/${releasePlan.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: true,
    executionPhase: "plan_complete_waiting_approval",
    agentOutput: "[plan]\n1. Run smoke checks\n2. Deploy canary\n[/plan]\n",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "Release plan" }).locator("text=Request Changes").click();
  await page.locator("#revisionFeedback").evaluate((el) => {
    el.value = "Add rollback validation.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(() => confirmRequestRevision());
  await page.waitForTimeout(600);

  await api(page, `/api/tasks/${releasePlan.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: true,
    executionPhase: "plan_complete_waiting_approval",
    planRevisionCount: 1,
    agentOutput: "[plan]\n1. Run smoke checks\n2. Deploy canary\n3. Validate rollback\n[/plan]\n",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "Release plan" }).locator("text=Approve Plan").click();
  await page.locator("#approveMessage").evaluate((el) => {
    el.value = "Ship it with rollback verification.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(() => confirmApprovePlan());
  await page.waitForTimeout(700);
  await api(page, `/api/tasks/${releasePlan.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: false,
    executionPhase: "implementation_done",
    agentOutput: "Release completed successfully.",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "Release plan" }).locator("text=Mark Done").click();
  await page.waitForTimeout(500);

  const tasks = await api(page, "/api/tasks");
  const doneNames = tasks.filter((task) => task.status === "done").map((task) => task.name).sort();
  assert.deepEqual(doneNames.sort(), ["API Layer", "Foundation", "Release plan", "UI Layer"].sort());

  const logs = await page.evaluate(() => document.getElementById("eventLog")?.innerText ?? "");
  assert.match(logs, /Revision requested for task: Release plan/);
  assert.match(logs, /Plan approved for task: Release plan/);

  await assertCleanBrowser(browserCtx);
  console.log("Complex kanban chain E2E test passed.");
} finally {
  await browserCtx.close();
  await server.stop();
}
