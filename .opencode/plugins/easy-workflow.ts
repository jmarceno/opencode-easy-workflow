import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Kanban modules
import { KanbanDB } from "../easy-workflow/db";
import { KanbanServer } from "../easy-workflow/server";
import { Orchestrator } from "../easy-workflow/orchestrator";

// ---- Existing workflow types ----

type WorkflowStatus = "pending" | "running" | "completed" | "blocked";
type ReviewStatus = "pass" | "gaps_found" | "blocked";

interface WorkflowRunState {
  reviewAgent?: string | null;
  runreview: boolean;
  running: boolean;
  status: WorkflowStatus;
  reviewCount: number;
  maxReviewRuns: number;
  createdAt: string | null;
  updatedAt: string | null;
  sessionId: string | null;
  promptHash: string | null;
  lastReviewedAt: string | null;
  lastReviewFingerprint: string | null;
  lastReviewStatus?: ReviewStatus;
  lastRecommendedPrompt?: string;
  lastGapCount?: number;
  version: number;
}

interface ExtractedGoals {
  summary: string;
  goals: string[];
}

interface ReviewResult {
  status: ReviewStatus;
  summary: string;
  gaps: string[];
  recommendedPrompt: string;
}

interface PromptParseResult {
  valid: boolean;
  cleanedPrompt: string;
  normalizedPrompt: string;
}

interface RunFile {
  state: WorkflowRunState;
  body: string;
}

interface TemplateConfig {
  reviewAgent: string | null;
}

interface AgentConfig {
  name: string;
  path: string;
  mode: string | null;
  model: string | null;
}

interface SessionPromptContext {
  agent?: string;
  model?: { providerID: string; modelID: string };
}

// ---- Constants ----

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ROOT = join(__dirname, "..", "easy-workflow");
const RUNS_DIR = join(WORKFLOW_ROOT, "runs");
const TEMPLATE_PATH = join(WORKFLOW_ROOT, "workflow.md");
const AGENTS_DIR = join(__dirname, "..", "agents");
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "debug.log");
const WORKFLOW_MARKER = "#workflow";
const GOALS_PLACEHOLDER = "[REPLACE THIS WITH THE TASK GOALS]";
const REVIEW_SECTION_MARKER = "## Persisted Review Result";
const REVIEW_COOLDOWN_MS = 30_000;

// ---- Kanban globals ----

let kanbanDb: KanbanDB | null = null;
let kanbanServer: KanbanServer | null = null;
let orchestrator: Orchestrator | null = null;

// ---- Utility functions ----

function formatErrorToast(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return `Workflow blocked: ${singleLine}`;
  }
  return `Workflow blocked: ${singleLine.slice(0, 157)}...`;
}

const FRONTMATTER_KEYS: Array<keyof WorkflowRunState> = [
  "reviewAgent",
  "runreview",
  "running",
  "status",
  "reviewCount",
  "maxReviewRuns",
  "createdAt",
  "updatedAt",
  "sessionId",
  "promptHash",
  "lastReviewedAt",
  "lastReviewFingerprint",
  "lastReviewStatus",
  "lastRecommendedPrompt",
  "lastGapCount",
  "version",
];

