/**
 * Easy Workflow Bridge Plugin
 * 
 * This is a minimal bridge plugin that forwards events from OpenCode
 * to the standalone Easy Workflow server.
 * 
 * The standalone server must be running separately. This plugin does NOT
 * start the server - it only forwards events.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { join, resolve } from "path"
import { createHash } from "crypto"
import { spawn } from "child_process"

// ---- Constants ----

const WORKFLOW_MARKER = "#workflow"
const GOALS_PLACEHOLDER = "[REPLACE THIS WITH THE TASK GOALS]"
const REVIEW_SECTION_MARKER = "## Persisted Review Result"
const REVIEW_COOLDOWN_MS = 30_000

// ---- Types ----

type WorkflowStatus = "pending" | "running" | "completed" | "blocked"
type ReviewStatus = "pass" | "gaps_found" | "blocked"

interface WorkflowRunState {
  reviewAgent?: string | null
  runreview: boolean
  running: boolean
  status: WorkflowStatus
  reviewCount: number
  maxReviewRuns: number
  createdAt: string | null
  updatedAt: string | null
  sessionId: string | null
  promptHash: string | null
  lastReviewedAt: string | null
  lastReviewFingerprint: string | null
  lastReviewStatus?: ReviewStatus
  lastRecommendedPrompt?: string
  lastGapCount?: number
  version: number
}

interface ExtractedGoals {
  summary: string
  goals: string[]
}

interface ReviewResult {
  status: ReviewStatus
  summary: string
  gaps: string[]
  recommendedPrompt: string
}

interface PromptParseResult {
  valid: boolean
  cleanedPrompt: string
  normalizedPrompt: string
}

interface RunFile {
  state: WorkflowRunState
  body: string
}

interface TemplateConfig {
  reviewAgent: string | null
}

interface AgentConfig {
  name: string
  path: string
  mode: string | null
  model: string | null
}

interface SessionPromptContext {
  agent?: string
  model?: { providerID: string; modelID: string }
}

interface WorkflowSessionOwner {
  taskId: string
  sessionKind: string
  skipPermissionAsking: boolean
}

// ---- Config loading ----

interface BridgeConfig {
  standaloneServerUrl: string
  projectDirectory: string
}

function findProjectRoot(startDir: string): string {
  let current = resolve(startDir)
  while (current !== "/") {
    if (existsSync(join(current, ".opencode", "easy-workflow"))) {
      return current
    }
    const parent = resolve(current, "..")
    if (parent === current) break
    current = parent
  }
  return resolve(startDir)
}

function loadBridgeConfig(directory: string): BridgeConfig | null {
  const projectRoot = findProjectRoot(directory)
  const configPath = join(projectRoot, ".opencode", "easy-workflow", "config.json")
  
  if (!existsSync(configPath)) {
    return null
  }

  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw)
    
    // The standalone server reads config.json, the bridge uses localhost + kanban port
    // We need to read the port from the database or use default
    const kanbanPort = parsed.kanbanPort || 3789
    
    return {
      standaloneServerUrl: `http://localhost:${kanbanPort}`,
      projectDirectory: projectRoot,
    }
  } catch (err) {
    console.error("[bridge] Failed to load config:", err instanceof Error ? err.message : String(err))
    return null
  }
}

// ---- Utility functions ----

function unwrapResponseData<T>(response: any): T {
  if (response && typeof response === "object" && "data" in response) {
    return response.data as T
  }
  return response as T
}

function extractPermissionId(event: any): string | null {
  const direct =
    event?.properties?.permissionID ??
    event?.properties?.id ??
    event?.properties?.requestID ??
    event?.permissionID ??
    event?.id ??
    event?.requestID

  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim()
  }
  return null
}

function extractPermissionSessionId(event: any): string | null {
  const raw =
    event?.properties?.sessionID ??
    event?.properties?.sessionId ??
    event?.sessionID ??
    event?.sessionId

  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim()
  }
  return null
}

function extractRequestId(event: any): string | null {
  const direct =
    event?.properties?.requestID ??
    event?.properties?.id ??
    event?.requestID ??
    event?.id

  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim()
  }
  return null
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
    ]

    const sessionId = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0)
    if (typeof sessionId === "string") {
      return sessionId
    }
  }
  return null
}

function getUserTextPart(output: any): any | null {
  if (!Array.isArray(output?.parts)) {
    return null
  }
  return output.parts.find((part: any) => part?.type === "text" && typeof part.text === "string") ?? null
}

function parseWorkflowPrompt(input: string): PromptParseResult {
  const trimmed = input.trim()

  if (!trimmed) {
    return { valid: false, cleanedPrompt: "", normalizedPrompt: "" }
  }

  const tokens = trimmed.split(/\s+/)
  const firstToken = tokens[0]
  const lastToken = tokens[tokens.length - 1]

  if (firstToken === WORKFLOW_MARKER) {
    const cleanedPrompt = trimmed.replace(/^#workflow(?=\s|$)\s*/, "")
    return {
      valid: true,
      cleanedPrompt,
      normalizedPrompt: cleanedPrompt.trim(),
    }
  }

  if (lastToken === WORKFLOW_MARKER) {
    const cleanedPrompt = trimmed.replace(/\s*#workflow$/, "")
    return {
      valid: true,
      cleanedPrompt,
      normalizedPrompt: cleanedPrompt.trim(),
    }
  }

  return {
    valid: false,
    cleanedPrompt: trimmed,
    normalizedPrompt: trimmed,
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)

  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const [, frontmatterText, body] = match
  const frontmatter: Record<string, unknown> = {}

  for (const line of frontmatterText.split("\n")) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex === -1) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    
    // Parse scalar values
    if (rawValue === "null") {
      frontmatter[key] = null
    } else if (rawValue === "true") {
      frontmatter[key] = true
    } else if (rawValue === "false") {
      frontmatter[key] = false
    } else if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
      frontmatter[key] = Number(rawValue)
    } else if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("[") && rawValue.endsWith("]"))) {
      try {
        frontmatter[key] = JSON.parse(rawValue)
      } catch {
        frontmatter[key] = rawValue
      }
    } else {
      frontmatter[key] = rawValue
    }
  }

  return { frontmatter, body }
}

