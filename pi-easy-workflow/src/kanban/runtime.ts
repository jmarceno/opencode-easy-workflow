import { mkdirSync } from "fs";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { KanbanDB } from "./db";
import { Orchestrator } from "./orchestrator";

let dbSingleton: KanbanDB | null = null;
let orchestratorSingleton: Orchestrator | null = null;

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