function parseWorkflowPrompt(input: string): PromptParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { valid: false, cleanedPrompt: "", normalizedPrompt: "" };
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const lastToken = tokens[tokens.length - 1];

  if (firstToken === WORKFLOW_MARKER) {
    const cleanedPrompt = trimmed.replace(/^#workflow(?=\s|$)\s*/, "");
    return {
      valid: true,
      cleanedPrompt,
      normalizedPrompt: cleanedPrompt.trim(),
    };
  }

  if (lastToken === WORKFLOW_MARKER) {
    const cleanedPrompt = trimmed.replace(/\s*#workflow$/, "");
    return {
      valid: true,
      cleanedPrompt,
      normalizedPrompt: cleanedPrompt.trim(),
    };
  }

  return {
    valid: false,
    cleanedPrompt: trimmed,
    normalizedPrompt: trimmed,
  };
}

function createRunHash(normalizedPrompt: string, createdAt: string): string {
  return createHash("md5").update(normalizedPrompt + createdAt).digest("hex");
}

function getRunPath(promptHash: string): string {
  return join(RUNS_DIR, `${promptHash}.md`);
}

function getAgentPath(agentName: string): string {
  return join(AGENTS_DIR, `${agentName}.md`);
}

function ensureWorkflowDirectories(): void {
  mkdirSync(WORKFLOW_ROOT, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
}

function appendDebugLog(kind: string, message: string, extra?: Record<string, unknown>): void {
  ensureWorkflowDirectories();
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${kind}: ${message}${payload}\n`, "utf-8");
}

function loadTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf-8");
}

function parseScalar(rawValue: string): unknown {
  if (rawValue === "null") {
    return null;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
    return Number(rawValue);
  }

  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("[") && rawValue.endsWith("]"))) {
    try {
      return JSON.parse(rawValue);
    } catch {
      return rawValue;
    }
  }

  return rawValue;
}

function serializeScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  return JSON.stringify(String(value));
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, frontmatterText, body] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    frontmatter[key] = parseScalar(rawValue);
  }

  return { frontmatter, body };
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAgentKey(value: unknown): string | null {
  const name = normalizeAgentName(value);
  if (!name) {
    return null;
  }

  return name.toLowerCase().replace(/[\s_]+/g, "-");
}

function unwrapResponseData<T>(response: any): T {
  if (response && typeof response === "object" && "data" in response) {
    return response.data as T;
  }

  return response as T;
}

function getAssistantErrorMessage(error: any): string {
  if (!error) {
    return "Unknown assistant error";
  }

  if (typeof error.data?.message === "string" && error.data.message.trim()) {
    const statusCode = typeof error.data?.statusCode === "number" ? ` (status ${error.data.statusCode})` : "";
    return `${error.data.message}${statusCode}`;
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }

  if (typeof error.name === "string" && error.name.trim()) {
    return error.name;
  }

  return JSON.stringify(error);
}

function getAssistantErrorDetails(error: any): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const details: Record<string, unknown> = {};
  if (typeof error.name === "string") {
    details.name = error.name;
  }

  if (typeof error.message === "string") {
    details.message = error.message;
  }

  if (error.data !== undefined) {
    details.data = error.data;
  }

  if (error.cause !== undefined) {
    details.cause = error.cause;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function parseModelSelection(value: string): { providerID: string; modelID: string } | null {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf("/");

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }

  const providerID = trimmed.slice(0, separatorIndex).trim();
  const modelID = trimmed.slice(separatorIndex + 1).trim();
  return providerID && modelID ? { providerID, modelID } : null;
}

function inspectTemplateConfig(template: string): TemplateConfig {
  const { frontmatter } = parseFrontmatter(template);
  return {
    reviewAgent: normalizeAgentName(frontmatter.reviewAgent),
  };
}

function loadReviewAgentConfig(agentName: string): AgentConfig {
  const path = getAgentPath(agentName);

  if (!existsSync(path)) {
    throw new Error(`Workflow review agent file is missing: ${path}`);
  }

  const content = readFileSync(path, "utf-8");
  const { frontmatter } = parseFrontmatter(content);
  const mode = typeof frontmatter.mode === "string" ? frontmatter.mode.trim() : null;
  const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : null;

  if (mode !== "subagent") {
    throw new Error(`Workflow review agent must declare mode: subagent in ${path}`);
  }

  if (!model) {
    throw new Error(`Workflow review agent must declare a model in ${path}`);
  }

  if (!parseModelSelection(model)) {
    throw new Error(`Workflow review agent model is invalid in ${path}: ${model}`);
  }

  return { name: agentName, path, mode, model };
}

function buildRunState(frontmatter: Record<string, unknown>): WorkflowRunState {
  return {
    reviewAgent: normalizeAgentName(frontmatter.reviewAgent),
    runreview: frontmatter.runreview === true,
    running: frontmatter.running === true,
    status: (frontmatter.status as WorkflowStatus) ?? "pending",
    reviewCount: typeof frontmatter.reviewCount === "number" ? frontmatter.reviewCount : 0,
    maxReviewRuns: typeof frontmatter.maxReviewRuns === "number" ? frontmatter.maxReviewRuns : 2,
    createdAt: typeof frontmatter.createdAt === "string" ? frontmatter.createdAt : null,
    updatedAt: typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : null,
    sessionId: typeof frontmatter.sessionId === "string" ? frontmatter.sessionId : null,
    promptHash: typeof frontmatter.promptHash === "string" ? frontmatter.promptHash : null,
    lastReviewedAt: typeof frontmatter.lastReviewedAt === "string" ? frontmatter.lastReviewedAt : null,
    lastReviewFingerprint: typeof frontmatter.lastReviewFingerprint === "string" ? frontmatter.lastReviewFingerprint : null,
    lastReviewStatus: typeof frontmatter.lastReviewStatus === "string" ? (frontmatter.lastReviewStatus as ReviewStatus) : undefined,
    lastRecommendedPrompt: typeof frontmatter.lastRecommendedPrompt === "string" ? frontmatter.lastRecommendedPrompt : undefined,
    lastGapCount: typeof frontmatter.lastGapCount === "number" ? frontmatter.lastGapCount : undefined,
    version: typeof frontmatter.version === "number" ? frontmatter.version : 1,
  };
}

function serializeFrontmatter(state: WorkflowRunState): string {
  const lines = ["---"];

  for (const key of FRONTMATTER_KEYS) {
    const value = state[key];
    if (value === undefined) {
      continue;
    }

    lines.push(`${key}: ${serializeScalar(value)}`);
  }

  lines.push("---");
  return lines.join("\n");
}

function createRunFile(template: string, state: WorkflowRunState): string {
  const { body } = parseFrontmatter(template);
  return `${serializeFrontmatter(state)}\n${body}`;
}

function readRunFile(runPath: string): RunFile {
  const content = readFileSync(runPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);
  return { state: buildRunState(frontmatter), body };
}

function writeRunFile(runPath: string, state: WorkflowRunState, body: string): void {
  writeFileSync(runPath, `${serializeFrontmatter(state)}\n${body}`, "utf-8");
}

function updateRunFileState(runPath: string, updates: Partial<WorkflowRunState>): WorkflowRunState {
  const { state, body } = readRunFile(runPath);
  const nextState: WorkflowRunState = {
    ...state,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  writeRunFile(runPath, nextState, body);
  return nextState;
}

function formatGoals(goals: ExtractedGoals): string {
  const items = goals.goals.length > 0
    ? goals.goals.map((goal, index) => `${index + 1}. ${goal}`).join("\n")
    : "1. Review the implementation against the user request.";

  return `## Task Summary\n\n${goals.summary}\n\n## Goals\n\n${items}`;
}

function writeGoalsToRunFile(runPath: string, goals: ExtractedGoals): void {
  const { state, body } = readRunFile(runPath);

  if (!body.includes(GOALS_PLACEHOLDER)) {
    throw new Error("Workflow template is missing the goals placeholder");
  }

  const nextBody = body.replace(GOALS_PLACEHOLDER, formatGoals(goals));
  writeRunFile(
    runPath,
    {
      ...state,
      updatedAt: new Date().toISOString(),
    },
    nextBody,
  );
}

function findReviewSectionIndex(body: string): number {
  return body.indexOf(REVIEW_SECTION_MARKER);
}

function getReviewSourceBody(body: string): string {
  const reviewSectionIndex = findReviewSectionIndex(body);
  return (reviewSectionIndex === -1 ? body : body.slice(0, reviewSectionIndex)).trimEnd();
}

function replaceReviewSection(body: string, reviewSection: string): string {
  const reviewSectionIndex = findReviewSectionIndex(body);
  const stableBody = (reviewSectionIndex === -1 ? body : body.slice(0, reviewSectionIndex)).trimEnd();
  return `${stableBody}\n\n${reviewSection}\n`;
}

function renderReviewSection(result: ReviewResult, reviewedAt: string): string {
  const gaps = result.gaps.length > 0
    ? result.gaps.map((gap, index) => `${index + 1}. ${gap}`).join("\n")
    : "None.";
  const recommendedPrompt = result.recommendedPrompt.trim() || "None.";

  return [
    REVIEW_SECTION_MARKER,
    "",
    `Reviewed At: ${reviewedAt}`,
    `Status: ${result.status}`,
    "",
    "### Summary",
    result.summary,
    "",
    "### Gaps",
    gaps,
    "",
    "### Recommended Prompt",
    recommendedPrompt,
  ].join("\n");
}

function normalizeReviewResult(result: ReviewResult): ReviewResult {
  return {
    status: result.status,
    summary: result.summary.trim(),
    gaps: result.gaps.map((gap) => gap.trim()).filter(Boolean),
    recommendedPrompt: result.recommendedPrompt.trim(),
  };
}

function findActiveRunForSession(sessionId: string): { runPath: string; state: WorkflowRunState } | null {
  if (!existsSync(RUNS_DIR)) {
    return null;
  }

  const candidates = readdirSync(RUNS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const runPath = join(RUNS_DIR, file);
      const { state } = readRunFile(runPath);
      return { runPath, state };
    })
    .filter(({ state }) => state.sessionId === sessionId && state.runreview);

  candidates.sort((left, right) => {
    const leftCreatedAt = left.state.createdAt ?? "";
    const rightCreatedAt = right.state.createdAt ?? "";
    return rightCreatedAt.localeCompare(leftCreatedAt);
  });

  return candidates[0] ?? null;
}

function computeFingerprint(result: ReviewResult): string {
  const normalized = JSON.stringify({
    status: result.status,
    summary: result.summary.toLowerCase().trim(),
    gaps: [...result.gaps].map((gap) => gap.toLowerCase().trim()).sort(),
    recommendedPrompt: result.recommendedPrompt.toLowerCase().trim(),
  });

  return createHash("md5").update(normalized).digest("hex");
}

function shouldRunReview(state: WorkflowRunState, now: string): { allowed: boolean; reason?: string } {
  if (!state.runreview) {
    return { allowed: false, reason: "runreview is false" };
  }

  if (state.running) {
    return { allowed: false, reason: "running is true" };
  }

  if (state.reviewCount >= state.maxReviewRuns) {
    return { allowed: false, reason: "max review runs reached" };
  }

  if (state.lastReviewedAt) {
    const elapsedMs = new Date(now).getTime() - new Date(state.lastReviewedAt).getTime();
    if (elapsedMs < REVIEW_COOLDOWN_MS) {
      return { allowed: false, reason: "cooldown not elapsed" };
    }
  }

  return { allowed: true };
}

function getUserTextPart(output: any): any | null {
  if (!Array.isArray(output?.parts)) {
    return null;
  }

  return output.parts.find((part: any) => part?.type === "text" && typeof part.text === "string") ?? null;
}

function extractSessionId(...sources: any[]): string | null {
  for (const source of sources) {
    const candidates = [
      source?.sessionId,
      source?.sessionID,
      source?.session?.id,
      source?.properties?.sessionId,
      source?.properties?.sessionID,
      source?.path?.id,
    ];

    const sessionId = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
    if (typeof sessionId === "string") {
      return sessionId;
    }
  }

  return null;
}

function appAgentMatchesName(agent: unknown, name: string): boolean {
  const target = normalizeAgentKey(name);
  if (!target) {
    return false;
  }

  if (typeof agent === "string") {
    return normalizeAgentKey(agent) === target;
  }

  if (!agent || typeof agent !== "object") {
    return false;
  }

  const candidate = agent as Record<string, unknown>;
  return [candidate.name, candidate.id, candidate.slug]
    .map((value) => normalizeAgentKey(value))
    .some((value) => value === target);
}

function buildReviewAgentPrompt(agentName: string, runPath: string): string {
  return [
    `@${agentName}`,
    "",
    "Review the current repository state against the workflow run file below.",
    "Use the run file prompt and goals as the only workflow source of truth.",
    "Do not rely on prior session history.",
    "Inspect the current codebase and branch state.",
    "Return the structured output requested by the active response schema.",
    "",
    `Workflow run file: ${runPath}`,
  ].join("\n");
}

async function log(client: any, level: string, message: string, extra?: Record<string, unknown>): Promise<void> {
  appendDebugLog(level, message, extra);
  await client.app.log({
    body: {
      service: "easy-workflow",
      level,
      message,
      extra,
    },
  });
}

async function showToast(client: any, message: string, variant?: string): Promise<void> {
  await client.tui.showToast({
    body: {
      message,
      variant,
      duration: 15000,
    },
  });
}

async function ensureReviewAgentAvailable(client: any, agent: AgentConfig): Promise<void> {
  const agents = unwrapResponseData<any[]>(await client.app.agents());
  const availableAgents = Array.isArray(agents)
    ? agents.map((item: any) => ({
        name: item?.name,
        mode: item?.mode,
        builtIn: item?.builtIn,
        model: item?.model ? `${item.model.providerID}/${item.model.modelID}` : null,
      }))
    : [];

  appendDebugLog("info", "available agents snapshot", {
    requestedAgent: agent.name,
    agents: availableAgents,
  });

  if (!Array.isArray(agents) || !agents.some((item) => appAgentMatchesName(item, agent.name))) {
    throw new Error(`Workflow review agent is not loaded by OpenCode: ${agent.name}. See .opencode/easy-workflow/debug.log for available agents.`);
  }
}

async function extractGoals(client: any, cleanedPrompt: string, context?: SessionPromptContext): Promise<ExtractedGoals> {
  const promptText = [
    "Convert the user request into explicit implementation-reviewable goals.",
    "Keep the goals concrete and testable.",
    "Do not add requirements that are not implied by the request.",
    "",
    "Respond in this exact format:",
    "SUMMARY: <one sentence summary of the task>",
    "GOALS:",
    "- <first specific goal>",
    "- <second specific goal>",
    "- <additional goals as needed>",
    "",
    `Task request: ${cleanedPrompt}`,
  ].join("\n");

  const session = unwrapResponseData<any>(await client.session.create({
    title: "Workflow Goal Extraction",
  }));

  const scratchSessionId = session?.id;
  if (typeof scratchSessionId !== "string" || scratchSessionId.length === 0) {
    throw new Error("Unable to create scratch session for goal extraction");
  }

  try {
    const response = await client.session.prompt({
      sessionID: scratchSessionId,
      agent: context?.agent,
      model: context?.model,
      parts: [{ type: "text", text: promptText }],
    });

    const result = unwrapResponseData<any>(response);
    const textPart = result?.parts?.find((part: any) => part?.type === "text" && typeof part.text === "string");
    const responseText = textPart?.text ?? "";

    const summaryMatch = responseText.match(/SUMMARY:\s*(.+?)(?:\nGOALS:|\n\n|$)/is);
    const goalsMatch = responseText.match(/GOALS:\s*([\s\S]+?)(?:\n\n|$)/is);

    const summary = summaryMatch?.[1]?.trim() || "Extract goals from the user request";
    const goalsText = goalsMatch?.[1] || "";
    const goals = goalsText
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("- ") || line.startsWith("* "))
      .map(line => line.replace(/^[-*]\s+/, "").trim())
      .filter(goal => goal.length > 0);

    if (goals.length === 0) {
      goals.push("Review and implement the requested changes");
    }

    return { summary, goals };
  } finally {
    await client.session.delete({ sessionID: scratchSessionId }).catch(() => undefined);
  }
}

