/**
 * Kanban HTTP Server
 *
 * Serves the in-package kanban HTML and a compatibility API surface for the
 * copied OpenCode kanban page.
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { createServer, type Server as HTTPServer } from "http";
import type { AddressInfo } from "net";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { KanbanDB, type WorkflowSessionEntry } from "./db";
import { Orchestrator } from "./orchestrator";
import type { BestOfNConfig, Options, Task } from "./types";

export interface KanbanServerOptions {
  onStart?: () => Promise<void>;
  onStartSingle?: (taskId: string) => Promise<void>;
  onStop?: () => void;
  getExecuting?: () => boolean;
  getStartError?: (taskId?: string) => string | null;
  getServerUrl?: () => string | null;
  ownerDirectory?: string;
  orchestrator?: Orchestrator;
}

type WSMessage = {
  type:
    | "task_created"
    | "task_updated"
    | "task_deleted"
    | "task_reordered"
    | "options_updated"
    | "execution_started"
    | "execution_stopped"
    | "execution_complete"
    | "agent_output"
    | "error"
    | "task_run_created"
    | "task_run_updated"
    | "task_candidate_created"
    | "task_candidate_updated"
    | "plan_revision_requested";
  payload: unknown;
};

const KANBAN_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.html"), "utf8");
const THINKING_LEVELS = new Set(["default", "low", "medium", "high"]);
const EXECUTION_STRATEGIES = new Set(["standard", "best_of_n"]);
const TASK_BOOLEAN_FIELDS = ["planmode", "autoApprovePlan", "review", "autoCommit", "deleteWorktree", "skipPermissionAsking"] as const;

type RepairAction = "queue_implementation" | "restore_plan_approval" | "reset_backlog" | "mark_done" | "fail_task";

function readBody(req: Parameters<HTTPServer["emit"]>[1]): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: any, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function noContent(res: any): void {
  res.writeHead(204);
  res.end();
}

function nowMs(): number {
  return Date.now();
}

function normalizeDbOptionKey(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function getInvalidTaskBooleanField(body: Record<string, unknown>): string | null {
  for (const field of TASK_BOOLEAN_FIELDS) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") {
      return field;
    }
  }
  return null;
}

function validateBestOfNConfig(config: unknown): { valid: true } | { valid: false; error: string } {
  if (!config || typeof config !== "object") {
    return { valid: false, error: "bestOfNConfig must be an object" };
  }

  const cfg = config as BestOfNConfig;
  if (!Array.isArray(cfg.workers) || cfg.workers.length === 0) {
    return { valid: false, error: "At least one worker slot is required" };
  }
  for (let i = 0; i < cfg.workers.length; i++) {
    const worker = cfg.workers[i];
    if (!worker?.model || typeof worker.model !== "string") {
      return { valid: false, error: `Worker slot ${i + 1}: model is required` };
    }
    if (typeof worker.count !== "number" || worker.count < 1) {
      return { valid: false, error: `Worker slot ${i + 1}: count must be at least 1` };
    }
  }
  if (!Array.isArray(cfg.reviewers)) {
    return { valid: false, error: "Reviewers must be an array" };
  }
  for (let i = 0; i < cfg.reviewers.length; i++) {
    const reviewer = cfg.reviewers[i];
    if (!reviewer?.model || typeof reviewer.model !== "string") {
      return { valid: false, error: `Reviewer slot ${i + 1}: model is required` };
    }
    if (typeof reviewer.count !== "number" || reviewer.count < 1) {
      return { valid: false, error: `Reviewer slot ${i + 1}: count must be at least 1` };
    }
  }
  if (!cfg.finalApplier || typeof cfg.finalApplier !== "object" || typeof cfg.finalApplier.model !== "string" || !cfg.finalApplier.model.trim()) {
    return { valid: false, error: "Final applier model is required" };
  }
  if (!["pick", "pick_best", "pick_or_synthesize", "synthesize"].includes(String(cfg.selectionMode))) {
    return { valid: false, error: "selectionMode must be pick_best, pick_or_synthesize, or synthesize" };
  }
  if (typeof cfg.minSuccessfulWorkers !== "number" || cfg.minSuccessfulWorkers < 1) {
    return { valid: false, error: "minSuccessfulWorkers must be at least 1" };
  }

  const totalWorkers = cfg.workers.reduce((sum, slot) => sum + slot.count, 0);
  if (cfg.minSuccessfulWorkers > totalWorkers) {
    return { valid: false, error: "minSuccessfulWorkers cannot exceed total worker count" };
  }

  return { valid: true };
}

function hasCapturedPlanOutput(agentOutput: string | null | undefined): boolean {
  return /\[plan\]\s*[\s\S]*?(?=\n\[[a-z0-9-]+\]|$)/i.test(agentOutput || "");
}

function isTaskAwaitingPlanApproval(task: Task): boolean {
  return task.planmode === true && task.awaitingPlanApproval === true;
}

function isTaskExecutable(task: Task): boolean {
  if (task.status === "backlog") return true;
  if (task.status === "review" && task.executionPhase === "plan_revision_pending") return true;
  if (task.status === "failed" || task.status === "stuck") return true;
  return false;
}

function isTaskActionableWhileExecutionRuns(status: string): boolean {
  return status === "template" || status === "review" || status === "failed" || status === "stuck";
}

function isTaskMutationLockedWhileExecuting(executing: boolean, status: string): boolean {
  return executing && !isTaskActionableWhileExecutionRuns(status);
}

function getExecutionMutationError(): string {
  return "Cannot modify workflow tasks while execution is running. Stop execution first.";
}

function classifyStartError(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("task not found") || normalized.includes("missing task")) return 404;
  if (normalized.includes("server url")) return 500;
  return 400;
}

function taskToExecutionNode(task: Task) {
  const expandedWorkerRuns = task.executionStrategy === "best_of_n"
    ? (task.bestOfNConfig?.workers ?? []).reduce((sum, slot) => sum + slot.count, 0)
    : 1;
  const expandedReviewerRuns = task.executionStrategy === "best_of_n"
    ? (task.bestOfNConfig?.reviewers ?? []).reduce((sum, slot) => sum + slot.count, 0)
    : (task.review ? 1 : 0);
  const hasFinalApplier = task.executionStrategy === "best_of_n";

  return {
    id: task.id,
    name: task.name,
    requirements: task.requirements,
    status: task.status,
    expandedWorkerRuns,
    expandedReviewerRuns,
    hasFinalApplier,
    estimatedRunCount: expandedWorkerRuns + expandedReviewerRuns + (hasFinalApplier ? 1 : 0),
  };
}

function buildExecutionGraph(tasks: Task[], parallelLimit: number) {
  const executable = tasks.filter(isTaskExecutable);
  const nodes = executable.map(taskToExecutionNode);
  const batches: Array<{ index: number; tasks: ReturnType<typeof taskToExecutionNode>[] }> = [];
  const limit = Math.max(1, parallelLimit);

  for (let i = 0; i < nodes.length; i += limit) {
    batches.push({ index: batches.length, tasks: nodes.slice(i, i + limit) });
  }

  const pendingApprovals = tasks
    .filter((task) => isTaskAwaitingPlanApproval(task))
    .map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      awaitingPlanApproval: task.awaitingPlanApproval,
      planRevisionCount: task.planRevisionCount,
    }));

  return {
    totalTasks: nodes.length,
    parallelLimit: limit,
    nodes,
    batches,
    pendingApprovals,
  };
}

function summarizeBestOfN(db: KanbanDB, task: Task) {
  const runs = db.getTaskRuns(task.id);
  const candidates = db.getTaskCandidates(task.id);
  const workers = runs.filter((run) => run.phase === "worker");
  const reviewers = runs.filter((run) => run.phase === "reviewer");
  const finalAppliers = runs.filter((run) => run.phase === "final_applier");
  const expandedWorkerCount = task.bestOfNConfig ? task.bestOfNConfig.workers.reduce((sum, slot) => sum + slot.count, 0) : 0;
  const expandedReviewerCount = task.bestOfNConfig ? task.bestOfNConfig.reviewers.reduce((sum, slot) => sum + slot.count, 0) : 0;

  return {
    taskId: task.id,
    substage: task.bestOfNSubstage,
    workersDone: workers.filter((run) => run.status === "done").length,
    workersTotal: workers.length,
    reviewersDone: reviewers.filter((run) => run.status === "done").length,
    reviewersTotal: reviewers.length,
    finalApplierDone: finalAppliers.some((run) => run.status === "done"),
    expandedWorkerCount,
    expandedReviewerCount,
    totalExpandedRuns: expandedWorkerCount + expandedReviewerCount + 1,
    successfulCandidateCount: candidates.length,
    selectedCandidate: candidates.find((candidate) => candidate.status === "selected")?.id ?? null,
  };
}

function listGitBranches(ownerDirectory: string): { branches: string[]; current: string | null } {
  try {
    const current = execSync("git branch --show-current", {
      cwd: ownerDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const output = execSync("git branch --format='%(refname:short)'", {
      cwd: ownerDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branches = output
      .split("\n")
      .map((value) => value.trim().replace(/^'+|'+$/g, ""))
      .filter(Boolean);
    return { branches, current: current || null };
  } catch {
    return { branches: [], current: null };
  }
}

function buildModelCatalog(options: Options) {
  const modelValues = ["default", options.planModel, options.executionModel, options.reviewModel].filter(Boolean);
  return {
    providers: [
      {
        id: "default",
        name: "Default",
        models: [...new Set(modelValues)].map((value) => ({
          id: value,
          label: value,
          value,
        })),
      },
    ],
    defaults: { default: "default" },
  };
}

export class KanbanServer {
  private readonly db: KanbanDB;
  private readonly options: KanbanServerOptions;
  private readonly ownerDirectory: string;
  private readonly orchestrator?: Orchestrator;
  private server: HTTPServer | null = null;
  private wsServer: WebSocketServer | null = null;
  private port: number;
  private executing = false;

  constructor(db: KanbanDB, options: KanbanServerOptions = {}) {
    this.db = db;
    this.options = options;
    this.ownerDirectory = options.ownerDirectory ?? process.cwd();
    this.orchestrator = options.orchestrator;
    this.port = db.getOptions().port;
  }

  start(): number {
    if (this.server) return this.port;

    this.server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.wsServer = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws") {
        socket.destroy();
        return;
      }
      this.wsServer?.handleUpgrade(req, socket, head, (ws) => {
        this.wsServer?.emit("connection", ws, req);
      });
    });

    this.server.listen(this.port, () => {
      this.port = ((this.server?.address() as AddressInfo | null)?.port ?? this.port);
    });

    return this.port;
  }

  stop(): void {
    this.wsServer?.clients.forEach((client) => client.close());
    this.wsServer?.close();
    this.wsServer = null;
    this.server?.close();
    this.server = null;
  }

  getPort(): number {
    return this.port;
  }

  broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.wsServer?.clients ?? []) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  private getExecuting(): boolean {
    return this.options.getExecuting?.() ?? this.executing;
  }

  private setExecuting(value: boolean): void {
    this.executing = value;
  }

  private getTaskOrThrow(taskId: string): Task {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("Task not found");
    return task;
  }

  private updateTask(taskId: string, updates: Partial<Task>): Task {
    const task = this.db.updateTask(taskId, updates);
    if (!task) throw new Error("Task not found");
    return task;
  }

  private updateTaskAndBroadcast(taskId: string, updates: Partial<Task>): Task {
    const task = this.updateTask(taskId, updates);
    this.broadcast({ type: "task_updated", payload: task });
    return task;
  }

  private async maybeAutoStartExecution(): Promise<void> {
    if (this.getExecuting()) return;
    const preflightError = this.options.getStartError?.();
    if (preflightError) return;
    if (!this.options.onStart) return;
    this.setExecuting(true);
    this.broadcast({ type: "execution_started", payload: {} });
    try {
      await this.options.onStart();
    } catch (error) {
      this.setExecuting(false);
      this.broadcast({ type: "error", payload: { message: error instanceof Error ? error.message : String(error) } });
      this.broadcast({ type: "execution_stopped", payload: {} });
    }
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const method = req.method;
    const pathname = url.pathname;

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(KANBAN_HTML);
      return;
    }

    if (method === "GET" && pathname === "/api/health") {
      json(res, 200, { status: "ok", port: this.port });
      return;
    }

    if (method === "GET" && pathname === "/api/tasks") {
      json(res, 200, this.db.getTasks());
      return;
    }

    if (method === "POST" && pathname === "/api/tasks") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const invalidBooleanField = getInvalidTaskBooleanField(body);
      if (invalidBooleanField) {
        json(res, 400, { error: `Invalid ${invalidBooleanField}. Expected boolean.` });
        return;
      }
      if (body.thinkingLevel !== undefined && !THINKING_LEVELS.has(String(body.thinkingLevel))) {
        json(res, 400, { error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" });
        return;
      }
      if (body.executionStrategy !== undefined && !EXECUTION_STRATEGIES.has(String(body.executionStrategy))) {
        json(res, 400, { error: "Invalid executionStrategy. Allowed values: standard, best_of_n" });
        return;
      }
      if (body.executionStrategy === "best_of_n") {
        const validation = validateBestOfNConfig(body.bestOfNConfig);
        if (!validation.valid) {
          json(res, 400, { error: validation.error });
          return;
        }
      }
      if (body.executionStrategy === "standard" && body.bestOfNConfig !== undefined && body.bestOfNConfig !== null) {
        json(res, 400, { error: "bestOfNConfig must be null when executionStrategy is standard" });
        return;
      }
      if (body.planmode === true && body.executionStrategy === "best_of_n") {
        json(res, 400, { error: "planmode and best_of_n execution strategy cannot be combined in v1" });
        return;
      }

      const task = this.db.createTask({
        id: body.id ?? `task${Date.now().toString(36)}`,
        name: String(body.name ?? "").trim(),
        prompt: String(body.prompt ?? ""),
        branch: String(body.branch ?? ""),
        planModel: String(body.planModel ?? this.db.getOptions().planModel),
        executionModel: String(body.executionModel ?? this.db.getOptions().executionModel),
        planmode: body.planmode === true,
        autoApprovePlan: body.autoApprovePlan === true,
        review: body.review !== false,
        autoCommit: body.autoCommit !== false,
        deleteWorktree: body.deleteWorktree !== false,
        status: body.status ?? "backlog",
        requirements: Array.isArray(body.requirements) ? body.requirements : [],
        thinkingLevel: body.thinkingLevel ?? "default",
        executionStrategy: body.executionStrategy ?? "standard",
        bestOfNConfig: body.bestOfNConfig ?? null,
        skipPermissionAsking: body.skipPermissionAsking === true,
      });
      this.broadcast({ type: "task_created", payload: task });
      json(res, 201, task);
      return;
    }

    if (method === "PUT" && pathname === "/api/tasks/reorder") {
      if (this.getExecuting()) {
        json(res, 409, { error: getExecutionMutationError() });
        return;
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body?.id && typeof body?.newIdx === "number") {
        const tasks = this.db.getTasks();
        const currentIndex = tasks.findIndex((task) => task.id === body.id);
        if (currentIndex >= 0) {
          const reordered = [...tasks];
          const [moved] = reordered.splice(currentIndex, 1);
          reordered.splice(Math.max(0, Math.min(body.newIdx, reordered.length)), 0, moved);
          this.db.reorderTasks(reordered.map((task) => task.id));
        }
      } else if (Array.isArray(body)) {
        this.db.reorderTasks(body);
      }
      this.broadcast({ type: "task_reordered", payload: {} });
      json(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/options") {
      json(res, 200, this.db.getOptions());
      return;
    }

    if (method === "GET" && pathname === "/api/branches") {
      json(res, 200, listGitBranches(this.ownerDirectory));
      return;
    }

    if (method === "PUT" && pathname === "/api/options") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.thinkingLevel !== undefined && !THINKING_LEVELS.has(String(body.thinkingLevel))) {
        json(res, 400, { error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" });
        return;
      }
      if (body.autoDeleteNormalSessions !== undefined && typeof body.autoDeleteNormalSessions !== "boolean") {
        json(res, 400, { error: "Invalid autoDeleteNormalSessions. Expected boolean." });
        return;
      }
      if (body.autoDeleteReviewSessions !== undefined && typeof body.autoDeleteReviewSessions !== "boolean") {
        json(res, 400, { error: "Invalid autoDeleteReviewSessions. Expected boolean." });
        return;
      }
      if (body.showExecutionGraph !== undefined && typeof body.showExecutionGraph !== "boolean") {
        json(res, 400, { error: "Invalid showExecutionGraph. Expected boolean." });
        return;
      }
      if (body.telegramBotToken !== undefined && typeof body.telegramBotToken !== "string") {
        json(res, 400, { error: "Invalid telegramBotToken. Expected a string." });
        return;
      }
      if (body.telegramChatId !== undefined && typeof body.telegramChatId !== "string") {
        json(res, 400, { error: "Invalid telegramChatId. Expected a string." });
        return;
      }

      for (const [key, value] of Object.entries(body)) {
        this.db.setOption(normalizeDbOptionKey(key), typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      }
      const options = this.db.getOptions();
      this.broadcast({ type: "options_updated", payload: options });
      json(res, 200, options);
      return;
    }

    if (method === "GET" && pathname === "/api/models") {
      json(res, 200, buildModelCatalog(this.db.getOptions()));
      return;
    }

    if (method === "POST" && pathname === "/api/start") {
      if (this.getExecuting()) {
        json(res, 409, { error: "Already executing" });
        return;
      }
      const preflightError = this.options.getStartError?.();
      if (preflightError) {
        json(res, classifyStartError(preflightError), { error: preflightError });
        return;
      }

      this.setExecuting(true);
      this.broadcast({ type: "execution_started", payload: {} });
      try {
        await this.options.onStart?.();
      } catch (error) {
        this.setExecuting(false);
        const message = error instanceof Error ? error.message : String(error);
        this.broadcast({ type: "error", payload: { message: `Execution failed: ${message}` } });
        this.broadcast({ type: "execution_stopped", payload: {} });
        json(res, 500, { error: message });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/execution-graph") {
      const tasks = this.db.getTasks();
      const graph = buildExecutionGraph(tasks, this.db.getOptions().parallelTasks);
      if (graph.totalTasks === 0) {
        json(res, 400, { error: "No tasks in backlog" });
        return;
      }
      json(res, 200, graph);
      return;
    }

    if (method === "POST" && pathname === "/api/stop") {
      this.options.onStop?.();
      this.setExecuting(false);
      this.broadcast({ type: "execution_stopped", payload: {} });
      json(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/workflow-sessions") {
      const entry = JSON.parse((await readBody(req)) || "{}") as WorkflowSessionEntry;
      this.db.registerWorkflowSession(entry);
      json(res, 201, { ok: true });
      return;
    }

    const workflowSessionMatch = method === "DELETE" ? pathname.match(/^\/api\/workflow-sessions\/([^/]+)$/) : null;
    if (workflowSessionMatch) {
      this.db.deleteWorkflowSession(workflowSessionMatch[1]);
      json(res, 200, { ok: true });
      return;
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const task = this.db.getTask(taskId);

      if (method === "GET") {
        if (!task) {
          json(res, 404, { error: "Task not found" });
          return;
        }
        json(res, 200, task);
        return;
      }

      if (method === "PATCH") {
        if (!task) {
          json(res, 404, { error: "Task not found" });
          return;
        }
        if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
          json(res, 409, { error: getExecutionMutationError() });
          return;
        }

        const body = JSON.parse((await readBody(req)) || "{}");
        const invalidBooleanField = getInvalidTaskBooleanField(body);
        if (invalidBooleanField) {
          json(res, 400, { error: `Invalid ${invalidBooleanField}. Expected boolean.` });
          return;
        }
        if (body.thinkingLevel !== undefined && !THINKING_LEVELS.has(String(body.thinkingLevel))) {
          json(res, 400, { error: "Invalid thinkingLevel. Allowed values: default, low, medium, high" });
          return;
        }
        if (body.executionStrategy !== undefined && !EXECUTION_STRATEGIES.has(String(body.executionStrategy))) {
          json(res, 400, { error: "Invalid executionStrategy. Allowed values: standard, best_of_n" });
          return;
        }

        const nextExecutionStrategy = body.executionStrategy ?? task.executionStrategy;
        const nextBestOfNConfig = body.bestOfNConfig ?? task.bestOfNConfig;
        if (nextExecutionStrategy === "best_of_n") {
          if (body.bestOfNConfig === null) {
            json(res, 400, { error: "bestOfNConfig cannot be set to null for best_of_n tasks" });
            return;
          }
          const validation = validateBestOfNConfig(nextBestOfNConfig);
          if (!validation.valid) {
            json(res, 400, { error: validation.error });
            return;
          }
        }
        if (body.executionStrategy === "standard" && body.bestOfNConfig !== undefined && body.bestOfNConfig !== null) {
          json(res, 400, { error: "bestOfNConfig must be null when executionStrategy is standard" });
          return;
        }
        if (body.planmode === true && nextExecutionStrategy === "best_of_n") {
          json(res, 400, { error: "planmode and best_of_n execution strategy cannot be combined in v1" });
          return;
        }
        if (body.status === "backlog" && body.executionPhase === undefined) {
          body.executionPhase = "not_started";
          body.awaitingPlanApproval = false;
          body.bestOfNSubstage = "idle";
        }

        const updated = this.updateTask(taskId, body);
        this.broadcast({ type: "task_updated", payload: updated });
        json(res, 200, updated);
        return;
      }

      if (method === "DELETE") {
        if (!task) {
          json(res, 404, { error: "Task not found" });
          return;
        }
        if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
          json(res, 409, { error: getExecutionMutationError() });
          return;
        }

        this.db.deleteTask(taskId);
        this.broadcast({ type: "task_deleted", payload: { id: taskId } });
        noContent(res);
        return;
      }
    }

    const startSingleMatch = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/start$/) : null;
    if (startSingleMatch) {
      if (this.getExecuting()) {
        json(res, 409, { error: "Already executing" });
        return;
      }
      const taskId = startSingleMatch[1];
      const task = this.db.getTask(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      if (!isTaskExecutable(task)) {
        json(res, 400, { error: "Task is not executable" });
        return;
      }
      const preflightError = this.options.getStartError?.(taskId);
      if (preflightError) {
        json(res, classifyStartError(preflightError), { error: preflightError });
        return;
      }

      this.setExecuting(true);
      this.broadcast({ type: "execution_started", payload: {} });
      try {
        if (this.options.onStartSingle) {
          await this.options.onStartSingle(taskId);
        } else if (this.orchestrator) {
          const updated = await this.orchestrator.startTask(taskId);
          this.broadcast({ type: "task_updated", payload: updated });
        }
      } catch (error) {
        this.setExecuting(false);
        const message = error instanceof Error ? error.message : String(error);
        this.broadcast({ type: "error", payload: { message: `Execution failed: ${message}` } });
        this.broadcast({ type: "execution_stopped", payload: {} });
        json(res, 500, { error: message });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    const approveMatch = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/approve-plan$/) : null;
    if (approveMatch) {
      const taskId = approveMatch[1];
      const task = this.db.getTask(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
        json(res, 409, { error: getExecutionMutationError() });
        return;
      }
      if (!hasCapturedPlanOutput(task.agentOutput)) {
        json(res, 400, { error: "Task has no captured plan output to approve. Reset it to backlog and rerun planning." });
        return;
      }
      if (!isTaskAwaitingPlanApproval(task)) {
        json(res, 400, { error: "Task is not awaiting plan approval" });
        return;
      }

      let approvalNote: string | undefined;
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.message === "string" && body.message.trim()) {
          approvalNote = body.message.trim();
        }
      } catch {
        // optional body
      }

      if (approvalNote) {
        const note = `[user-approval-note] ${approvalNote}\n`;
        const updatedOutput = `${task.agentOutput || ""}${note}`;
        this.updateTask(taskId, { agentOutput: updatedOutput });
        this.broadcast({ type: "agent_output", payload: { taskId, output: note } });
      }

      const updated = this.orchestrator
        ? await this.orchestrator.approvePlan(taskId)
        : this.updateTask(taskId, {
            awaitingPlanApproval: false,
            executionPhase: "implementation_pending",
            status: "backlog",
          });
      this.broadcast({ type: "task_updated", payload: updated });
      await this.maybeAutoStartExecution();
      json(res, 200, { ok: true });
      return;
    }

    const revisionMatch = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/request-plan-revision$/) : null;
    if (revisionMatch) {
      const taskId = revisionMatch[1];
      const task = this.db.getTask(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
        json(res, 409, { error: getExecutionMutationError() });
        return;
      }
      if (!hasCapturedPlanOutput(task.agentOutput)) {
        json(res, 400, { error: "Task has no captured plan output to revise" });
        return;
      }
      if (!isTaskAwaitingPlanApproval(task)) {
        json(res, 400, { error: "Task is not awaiting plan approval" });
        return;
      }

      let feedback = "";
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.feedback === "string") {
          feedback = body.feedback.trim();
        }
      } catch {
        // validated below
      }
      if (!feedback) {
        json(res, 400, { error: "Feedback cannot be empty" });
        return;
      }

      const revisionNote = `[user-revision-request] ${feedback}\n`;
      const updatedOutput = `${task.agentOutput || ""}${revisionNote}`;
      this.updateTask(taskId, { agentOutput: updatedOutput });
      this.broadcast({ type: "agent_output", payload: { taskId, output: revisionNote } });

      const updated = this.orchestrator
        ? await this.orchestrator.requestPlanRevision(taskId, feedback)
        : this.updateTask(taskId, {
            planRevisionCount: (task.planRevisionCount ?? 0) + 1,
            executionPhase: "plan_revision_pending",
            awaitingPlanApproval: false,
            status: "backlog",
          });
      this.broadcast({ type: "plan_revision_requested", payload: updated });
      this.broadcast({ type: "task_updated", payload: updated });
      await this.maybeAutoStartExecution();
      json(res, 200, { ok: true });
      return;
    }

    const repairMatch = method === "POST" ? pathname.match(/^\/api\/tasks\/([^/]+)\/repair-state$/) : null;
    if (repairMatch) {
      const taskId = repairMatch[1];
      const task = this.db.getTask(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      if (isTaskMutationLockedWhileExecuting(this.getExecuting(), task.status)) {
        json(res, 409, { error: getExecutionMutationError() });
        return;
      }

      let requestedAction: RepairAction | "smart" = "smart";
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.action === "string") {
          requestedAction = body.action as RepairAction | "smart";
        }
      } catch {
        // action optional
      }

      const action: RepairAction = requestedAction === "smart"
        ? (task.status === "review" && isTaskAwaitingPlanApproval(task)
            ? "restore_plan_approval"
            : hasCapturedPlanOutput(task.agentOutput)
              ? "queue_implementation"
              : "reset_backlog")
        : requestedAction;

      let updated: Task;
      if (action === "restore_plan_approval") {
        updated = this.updateTask(taskId, {
          status: "review",
          awaitingPlanApproval: true,
          executionPhase: "plan_complete_waiting_approval",
          errorMessage: null,
        });
      } else if (action === "mark_done") {
        updated = this.updateTask(taskId, {
          status: "done",
          awaitingPlanApproval: false,
          completedAt: nowMs(),
          errorMessage: null,
        });
      } else if (action === "fail_task") {
        updated = this.updateTask(taskId, {
          status: "failed",
          awaitingPlanApproval: false,
          errorMessage: task.errorMessage ?? "Task state is invalid",
        });
      } else if (action === "queue_implementation") {
        updated = this.updateTask(taskId, {
          status: "backlog",
          awaitingPlanApproval: false,
          executionPhase: task.executionPhase === "plan_revision_pending" ? "plan_revision_pending" : "implementation_pending",
          errorMessage: null,
          completedAt: null,
        });
      } else {
        updated = this.updateTask(taskId, {
          status: "backlog",
          reviewCount: 0,
          agentOutput: "",
          errorMessage: null,
          completedAt: null,
          sessionId: null,
          sessionUrl: null,
          worktreeDir: null,
          executionPhase: "not_started",
          awaitingPlanApproval: false,
          planRevisionCount: 0,
          bestOfNSubstage: "idle",
        });
      }

      this.broadcast({ type: "task_updated", payload: updated });
      if (action === "queue_implementation") {
        await this.maybeAutoStartExecution();
      }
      json(res, 200, { ok: true, action, task: updated });
      return;
    }

    const runsMatch = method === "GET" ? pathname.match(/^\/api\/tasks\/([^/]+)\/runs$/) : null;
    if (runsMatch) {
      const task = this.db.getTask(runsMatch[1]);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      json(res, 200, this.db.getTaskRuns(task.id));
      return;
    }

    const candidatesMatch = method === "GET" ? pathname.match(/^\/api\/tasks\/([^/]+)\/candidates$/) : null;
    if (candidatesMatch) {
      const task = this.db.getTask(candidatesMatch[1]);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      json(res, 200, this.db.getTaskCandidates(task.id));
      return;
    }

    const summaryMatch = method === "GET" ? pathname.match(/^\/api\/tasks\/([^/]+)\/best-of-n-summary$/) : null;
    if (summaryMatch) {
      const task = this.db.getTask(summaryMatch[1]);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      if (task.executionStrategy !== "best_of_n") {
        json(res, 400, { error: "Task is not a best_of_n task" });
        return;
      }
      json(res, 200, summarizeBestOfN(this.db, task));
      return;
    }

    json(res, 404, { error: "Not found" });
  }
}
