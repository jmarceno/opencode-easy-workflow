# Telegram Reply-Driven Session Routing Plan

## Context

The Easy Workflow plugin sends outbound Telegram notifications when tasks change state. This plan adds **inbound reply handling**: when a user replies to a Telegram notification from the Easy Workflow bot, that reply is routed to a brand new OpenCode session, enabling multi-turn conversations via Telegram.

## Requirements Summary

1. **Reply-only filtering**: Only Telegram messages that are replies to the bot's messages are handled. Loose messages (not replies) are ignored.
2. **New session creation**: A valid reply starts a brand new OpenCode session.
3. **Skill instruction prefix**: The forwarded prompt begins with an instruction pointing to the Easy Workflow plugin skill.
4. **Port embedding**: Outbound bot messages include the current server port in a machine-readable way.
5. **Structured context**: Port and reply metadata are included as structured context in the forwarded prompt.
6. **Safe polling**: Plugin-owned Telegram polling listener with explicit timeouts, strict reply filtering, strict port parsing, and safe ignore behavior for invalid/unrelated messages.

## Implementation

### 1. Outbound Message Format (telegram.ts)

Update `buildMessage()` to embed port metadata in a parseable way:

```
<!-- EWF_PORT:{port}:EWF_PORT -->
<!-- EWF_CHAT_ID:{chatId}:EWF_CHAT_ID -->
<!-- EWF_MSG_ID:{messageId}:EWF_MSG_ID -->
```

These markers are placed at the end of the message (after a blank line) so they don't interfere with the human-readable notification but can be parsed by the polling listener.

### 2. Telegram Polling Listener (easy-workflow.ts plugin)

Add a polling loop that:
- Runs every 5 seconds (with abort signal support)
- Uses `getUpdates` Telegram API with offset to avoid re-processing messages
- Explicit timeout of 30 seconds per poll request
- Strictly validates:
  - Message is a reply (`reply_to_message` field present)
  - Reply targets the bot's message (via `reply_to_message.from.is_bot` and `reply_to_message.from.username` matching the configured bot)
  - Port marker is present and valid
  - Chat ID matches configured chat
- Ignores (safely skips):
  - Non-reply messages
  - Replies from other bots
  - Messages without valid port markers
  - Messages from other chats

### 3. Session Forwarding

When a valid reply is detected:
1. Parse the port from the markers to verify it matches local server port (routing decision)
2. Extract user text from the reply
3. Create a new OpenCode session via `client.session.create()`
4. Build a prompt that:
   - Begins with: `Use the Easy Workflow plugin skill to handle this request.`
   - Includes structured context: `EWF_PORT:{port} EWF_CHAT_ID:{chatId} EWF_REPLY_MSG_ID:{messageId}`
   - Contains the user's reply text
5. Send the prompt to the new session

### 4. Database Schema (db.ts)

Add to `KanbanOptions`:
- `telegramBotToken: string`
- `telegramChatId: string`

These enable the polling listener to verify incoming messages are from the correct chat.

### 5. File Changes

| File | Change |
|------|--------|
| `.opencode/easy-workflow/telegram.ts` | Add `buildMessageWithMetadata()` with port/chat/msg markers; keep `buildMessage()` for backward compat |
| `.opencode/easy-workflow/db.ts` | Add `telegramBotToken` and `telegramChatId` to options |
| `.opencode/plugins/easy-workflow.ts` | Add `startTelegramPolling()` and `stopTelegramPolling()` functions; call `startTelegramPolling()` in plugin init |
| `tests/test-kanban-telegram.ts` | Add tests for outbound metadata formatting, reply filtering, port parsing, and routing |

## Outbound Message Structure

```
📋 *Task State Update*

*Task:* {taskName}
*From:* `{oldStatus}` → *To:* `{newStatus}`

_{timestamp}_

<!-- EWF_PORT:{port}:EWF_PORT -->
<!-- EWF_CHAT_ID:{chatId}:EWF_CHAT_ID -->
<!-- EWF_MSG_ID:{messageId}:EWF_MSG_ID -->
```

## Polling Loop Pseudocode

```
async function pollTelegramUpdates(config, client, logger) {
  let offset = 0
  while (!abortSignal.aborted) {
    try {
      const updates = await fetchWithTimeout(
        `https://api.telegram.org/bot${config.botToken}/getUpdates?offset=${offset}&timeout=30`,
        { timeout: 35000 }
      )
      
      for (const update of updates) {
        if (!isValidEwReply(update, config)) continue
        
        const port = parsePort(update)
        if (port !== localPort) continue  // Not for this server
        
        await handleEwReply(update, client)
        offset = update.update_id + 1
      }
    } catch (err) {
      logger.error("Telegram poll error:", err)
      await sleep(5000)  // Back off on error
    }
    
    await sleep(1000)  // Small delay between successful polls
  }
}
```

## Validation Rules

1. `reply_to_message` must exist
2. `reply_to_message.from.is_bot === true`
3. `reply_to_message.from.username` must match the bot username derived from the bot token
4. `chat.id` must match configured `telegramChatId`
5. Port marker must be present and parseable
6. Parsed port must equal the local Kanban server port

## Test Coverage

1. **Outbound formatting**: Verify port/chat/msg markers are present in message
2. **Reply filtering**: Verify non-reply messages are ignored
3. **Port parsing**: Verify valid port extraction and invalid marker rejection
4. **Routing**: Verify messages with wrong port are ignored
5. **Session forwarding**: Verify new session is created with correct prompt structure

## Error Handling

- Polling errors are logged but do not crash the plugin
- Invalid messages are silently ignored (safe ignore behavior)
- Network timeouts use explicit timeouts and retry with backoff
- Abort signal allows clean shutdown when plugin unloads