async function runReview(client: any, sessionId: string, runPath: string, runFile: RunFile): Promise<ReviewResult> {
  const reviewAgentName = normalizeAgentName(runFile.state.reviewAgent);
  if (!reviewAgentName) {
    throw new Error("Workflow run is missing a review agent");
  }

  const agentConfig = loadReviewAgentConfig(reviewAgentName);
  await ensureReviewAgentAvailable(client, agentConfig);

  await log(client, "info", "workflow review routed through subagent", {
    sessionId,
    runPath,
    reviewAgent: agentConfig.name,
    agentPath: agentConfig.path,
    agentMode: agentConfig.mode,
    agentModel: agentConfig.model,
  });

  const promptText = buildReviewAgentPrompt(reviewAgentName, runPath);
  const response = await client.session.prompt({
    sessionID: sessionId,
    agent: reviewAgentName,
    parts: [{ type: "text", text: promptText }],
  });

  const result = unwrapResponseData<any>(response);
  const textPart = result?.parts?.find((part: any) => part?.type === "text" && typeof part.text === "string");
  const responseText = textPart?.text ?? "";

  const statusMatch = responseText.match(/STATUS:\s*(\w+)/i);
  const summaryMatch = responseText.match(/SUMMARY:\s*([\s\S]+?)(?=\nGAPS:|$)/i);
  const gapsMatch = responseText.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_PROMPT:|$)/i);
  const recommendedMatch = responseText.match(/RECOMMENDED_PROMPT:\s*([\s\S]+?)$/i);

  const status = (statusMatch?.[1]?.toLowerCase().trim() || "blocked") as ReviewStatus;
  const summary = summaryMatch?.[1]?.trim() || "Review could not be completed";
  
  const gapsText = gapsMatch?.[1] || "";
  const gaps = gapsText
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- ") || line.startsWith("* "))
    .map(line => line.replace(/^[-*]\s+/, "").trim())
    .filter(gap => gap.length > 0 && gap.toLowerCase() !== "none");

  const recommendedPrompt = recommendedMatch?.[1]?.trim() || "";

  return {
    status: ["pass", "gaps_found", "blocked"].includes(status) ? status : "blocked",
    summary,
    gaps,
    recommendedPrompt: recommendedPrompt.toLowerCase() === "none" ? "" : recommendedPrompt,
  };
}

