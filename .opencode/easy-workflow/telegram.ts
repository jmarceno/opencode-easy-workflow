/**
 * Telegram notification service for workflow task state changes.
 * Sends a message to a configured Telegram chat when a task transitions between states.
 */

export interface TelegramConfig {
  botToken: string
  chatId: string
}

const STATUS_EMOJI: Record<string, string> = {
  template: "\u{1F4C4}",   // page facing up
  backlog: "\u{1F4CC}",    // pushpin
  executing: "\u{25B6}",   // play button
  review: "\u{1F9E9}",     // superhero emoji
  done: "\u{2705}",        // check mark
  failed: "\u{274C}",      // cross mark
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

export async function sendTelegramNotification(
  config: TelegramConfig,
  taskName: string,
  oldStatus: string,
  newStatus: string,
  logger: (msg: string) => void = console.log
): Promise<void> {
  if (!config.botToken || !config.chatId) {
    return  // silently skip when not configured
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
    } else {
      logger(`[telegram] notification sent for "${taskName}" (${oldStatus} → ${newStatus})`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger(`[telegram] send error: ${msg}`)
  }
}
