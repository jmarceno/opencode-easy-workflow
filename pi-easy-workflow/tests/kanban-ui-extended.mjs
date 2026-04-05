import assert from "assert/strict";
import {
  REAL_TEST_MODEL,
  api,
  assertCleanBrowser,
  createBrowserPage,
  createTaskViaUi,
  setElementValue,
  startDevServer,
  waitForServer,
} from "./helpers/kanban-test-helpers.mjs";

const ROOT = process.cwd();
const PORT = 4100 + Math.floor(Math.random() * 200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

  await createTaskViaUi(page, {
    name: "Extended test task",
    prompt: "Validate edit, options, graph, delete, and review flows.",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
  });

  await page.locator("#col-backlog .card").filter({ hasText: "Extended test task" }).locator("button").first().click();
  await setElementValue(page, "#taskName", "Extended task renamed");
  await page.locator("#taskSaveBtn").click();
  await page.locator("#col-backlog .card").filter({ hasText: "Extended task renamed" }).waitFor({ state: "visible", timeout: 10000 });

  await page.locator(".options-btn").click();
  await setElementValue(page, "#optPlanModel", REAL_TEST_MODEL);
  await setElementValue(page, "#optExecModel", REAL_TEST_MODEL);
  await page.locator("#optParallel").evaluate((el) => {
    el.value = "1";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.evaluate(async () => { await saveOptions(); });
  await page.evaluate(() => closeOptionsModal());
  await page.waitForTimeout(300);

  await page.evaluate(async () => {
    const response = await fetch('/api/execution-graph');
    const graph = await response.json();
    renderGraphModal(graph);
    document.getElementById('graphModal').classList.remove('hidden');
  });
  await page.waitForFunction(() => !document.getElementById("graphModal")?.classList.contains("hidden"));
  const graphText = await page.locator("#graphContent").innerText();
  assert.match(graphText, /logical task/i);
  await page.evaluate(() => confirmExecution());
  await page.waitForTimeout(500);

  const planTask = await api(page, "/api/tasks", "POST", {
    name: "Plan approval task",
    prompt: "A plan mode task for browser validation",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    planmode: true,
    review: true,
    status: "review",
    awaitingPlanApproval: true,
    executionPhase: "plan_complete_waiting_approval",
    agentOutput: "[plan]\n1. Design\n2. Build\n[/plan]\n",
  });
  await api(page, `/api/tasks/${planTask.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: true,
    executionPhase: "plan_complete_waiting_approval",
    agentOutput: "[plan]\n1. Design\n2. Build\n[/plan]\n",
  });
  await page.waitForTimeout(500);
  await page.locator("#col-review .card").filter({ hasText: "Plan approval task" }).locator("text=Request Changes").click();
  await setElementValue(page, "#revisionFeedback", "Please add rollback steps.");
  await page.evaluate(() => confirmRequestRevision());
  await page.waitForTimeout(700);

  await api(page, `/api/tasks/${planTask.id}`, "PATCH", {
    status: "review",
    awaitingPlanApproval: true,
    executionPhase: "plan_complete_waiting_approval",
    agentOutput: "[plan]\n1. Design\n2. Build\n3. Rollback\n[/plan]\n",
  });
  await page.waitForTimeout(400);
  await page.locator("#col-review .card").filter({ hasText: "Plan approval task" }).locator("text=Approve Plan").click();
  await setElementValue(page, "#approveMessage", "Looks good, continue.");
  await page.evaluate(() => confirmApprovePlan());
  await page.waitForTimeout(700);

  const repairTask = await api(page, "/api/tasks", "POST", {
    name: "Repair me",
    prompt: "Task needing repair flow coverage",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    status: "failed",
    review: true,
    agentOutput: "Task output present",
    errorMessage: "Synthetic failure",
  });
  await page.waitForTimeout(400);
  await page.locator("#col-review .card").filter({ hasText: "Repair me" }).locator("text=Smart Repair").click();
  await page.waitForTimeout(800);

  const doneTask = await api(page, "/api/tasks", "POST", {
    name: "Delete me",
    prompt: "Task to be deleted from done lane",
    branch: "main",
    planModel: REAL_TEST_MODEL,
    executionModel: REAL_TEST_MODEL,
    status: "done",
    review: true,
  });
  await page.waitForTimeout(400);
  await page.locator("#col-done .card").filter({ hasText: "Delete me" }).locator("button").nth(1).click();
  await page.waitForTimeout(800);

  const tasks = await api(page, "/api/tasks");
  assert.ok(tasks.some((task) => task.name === "Extended task renamed"), "Renamed task should exist");
  assert.ok(tasks.some((task) => task.name === "Plan approval task" && task.status === "executing"), "Approved plan task should be executing");
  assert.ok(tasks.some((task) => task.name === "Repair me" && task.status === "backlog"), "Smart repaired task should return to backlog");
  assert.ok(!tasks.some((task) => task.id === doneTask.id), "Deleted done task should be gone");

  await assertCleanBrowser(browserCtx);
  console.log("Extended kanban UI test passed.");
} finally {
  await browserCtx.close();
  await server.stop();
}