function finalizeReviewResult(runPath: string, result: ReviewResult, fingerprint: string): { duplicate: boolean; state: WorkflowRunState } {
  const now = new Date().toISOString();
  const { state, body } = readRunFile(runPath);

  if (state.lastReviewFingerprint && state.lastReviewFingerprint === fingerprint) {
    const duplicateState = updateRunFileState(runPath, {
      lastReviewedAt: now,
    });
    return { duplicate: true, state: duplicateState };
  }

  const nextBody = replaceReviewSection(body, renderReviewSection(result, now));
  const nextReviewCount = result.status === "gaps_found" ? state.reviewCount + 1 : state.reviewCount;
  const nextState: WorkflowRunState = {
    ...state,
    runreview: result.status === "gaps_found",
    running: state.running,
    status: result.status === "pass" ? "completed" : result.status === "blocked" ? "blocked" : "pending",
    reviewCount: nextReviewCount,
    lastReviewedAt: now,
    lastReviewFingerprint: fingerprint,
    lastReviewStatus: result.status,
    lastRecommendedPrompt: result.recommendedPrompt,
    lastGapCount: result.gaps.length,
    updatedAt: now,
  };

  writeRunFile(runPath, nextState, nextBody);
  return { duplicate: false, state: nextState };
}

function blockRun(runPath: string, summary: string, options?: { reviewed?: boolean }): void {
  const now = new Date().toISOString();
  const reviewed = options?.reviewed ?? true;
  const result: ReviewResult = {
    status: "blocked",
    summary,
    gaps: [],
    recommendedPrompt: "",
  };

  const { state, body } = readRunFile(runPath);
  const nextState: WorkflowRunState = {
    ...state,
    runreview: false,
    running: false,
    status: "blocked",
    lastReviewedAt: reviewed ? now : state.lastReviewedAt,
    lastReviewFingerprint: reviewed ? computeFingerprint(result) : state.lastReviewFingerprint,
    lastReviewStatus: reviewed ? "blocked" : state.lastReviewStatus,
    lastRecommendedPrompt: reviewed ? "" : state.lastRecommendedPrompt,
    lastGapCount: reviewed ? 0 : state.lastGapCount,
    updatedAt: now,
  };

  writeRunFile(runPath, nextState, replaceReviewSection(body, renderReviewSection(result, now)));
}

