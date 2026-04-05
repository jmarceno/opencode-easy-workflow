import { mkdirSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { configLoader } from "../config";
import { KanbanDB } from "./db";
import { Orchestrator } from "./orchestrator";
import { KanbanServer } from "./server";

let dbSingleton: KanbanDB | null = null;
let orchestratorSingleton: Orchestrator | null = null;
let serverSingleton: KanbanServer | null = null;
let executing = false;

function getDataDir(): string {
  const dir = join(process.cwd(), ".pi", "easy-workflow");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getKanbanDb(): KanbanDB {
  if (!dbSingleton) {
    dbSingleton = new KanbanDB(join(getDataDir(), "kanban.sqlite"));
  }
  return dbSingleton;
}

export function getOrchestrator(pi?: ExtensionAPI): Orchestrator {
  if (!orchestratorSingleton) {
    orchestratorSingleton = new Orchestrator(getKanbanDb(), pi);
  }
  return orchestratorSingleton;
}

export function getKanbanServer(pi?: ExtensionAPI): KanbanServer {
  if (!serverSingleton) {
    const config = configLoader.getConfig();
    const db = getKanbanDb();
    db.setOption("port", String(config.port));
    const orchestrator = getOrchestrator(pi);

    serverSingleton = new KanbanServer(db, {
      ownerDirectory: process.cwd(),
      orchestrator,
      onStart: async () => {
        executing = true;
      },
      onStartSingle: async (taskId: string) => {
        executing = true;
        const task = await orchestrator.startTask(taskId);
        serverSingleton?.broadcast({ type: "task_updated", payload: task });
      },
      onStop: () => {
        executing = false;
      },
      getExecuting: () => executing,
      getStartError: () => null,
    });
  }
  return serverSingleton;
}

export function startKanbanServer(pi?: ExtensionAPI): KanbanServer {
  const server = getKanbanServer(pi);
  server.start();
  return server;
}

export function stopKanbanServer(): void {
  serverSingleton?.stop();
  serverSingleton = null;
  executing = false;
}
