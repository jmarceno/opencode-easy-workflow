import { configLoader } from "../src/config";
import { getKanbanDb, getOrchestrator } from "../src/kanban/runtime";
import { KanbanServer } from "../src/kanban/server";

await configLoader.load();
const config = configLoader.getConfig();
const db = getKanbanDb();
const orchestrator = getOrchestrator();
const port = Number(process.env.KANBAN_PORT || config.port || db.getOptions().port || 3847);
db.setOption("port", String(port));

if (db.getTasks().length === 0) {
  db.createTask({
    id: `task${Date.now().toString(36)}`,
    name: "Smoke test task",
    prompt: "Verify the kanban UI can create, edit, and start tasks.",
    branch: config.defaultBranch,
    planModel: config.planModel,
    executionModel: config.executionModel,
    review: true,
    autoCommit: config.autoCommit,
    deleteWorktree: config.deleteWorktree,
    status: "backlog",
  });
}

const server = new KanbanServer(db, {
  ownerDirectory: process.cwd(),
  orchestrator,
  onStart: async () => {
    console.log("[kanban-dev-server] onStart invoked");
  },
  onStartSingle: async (taskId: string) => {
    console.log("[kanban-dev-server] onStartSingle invoked", { taskId });
    const task = await orchestrator.startTask(taskId);
    server.broadcast({ type: "task_updated", payload: task });
  },
  onStop: () => {
    console.log("[kanban-dev-server] onStop invoked");
  },
  getExecuting: () => false,
  getStartError: () => null,
});

const listeningPort = server.start();
console.log(`[kanban-dev-server] listening on http://127.0.0.1:${listeningPort}`);

const shutdown = () => {
  console.log("[kanban-dev-server] shutting down");
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