async function withRunningLock<T>(runPath: string, fn: () => Promise<T>): Promise<T> {
  updateRunFileState(runPath, { running: true, status: "running" });

  try {
    return await fn();
  } finally {
    updateRunFileState(runPath, { running: false });
  }
}

// ---- Plugin export ----

export const EasyWorkflowPlugin = async ({ client, directory, serverUrl }: any) => {
  await log(client, "info", "workflow plugin initialized", {
    templatePath: TEMPLATE_PATH,
    runsDir: RUNS_DIR,
    agentsDir: AGENTS_DIR,
  });

  // Initialize kanban system (non-blocking)
  (async () => {
    try {
      const dbPath = join(directory || WORKFLOW_ROOT, ".opencode", "easy-workflow", "tasks.db");
      kanbanDb = new KanbanDB(dbPath);

      kanbanServer = new KanbanServer(kanbanDb, {
        onStart: async () => {
          if (orchestrator) await orchestrator.start();
        },
        onStop: () => {
          if (orchestrator) orchestrator.stop();
        },
        getExecuting: () => orchestrator?.isExecuting() ?? false,
      });

      orchestrator = new Orchestrator(kanbanDb, kanbanServer, "http://localhost:4096", directory || process.cwd());

      const port = kanbanServer.start();
      await log(client, "info", "kanban server started", { port });
      await showToast(client, `Kanban board: http://localhost:${port}`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(client, "error", "kanban initialization failed", { error: msg });
    }
  })();

  return {
    "chat.message": async (input: any, output: any) => {
      const textPart = getUserTextPart(output);
      const promptText = textPart?.text ?? "";
      const { valid, cleanedPrompt, normalizedPrompt } = parseWorkflowPrompt(promptText);

      if (!valid) {
        return;
      }

      if (!normalizedPrompt) {
        return;
      }

      textPart.text = cleanedPrompt;

      await log(client, "info", "workflow activation requested");

      let runPath: string | null = null;

      try {
        const sessionId = extractSessionId(input, output);
        if (!sessionId) {
          throw new Error("Missing session id in prompt hook payload");
        }

        ensureWorkflowDirectories();

        const createdAt = new Date().toISOString();
        const promptHash = createRunHash(normalizedPrompt, createdAt);
        runPath = getRunPath(promptHash);
        const template = loadTemplate();
        const templateConfig = inspectTemplateConfig(template);

        if (!templateConfig.reviewAgent) {
          await log(client, "error", "workflow review agent missing from template", {
            runPath,
            sessionId,
            templatePath: TEMPLATE_PATH,
          });
          throw new Error("Workflow template is missing reviewAgent frontmatter");
        }

        const reviewAgent = loadReviewAgentConfig(templateConfig.reviewAgent);
        await ensureReviewAgentAvailable(client, reviewAgent);

        await log(client, "info", "workflow review agent validated", {
          runPath,
          sessionId,
          reviewAgent: reviewAgent.name,
          agentPath: reviewAgent.path,
          agentMode: reviewAgent.mode,
          agentModel: reviewAgent.model,
        });

        const initialState: WorkflowRunState = {
          reviewAgent: reviewAgent.name,
          runreview: true,
          running: false,
          status: "pending",
          reviewCount: 0,
          maxReviewRuns: 2,
          createdAt,
          updatedAt: createdAt,
          sessionId,
          promptHash,
          lastReviewedAt: null,
          lastReviewFingerprint: null,
          version: 1,
        };

        writeFileSync(runPath, createRunFile(template, initialState), "utf-8");

        let goals: ExtractedGoals;
        const extractionContext: SessionPromptContext = {
          agent: typeof input?.agent === "string" ? input.agent : undefined,
          model:
            input?.model && typeof input.model.providerID === "string" && typeof input.model.modelID === "string"
              ? input.model
              : undefined,
        };

        await log(client, "info", "workflow goal extraction routing", {
          runPath,
          sessionId,
          agent: extractionContext.agent ?? null,
          model: extractionContext.model
            ? `${extractionContext.model.providerID}/${extractionContext.model.modelID}`
            : null,
        });

        try {
          goals = await extractGoals(client, cleanedPrompt, extractionContext);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const details = getAssistantErrorDetails(error);
          await log(client, "error", "goal extraction failed", {
            error: message,
            details,
            runPath,
            sessionId,
          });
          throw error;
        }

        writeGoalsToRunFile(runPath, goals);

        await log(client, "info", "workflow activation succeeded", {
          runPath,
          sessionId,
          promptHash,
          reviewAgent: reviewAgent.name,
        });
        await showToast(client, "Workflow mode enabled", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await log(client, "error", "run blocked due to error", {
          phase: "activation",
          error: message,
          runPath: runPath ?? undefined,
        });

        if (runPath && existsSync(runPath)) {
          blockRun(runPath, `Workflow activation failed: ${message}`, { reviewed: false });
        }

        await showToast(client, formatErrorToast(message), "error");
      }
    },

    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") {
        return;
      }

      const sessionId = extractSessionId(event?.properties, event);
      if (!sessionId) {
        return;
      }

      const activeRun = findActiveRunForSession(sessionId);
      if (!activeRun) {
        return;
      }

      const gate = shouldRunReview(activeRun.state, new Date().toISOString());
      if (!gate.allowed) {
        await log(client, "info", "review skipped with reason", {
          reason: gate.reason,
          runPath: activeRun.runPath,
          sessionId,
        });
        return;
      }

      await log(client, "info", "review started", { runPath: activeRun.runPath, sessionId });
      await showToast(client, "Review started", "info");

      await withRunningLock(activeRun.runPath, async () => {
        try {
          const result = normalizeReviewResult(await runReview(client, sessionId, activeRun.runPath, readRunFile(activeRun.runPath)));
          const fingerprint = computeFingerprint(result);
          const finalized = finalizeReviewResult(activeRun.runPath, result, fingerprint);

          if (finalized.duplicate) {
            await log(client, "info", "review skipped with reason", {
              reason: "duplicate result fingerprint",
              runPath: activeRun.runPath,
              sessionId,
            });
            return;
          }

          await log(client, "info", "review completed with status", {
            status: result.status,
            runPath: activeRun.runPath,
            sessionId,
            reviewAgent: finalized.state.reviewAgent ?? undefined,
          });

          if (result.status === "pass") {
            await showToast(client, "Workflow completed", "success");
            return;
          }

          if (result.status === "blocked") {
            await showToast(client, "Workflow blocked", "error");
            return;
          }

          await showToast(client, `Gaps found: ${result.gaps.length}`, "warning");

          if (finalized.state.reviewCount >= finalized.state.maxReviewRuns) {
            await showToast(client, "Review limit reached", "warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          blockRun(activeRun.runPath, `Review execution failed: ${message}`);
          await log(client, "error", "run blocked due to error", {
            phase: "review",
            error: message,
            runPath: activeRun.runPath,
            sessionId,
          });
          await showToast(client, formatErrorToast(message), "error");
        }
      });
    },
  };
};

export default EasyWorkflowPlugin;
