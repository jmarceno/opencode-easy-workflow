/**
 * Kanban HTTP Server
 *
 * Provides REST API for kanban task management.
 * Adapted from OpenCode plugin for pi extension.
 */

import type { Server as HTTPServer } from "http";
import type { AddressInfo } from "net";
import { KanbanDB, type WorkflowSessionEntry } from "./db";
import type { Task, TaskStatus, Options } from "./types";

export interface KanbanServerOptions {
  onStart?: () => Promise<void>;
  onStartSingle?: (taskId: string) => Promise<void>;
  onStop?: () => void;
  getExecuting?: () => boolean;
  getStartError?: (taskId?: string) => string | null;
  getServerUrl?: () => string | null;
  ownerDirectory?: string;
}

type TaskCreate = Partial<Task> & { name: string };
type TaskUpdate = Partial<Task>;

export class KanbanServer {
  private db: KanbanDB;
  private options: KanbanServerOptions;
  private server: HTTPServer | null = null;
  private port: number;

  constructor(db: KanbanDB, options: KanbanServerOptions = {}) {
    this.db = db;
    this.options = options;
    this.port = db.getOptions().port;
  }

  start(): number {
    if (this.server) {
      return this.port;
    }

    const port = this.port;

    this.server = new HTTPServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: message }));
      }
    });

    this.server.listen(port, () => {
      this.port = (this.server!.address() as AddressInfo).port;
      this.options.onStart?.();
    });

    return this.port;
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.options.onStop?.();
    }
  }

  getPort(): number {
    return this.port;
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const pathname = url.pathname;
    const method = req.method;

    // Route: /api/tasks
    if (pathname === "/api/tasks" && method === "GET") {
      const status = url.searchParams.get("status") as TaskStatus | null;
      const tasks = this.db.getTasks(status ?? undefined);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tasks));
      return;
    }

    if (pathname === "/api/tasks" && method === "POST") {
      const body = await this.readBody(req);
      const taskData = JSON.parse(body) as TaskCreate;

      if (!taskData.name) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Task name is required" }));
        return;
      }

      const task = this.db.createTask({
        id: taskData.id ?? `task_${Date.now()}`,
        name: taskData.name,
        prompt: taskData.prompt ?? "",
        branch: taskData.branch ?? "",
        status: taskData.status ?? "backlog",
        requirements: taskData.requirements ?? [],
        review: taskData.review ?? true,
        autoCommit: taskData.autoCommit ?? true,
        deleteWorktree: taskData.deleteWorktree ?? true,
        planmode: taskData.planmode ?? false,
        planModel: taskData.planModel ?? "default",
        executionModel: taskData.executionModel ?? "default",
        thinkingLevel: taskData.thinkingLevel ?? "default",
        executionStrategy: taskData.executionStrategy ?? "standard",
        bestOfNConfig: taskData.bestOfNConfig ?? null,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
      return;
    }

    // Route: /api/tasks/:id
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];

      if (method === "GET") {
        const task = this.db.getTask(taskId);
        if (!task) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(task));
        return;
      }

      if (method === "PATCH") {
        const body = await this.readBody(req);
        const updates = JSON.parse(body) as TaskUpdate;
        const task = this.db.updateTask(taskId, updates);
        if (!task) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(task));
        return;
      }

      if (method === "DELETE") {
        const deleted = this.db.deleteTask(taskId);
        res.writeHead(deleted ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: deleted }));
        return;
      }
    }

    // Route: /api/tasks/reorder
    if (pathname === "/api/tasks/reorder" && method === "PUT") {
      const body = await this.readBody(req);
      const taskIds = JSON.parse(body) as string[];
      this.db.reorderTasks(taskIds);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Route: /api/tasks/:id/approve-plan
    const approveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approve-plan$/);
    if (approveMatch && method === "POST") {
      const taskId = approveMatch[1];
      const task = this.db.updateTask(taskId, {
        status: "backlog",
        executionPhase: "implementation_pending",
        awaitingPlanApproval: false,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task));
      return;
    }

    // Route: /api/options
    if (pathname === "/api/options" && method === "GET") {
      const options = this.db.getOptions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(options));
      return;
    }

    if (pathname === "/api/options" && method === "PUT") {
      const body = await this.readBody(req);
      const updates = JSON.parse(body) as Partial<Options>;

      for (const [key, value] of Object.entries(updates)) {
        const dbKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
        this.db.setOption(dbKey, String(value));
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.db.getOptions()));
      return;
    }

    // Route: /api/branches
    if (pathname === "/api/branches" && method === "GET") {
      // TODO: Implement - list git branches
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // Route: /api/workflow-sessions
    if (pathname === "/api/workflow-sessions" && method === "POST") {
      const body = await this.readBody(req);
      const entry = JSON.parse(body) as WorkflowSessionEntry;
      this.db.registerWorkflowSession(entry);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Route: /api/workflow-sessions/:sessionId
    const sessionMatch = pathname.match(/^\/api\/workflow-sessions\/([^/]+)$/);
    if (sessionMatch && method === "DELETE") {
      const sessionId = sessionMatch[1];
      this.db.deleteWorkflowSession(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Route: /api/health
    if (pathname === "/api/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: this.port }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private readBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: any) => {
        body += chunk;
      });
      req.on("end", () => {
        resolve(body);
      });
      req.on("error", reject);
    });
  }
}