function normalizeAgentName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseScalar(rawValue: string): unknown {
  if (rawValue === "null") return null
  if (rawValue === "true") return true
  if (rawValue === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) return Number(rawValue)
  return rawValue
}

function parseModelSelection(value: string): { providerID: string; modelID: string } | null {
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf("/")

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null
  }

  const providerID = trimmed.slice(0, separatorIndex).trim()
  const modelID = trimmed.slice(separatorIndex + 1).trim()
  return providerID && modelID ? { providerID, modelID } : null
}

function inspectTemplateConfig(template: string): TemplateConfig {
  const { frontmatter } = parseFrontmatter(template)
  return {
    reviewAgent: normalizeAgentName(frontmatter.reviewAgent),
  }
}

function loadReviewAgentConfig(agentName: string, agentsDir: string): AgentConfig {
  const path = join(agentsDir, `${agentName}.md`)

  if (!existsSync(path)) {
    throw new Error(`Workflow review agent file is missing: ${path}`)
  }

  const content = readFileSync(path, "utf-8")
  const { frontmatter } = parseFrontmatter(content)
  const mode = typeof frontmatter.mode === "string" ? frontmatter.mode.trim() : null
  const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : null

  if (mode !== "subagent") {
    throw new Error(`Workflow review agent must declare mode: subagent in ${path}`)
  }

  if (!model) {
    throw new Error(`Workflow review agent must declare a model in ${path}`)
  }

  if (!parseModelSelection(model)) {
    throw new Error(`Workflow review agent model is invalid in ${path}: ${model}`)
  }

  return { name: agentName, path, mode, model }
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
  }
}

// ---- Server Auto-Start Management ----

const PID_FILE_NAME = ".server.pid"

function getPidFilePath(projectRoot: string): string {
  return join(projectRoot, ".opencode", "easy-workflow", PID_FILE_NAME)
}

function isServerRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readServerPid(projectRoot: string): number | null {
  const pidFile = getPidFilePath(projectRoot)
  if (!existsSync(pidFile)) return null
  
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8"), 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function writeServerPid(projectRoot: string, pid: number): void {
  const pidFile = getPidFilePath(projectRoot)
  writeFileSync(pidFile, String(pid), "utf-8")
}

function clearServerPid(projectRoot: string): void {
  const pidFile = getPidFilePath(projectRoot)
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile)
    } catch {
      // Ignore errors
    }
  }
}

async function startStandaloneServer(projectRoot: string): Promise<number | null> {
  const workflowDir = join(projectRoot, ".opencode", "easy-workflow")
  const configPath = join(workflowDir, "config.json")
  const standalonePath = join(workflowDir, "standalone.ts")
  
  if (!existsSync(standalonePath)) {
    console.log("[easy-workflow-bridge] Standalone server not found:", standalonePath)
    return null
  }
  
  if (!existsSync(configPath)) {
    console.log("[easy-workflow-bridge] Config not found. Please run the standalone server manually first:")
    console.log("[easy-workflow-bridge]   bun run .opencode/easy-workflow/standalone.ts")
    console.log("[easy-workflow-bridge] This will create the initial configuration.")
    return null
  }
  
  console.log("[easy-workflow-bridge] Starting standalone server...")
  
  const child = spawn("bun", ["run", standalonePath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: projectRoot,
  })
  
  child.unref()
  
  writeServerPid(projectRoot, child.pid!)
  
  console.log(`[easy-workflow-bridge] Server started (PID: ${child.pid})`)
  
  child.stdout?.on("data", (data) => {
    console.log(`[easy-workflow-server] ${data.toString().trim()}`)
  })
  
  child.stderr?.on("data", (data) => {
    console.error(`[easy-workflow-server] ${data.toString().trim()}`)
  })
  
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  if (!isServerRunning(child.pid!)) {
    console.error("[easy-workflow-bridge] Server failed to start (process exited)")
    clearServerPid(projectRoot)
    return null
  }
  
  console.log("[easy-workflow-bridge] Server is running")
  return child.pid
}

function killStandaloneServer(projectRoot: string): void {
  const pid = readServerPid(projectRoot)
  if (!pid) return
     
  process.kill(pid, "SIGKILL")
  console.log(`[easy-workflow-bridge] Sent SIGKILL to server (PID: ${pid})`)
    
  clearServerPid(projectRoot)
}

// ---- Telegram Reply Polling ----

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number; type: string }
    from?: { id: number; is_bot: boolean; username?: string }
    reply_to_message?: {
      message_id: number
      from?: { id: number; is_bot: boolean; username?: string }
      text?: string
    }
    text?: string
  }
}

interface TelegramPollingConfig {
  botToken: string
  chatId: string
  localPort: number
  standaloneServerUrl: string
  projectDirectory: string
}

/**
 * Extract bot username from bot token by calling getMe API.
 * The token format is typically: botId:botSecret, so we derive the username from API response.
 */
