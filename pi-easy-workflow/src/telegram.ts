export interface TelegramConfig {
  botToken: string
  chatId: string
}

export interface TelegramSendResult {
  success: boolean
  messageId?: number
  error?: string
}

const STATUS_EMOJI: Record<string, string> = {
  template: "📄",
  backlog: "📌",
  executing: "▶️",
  review: "🧩",
  done: "✅",
  failed: "❌",
  stuck: "🚫",
}

function buildMessage(taskName: string, oldStatus: string, newStatus: string): string {
  const emoji = STATUS_EMOJI[newStatus] ?? "💬"
  const time = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"
  return [
    `${emoji} *Task State Update*`,
    ``,
    `*Task:* ${taskName}`,
    `*From:* \`${oldStatus}\` → *To:* \`${newStatus}\``,
    ``,
    `_${time}_`,
  ].join("\n")
}

export async function sendTelegramNotification(
  config: TelegramConfig,
  taskName: string,
  oldStatus: string,
  newStatus: string,
  logger: (msg: string) => void = console.log
): Promise<TelegramSendResult> {
  if (!config.botToken || !config.chatId) {
    return { success: false, error: "not configured" }
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
    }

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
