/**
 * Telegram notification service for workflow task state changes.
 * Sends a message to a configured Telegram chat when a task transitions between states.
 * Also supports embedding machine-readable metadata (port, chat_id, message_id) for reply routing.
 */

export interface TelegramConfig {
  botToken: string
  chatId: string
}

// Metadata markers for reply-driven session routing
export const PORT_MARKER_START = "<!-- EWF_PORT:"
export const PORT_MARKER_END = ":EWF_PORT -->"
export const CHAT_ID_MARKER_START = "<!-- EWF_CHAT_ID:"
export const CHAT_ID_MARKER_END = ":EWF_CHAT_ID -->"
export const MSG_ID_MARKER_START = "<!-- EWF_MSG_ID:"
export const MSG_ID_MARKER_END = ":EWF_MSG_ID -->"

const STATUS_EMOJI: Record<string, string> = {
  template: "\u{1F4C4}",   // page facing up
  backlog: "\u{1F4CC}",    // pushpin
  executing: "\u{25B6}",   // play button
  review: "\u{1F9E9}",     // superhero emoji
  done: "\u{2705}",        // check mark
  failed: "\u274C",      // cross mark
  stuck: "\u{1F6AB}",      // no entry
}

function buildMessage(taskName: string, oldStatus: string, newStatus: string): string {
  const emoji = STATUS_EMOJI[newStatus] ?? "\u{1F4AC}"  // speech bubble default
  const time = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const lines = [
    `${emoji} *Task State Update*`,
    ``,
    `*Task:* ${taskName}`,
    `*From:* \`${oldStatus}\` \u2192 *To:* \`${newStatus}\``,
    ``,
    `_${time}_`,
  ]
  return lines.join("\n")
}

/**
 * Build a Telegram message with embedded metadata for reply-driven session routing.
 * The metadata markers are placed at the end of the message in HTML comments so they
 * don't interfere with the human-readable notification but can be parsed by the polling listener.
 * Note: messageId is optional since we may not have it at build time.
 */
export function buildMessageWithMetadata(
  taskName: string,
  oldStatus: string,
  newStatus: string,
  port: number,
  chatId: string,
  messageId?: number
): string {
  const baseMessage = buildMessage(taskName, oldStatus, newStatus)
  const lines = [
    baseMessage,
    "",
    `${PORT_MARKER_START}${port}${PORT_MARKER_END}`,
    `${CHAT_ID_MARKER_START}${chatId}${CHAT_ID_MARKER_END}`,
  ]
  if (messageId !== undefined) {
    lines.push(`${MSG_ID_MARKER_START}${messageId}${MSG_ID_MARKER_END}`)
  }
  return lines.join("\n")
}

/**
 * Build a workflow completion notification message.
 */
function buildWorkflowCompletionMessage(completedTaskCount: number): string {
  const emoji = "\u{1F389}"  // party popper
  const time = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const lines = [
    `${emoji} *Workflow Completed*`,
    ``,
    `*Tasks completed:* ${completedTaskCount}`,
    ``,
    `_${time}_`,
  ]
  return lines.join("\n")
}

/**
 * Build a workflow completion message with embedded metadata for reply-driven session routing.
 */
export function buildWorkflowCompletionMessageWithMetadata(
  completedTaskCount: number,
  port: number,
  chatId: string
): string {
  const baseMessage = buildWorkflowCompletionMessage(completedTaskCount)
  const lines = [
    baseMessage,
    "",
    `${PORT_MARKER_START}${port}${PORT_MARKER_END}`,
    `${CHAT_ID_MARKER_START}${chatId}${CHAT_ID_MARKER_END}`,
  ]
  return lines.join("\n")
}

/**
 * Parse port from a Telegram message text that may contain EWF metadata markers.
 * Returns null if no valid port marker is found.
 */
export function parsePortFromMessage(text: string): number | null {
  const match = text.match(new RegExp(`${PORT_MARKER_START}(\\d+)${PORT_MARKER_END}`))
  if (!match) return null
  const port = parseInt(match[1], 10)
  return isNaN(port) ? null : port
}

/**
 * Parse chat_id from a Telegram message text that may contain EWF metadata markers.
 * Returns null if no valid chat_id marker is found.
 */
export function parseChatIdFromMessage(text: string): string | null {
  const match = text.match(new RegExp(`${CHAT_ID_MARKER_START}(.+?)${CHAT_ID_MARKER_END}`))
  return match ? match[1] : null
}

/**
 * Parse message_id from a Telegram message text that may contain EWF metadata markers.
 * Returns null if no valid message_id marker is found.
 */
export function parseMessageIdFromMessage(text: string): number | null {
  // Use a non-anchored regex to find the marker anywhere in the text
  const pattern = `${MSG_ID_MARKER_START}\\d+${MSG_ID_MARKER_END}`
  const match = text.match(new RegExp(pattern))
  if (!match) return null
  // Extract the number from the matched marker
  const numMatch = match[0].match(/\d+/)
  if (!numMatch) return null
  const msgId = parseInt(numMatch[0], 10)
  return isNaN(msgId) ? null : msgId
}

export interface TelegramSendResult {
  success: boolean
  messageId?: number
  error?: string
}

/**
 * Send a Telegram notification with embedded metadata for reply-driven session routing.
 * This version includes port and chat_id in machine-readable markers directly in the message.
 */
export async function sendTelegramNotificationWithMetadata(
  config: TelegramConfig,
  taskName: string,
  oldStatus: string,
  newStatus: string,
  port: number,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }
  }

  const message = buildMessageWithMetadata(taskName, oldStatus, newStatus, port, config.chatId)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger(`[telegram] send failed: ${response.status} ${body}`)
      return { success: false, error: `HTTP ${response.status}: ${body}` }
    }

    // Extract message_id from response
    let messageId: number | undefined
    try {
      const data = await response.json() as any
      messageId = data?.result?.message_id
    } catch {
      // Ignore JSON parse errors
    }

    logger(`[telegram] notification sent for "${taskName}" (${oldStatus} → ${newStatus})`)
    return { success: true, messageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] send error: ${msg}`)
    return { success: false, error: msg }
  }
}

export async function sendTelegramNotification(
  config: TelegramConfig,
  taskName: string,
  oldStatus: string,
  newStatus: string,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }  // silently skip when not configured
  }

  const message = buildMessage(taskName, oldStatus, newStatus)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger(`[telegram] send failed: ${response.status} ${body}`)
      return { success: false, error: `HTTP ${response.status}: ${body}` }
    } else {
      logger(`[telegram] notification sent for "${taskName}" (${oldStatus} → ${newStatus})`)
      // Try to extract message_id from response for metadata tracking
      try {
        const data = await response.json() as any
        if (data?.result?.message_id) {
          return { success: true, messageId: data.result.message_id }
        }
      } catch {
        // Ignore JSON parse errors for message_id extraction
      }
      return { success: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] send error: ${msg}`)
    return { success: false, error: msg }
  }
}

/**
 * Send a workflow completion notification via Telegram.
 */
export async function sendWorkflowCompletionNotification(
  config: TelegramConfig,
  completedTaskCount: number,
  port: number,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }
  }

  const message = buildWorkflowCompletionMessageWithMetadata(completedTaskCount, port, config.chatId)
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger(`[telegram] workflow completion send failed: ${response.status} ${body}`)
      return { success: false, error: `HTTP ${response.status}: ${body}` }
    }

    logger(`[telegram] workflow completion notification sent (${completedTaskCount} tasks completed)`)
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] workflow completion send error: ${msg}`)
    return { success: false, error: msg }
  }
}