async function getBotUsername(botToken: string): Promise<string | null> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null
    const data = await response.json() as any
    return data?.result?.username ?? null
  } catch {
    return null
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Parse port from a message text that contains EWF metadata markers.
 */
function parseEwPort(text: string): number | null {
  const match = text.match(/<!-- EWF_PORT:(\d+):EWF_PORT -->/)
  if (!match) return null
  const port = parseInt(match[1], 10)
  return isNaN(port) ? null : port
}

/**
 * Validate that a Telegram update is a valid Easy Workflow reply.
 * Rules:
 * 1. Message must be a reply (reply_to_message exists)
 * 2. The replied message must be from a bot
 * 3. The bot must be our bot (username matches)
 * 4. Chat ID must match configured chat ID
 * 5. The replied message text must contain a valid EWF port marker
 * 6. The port must match our local port
 */
async function validateEwReply(
  update: TelegramUpdate,
  config: TelegramPollingConfig,
  botUsername: string | null
): Promise<{ valid: boolean; userText: string | null; replyMsgId: number | null }> {
  const msg = update.message
  if (!msg) return { valid: false, userText: null, replyMsgId: null }

  // Must be a reply
  if (!msg.reply_to_message) return { valid: false, userText: null, replyMsgId: null }

  const reply = msg.reply_to_message

  // The replied message must be from a bot
  if (!reply.from?.is_bot) return { valid: false, userText: null, replyMsgId: null }

  // If we have a bot username, verify it matches
  if (botUsername && reply.from?.username !== botUsername) return { valid: false, userText: null, replyMsgId: null }

  // Chat ID must match
  const chatIdStr = String(msg.chat.id)
  const configChatIdStr = String(config.chatId)
  if (chatIdStr !== configChatIdStr) return { valid: false, userText: null, replyMsgId: null }

  // The replied message must contain EWF port marker
  if (!reply.text || !reply.text.includes("EWF_PORT:")) return { valid: false, userText: null, replyMsgId: null }

  // Parse and validate port
  const port = parseEwPort(reply.text)
  if (port === null || port !== config.localPort) return { valid: false, userText: null, replyMsgId: null }

  // Extract user text (the actual reply content)
  const userText = msg.text?.trim() ?? null
  if (!userText) return { valid: false, userText: null, replyMsgId: null }

  return { valid: true, userText, replyMsgId: reply.message_id }
}

/**
 * Build the prompt for a Telegram reply-driven session.
 * The prompt begins with an instruction pointing to the Easy Workflow plugin skill,
 * includes structured context with port and reply metadata.
 */
function buildTelegramReplyPrompt(
  userText: string,
  port: number,
  chatId: string,
  replyMsgId: number
): string {
  const contextLines = [
    "Use the Easy Workflow plugin skill to handle this request.",
    "",
    "<!-- EWF_CONTEXT",
    `EWF_PORT:${port}`,
    `EWF_CHAT_ID:${chatId}`,
    `EWF_REPLY_MSG_ID:${replyMsgId}`,
    "EWF_CONTEXT -->",
    "",
    userText,
  ]
  return contextLines.join("\n")
}

/**
 * Forward a valid Telegram reply to a new OpenCode session.
 */
async function forwardTelegramReplyToSession(
  client: any,
  userText: string,
  port: number,
  chatId: string,
  replyMsgId: number,
  projectDirectory: string,
  logger: (msg: string) => void
): Promise<void> {
  try {
    const prompt = buildTelegramReplyPrompt(userText, port, chatId, replyMsgId)

    // Create a new session
    const sessionResponse = await client.session.create({
      title: `Telegram reply (port ${port})`,
    })
    const session = sessionResponse?.data ?? sessionResponse
    const sessionId = session?.id

    if (!sessionId) {
      logger("[telegram-polling] Failed to create session: no session ID returned")
      return
    }

    // Send the prompt to the new session
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
      },
    })

    logger(`[telegram-polling] Forwarded Telegram reply to new session: ${sessionId}`)
  } catch (err) {
    logger(`[telegram-polling] Failed to forward reply to session: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Start the Telegram polling loop for reply-driven session routing.
 * Returns a function to stop the polling.
 */
function startTelegramPolling(
  client: any,
  config: TelegramPollingConfig,
  logger: (msg: string) => void
): () => void {
  const abortController = new AbortController()
  let lastUpdateId = 0
  let stopped = false

  const poll = async () => {
    const botUsername = await getBotUsername(config.botToken)
    if (botUsername) {
      logger(`[telegram-polling] Verified bot username: @${botUsername}`)
    } else {
      logger("[telegram-polling] Could not verify bot username, will accept any bot in reply")
    }

    while (!stopped && !abortController.signal.aborted) {
      try {
        // Use long polling with getUpdates
        // offset parameter ensures we only get new updates
        const url = `https://api.telegram.org/bot${config.botToken}/getUpdates?offset=${lastUpdateId}&timeout=30`
        const response = await fetch(url, {
          signal: AbortSignal.timeout(35000), // 35s timeout to ensure we catch abort
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown")
          logger(`[telegram-polling] getUpdates failed: ${response.status} ${errorText}`)
          await sleep(5000) // Back off on error
          continue
        }

        const updates = await response.json() as { ok: boolean; result?: TelegramUpdate[] }
        if (!updates.ok || !updates.result || updates.result.length === 0) {
          // No new updates, continue polling
          continue
        }

        for (const update of updates.result) {
          if (stopped || abortController.signal.aborted) break

          // Validate the update
          const validation = await validateEwReply(update, config, botUsername)
          if (!validation.valid) {
            // Not a valid EWF reply, skip but update offset
            if (update.update_id >= lastUpdateId) {
              lastUpdateId = update.update_id + 1
            }
            continue
          }

          // Valid reply! Forward to new session
          await forwardTelegramReplyToSession(
            client,
            validation.userText!,
            config.localPort,
            String(config.chatId),
            validation.replyMsgId!,
            config.projectDirectory,
            logger
          )

          // Update offset so we don't process this again
          if (update.update_id >= lastUpdateId) {
            lastUpdateId = update.update_id + 1
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Shutdown requested
          break
        }
        logger(`[telegram-polling] Polling error: ${err instanceof Error ? err.message : String(err)}`)
        await sleep(5000) // Back off on error
      }

      // Small delay between successful polls
      if (!stopped && !abortController.signal.aborted) {
        await sleep(1000)
      }
    }

    logger("[telegram-polling] Polling loop ended")
  }

  // Start polling in background
  poll().catch(err => {
    logger(`[telegram-polling] Fatal polling error: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Return stop function
  return () => {
    stopped = true
    abortController.abort()
    logger("[telegram-polling] Stopping...")
  }
}

// ---- Plugin export ----

export const EasyWorkflowBridgePlugin = async (input: any) => {
  const { client, directory } = input
  const projectRoot = findProjectRoot(directory)

  // Auto-start standalone server if not running
  let serverPid: number | null = null
  if (projectRoot) {
    const existingPid = readServerPid(projectRoot)

    if (existingPid && isServerRunning(existingPid)) {
      console.log(`[easy-workflow-bridge] Server already running (PID: ${existingPid})`)
      serverPid = existingPid
    } else {
      // Clear stale PID file
      if (existingPid) {
        clearServerPid(projectRoot)
      }

      // Try to start server
      serverPid = await startStandaloneServer(projectRoot)
    }

    // Register shutdown handlers - kill server immediately without waiting
    if (serverPid || telegramConfig) {
      const cleanup = () => {
        if (serverPid) killStandaloneServer(projectRoot!)
        if (stopTelegramPolling) stopTelegramPolling()
      }
      process.on("exit", cleanup)

      process.on("SIGINT", () => {
        if (serverPid) killStandaloneServer(projectRoot!)
        if (stopTelegramPolling) stopTelegramPolling()
        process.exit(0)
      })

      process.on("SIGTERM", () => {
        if (serverPid) killStandaloneServer(projectRoot!)
        if (stopTelegramPolling) stopTelegramPolling()
        process.exit(0)
      })
    }
  }

  // Load bridge configuration
  const config = loadBridgeConfig(directory)

  if (!config) {
    console.log("[easy-workflow-bridge] Standalone server config not found. Bridge will not forward events.")
    console.log("[easy-workflow-bridge] Please start the standalone server first:")
    console.log("[easy-workflow-bridge]   bun run .opencode/easy-workflow/standalone.ts")
    return {}
  }

  console.log("[easy-workflow-bridge] Bridge initialized")
  console.log("[easy-workflow-bridge] Forwarding events to:", config.standaloneServerUrl)

  // Fetch Telegram options from the standalone server
  let telegramConfig: TelegramPollingConfig | null = null
  try {
    const optionsResponse = await fetch(`${config.standaloneServerUrl}/api/options`)
    if (optionsResponse.ok) {
      const options = await optionsResponse.json() as any
      if (options.telegramBotToken && options.telegramChatId && options.port) {
        telegramConfig = {
          botToken: options.telegramBotToken,
          chatId: options.telegramChatId,
          localPort: options.port,
          standaloneServerUrl: config.standaloneServerUrl,
          projectDirectory: config.projectDirectory,
        }
        console.log("[easy-workflow-bridge] Telegram polling configured for port:", options.port)
      } else {
        console.log("[easy-workflow-bridge] Telegram not fully configured (botToken, chatId, or port missing)")
      }
    }
  } catch (err) {
    console.log("[easy-workflow-bridge] Could not fetch Telegram options:", err instanceof Error ? err.message : String(err))
  }

  // Start Telegram polling if configured
  let stopTelegramPolling: (() => void) | null = null
  if (telegramConfig) {
    stopTelegramPolling = startTelegramPolling(client, telegramConfig, (msg: string) => console.log(msg))
    console.log("[easy-workflow-bridge] Telegram reply polling started")
  }

  // Helper to forward events to standalone server
  async function forwardEvent(eventType: string, payload: any): Promise<void> {
    const url = `${config!.standaloneServerUrl}/api/events/bridge`
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: eventType,
          payload,
          projectDirectory: config!.projectDirectory,
        }),
      })
      
      if (!response.ok) {
        const error = await response.text()
        console.error(`[easy-workflow-bridge] Failed to forward ${eventType} to ${url}:`, error)
      }
    } catch (err) {
      console.error(`[easy-workflow-bridge] Error forwarding ${eventType} to ${url}:`, err instanceof Error ? err.message : String(err))
    }
  }

  return {
    "chat.message": async (input: any, output: any) => {
      const textPart = getUserTextPart(output)
      const promptText = textPart?.text ?? ""
      const { valid, cleanedPrompt, normalizedPrompt } = parseWorkflowPrompt(promptText)

      if (!valid || !normalizedPrompt) {
        return
      }

      // Strip the workflow marker from the output
      textPart.text = cleanedPrompt

      // Forward to standalone server
      await forwardEvent("chat.message", {
        input,
        output,
        cleanedPrompt,
        normalizedPrompt,
        directory: config!.projectDirectory,
        agent: typeof input?.agent === "string" ? input.agent : undefined,
        model: input?.model && typeof input.model.providerID === "string" && typeof input.model.modelID === "string"
          ? input.model
          : undefined,
      })
    },

    event: async ({ event }: any) => {
      // Forward all events to standalone server
      await forwardEvent("event", { event })

      // Handle permission auto-reply locally (we need the client for this)
      if (event?.type === "permission.asked") {
        const sessionId = extractPermissionSessionId(event)
        const permissionId = extractPermissionId(event)

        if (!permissionId) return

        let resolvedSessionId = sessionId

        // Try to recover sessionId from permission.list() if missing
        if (!resolvedSessionId) {
          try {
            const pendingList = unwrapResponseData<any>(await client.permission.list())
            const pending = Array.isArray(pendingList) ? pendingList : []
            const match = pending.find((p: any) => {
              const pid = p?.id ?? p?.permissionID ?? p?.requestID
              return typeof pid === "string" && pid.trim() === permissionId.trim()
            })
            if (match) {
              resolvedSessionId = match?.sessionID ?? match?.sessionId ?? null
            }
          } catch {
            // Ignore recovery errors
          }
        }

        if (!resolvedSessionId) return

        // Check if this is a workflow session by querying the standalone server
        try {
          const response = await fetch(`${config!.standaloneServerUrl}/api/workflow-session/${resolvedSessionId}`)
          if (!response.ok) return
          
          const sessionData = await response.json()
          if (!sessionData || !sessionData.skipPermissionAsking) return

          // Auto-reply to permission
          const requestID = extractRequestId(event)

          if (requestID) {
            try {
              await client.permission.reply(
                { requestID, reply: "always" },
                { throwOnError: false },
              )
              console.log("[easy-workflow-bridge] Auto-replied to permission for workflow session:", resolvedSessionId)
              return
            } catch {
              // Fall through to respond()
            }
          }

          try {
            await client.permission.respond(
              { sessionID: resolvedSessionId, permissionID: permissionId, response: "always" },
              { throwOnError: false },
            )
            console.log("[easy-workflow-bridge] Auto-replied to permission for workflow session:", resolvedSessionId)
          } catch {
            // Ignore errors
          }
        } catch {
          // Ignore errors - session might not exist
        }
      }
    },
  }
}

export default EasyWorkflowBridgePlugin
