# OpenCode to Pi API Mapping Reference

## SDK Client Methods

### Session Management

| OpenCode | Pi Extension | Notes |
|----------|-------------|-------|
| `client.session.create({ title })` | `pi.createSession(options)` | Create new session |
| `client.session.prompt({ sessionID, agent, parts })` | Use prompt injection or tools | Send prompts |
| `client.session.delete({ sessionID })` | `pi.deleteSession(id)` | Delete session |
| `client.session.list()` | `pi.listSessions()` | List sessions |
| `client.session.get({ path: { id } })` | `pi.getSession(id)` | Get session info |

### App & Logging

| OpenCode | Pi Extension | Notes |
|----------|-------------|-------|
| `client.app.log({ body: { level, message } })` | `pi.logger.info/debug/warn/error()` | Logging |
| `client.app.agents()` | `pi.listAgents()` | List available agents |

### TUI & UI

| OpenCode | Pi Extension | Notes |
|----------|-------------|-------|
| `client.tui.showToast({ body: { message, variant } })` | `ctx.ui.notify(message, variant)` | Toast notification |
| `client.tui.appendPrompt({ body: { text } })` | `ctx.ui.appendPrompt(text)` | Append to prompt |
| `client.tui.executeCommand({ body: { command } })` | `pi.executeCommand(command)` | Execute command |

### Permissions

| OpenCode | Pi Extension | Notes |
|----------|-------------|-------|
| `client.permission.reply({ requestID, reply })` | `tool_call` hook blocking | Permission handling |
| `client.permission.respond({ sessionID, permissionID, response })` | `ctx.ui.confirm()` | Confirmation dialog |

---

## Event Mappings

### Message Events

| OpenCode Event | Pi Event | Trigger |
|----------------|----------|---------|
| `chat.message` | `input` | User submits message |

**OpenCode:**
```typescript
"chat.message": async (input, output) => {
  const textPart = getUserTextPart(output);
  // Modify textPart.text
}
```

**Pi:**
```typescript
pi.on("input", async (event, ctx) => {
  // event.text contains the input
  // Return modified text or undefined
  return modifiedText;
});
```

### Session Events

| OpenCode Event | Pi Event | Trigger |
|----------------|----------|---------|
| `session.idle` | `before_agent_start` | Session becomes idle |
| `session.created` | `session_start` | New session created |
| - | `session_switch` | Session switched |
| - | `session_shutdown` | Pi shutting down |

**OpenCode:**
```typescript
event: async ({ event }) => {
  if (event?.type === "session.idle") {
    // Review logic
  }
}
```

**Pi:**
```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // Review or context injection
});

pi.on("session_start", async (_event, ctx) => {
  // Session initialization
});
```

### Permission Events

| OpenCode Event | Pi Event | Trigger |
|----------------|----------|---------|
| `permission.asked` | `tool_call` | Tool about to execute |

**OpenCode:**
```typescript
if (event?.type === "permission.asked") {
  await handlePermissionAutoReply(event, client, rootDb);
}
```

**Pi:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  // Check if this tool should be auto-approved
  if (shouldAutoApprove(event, ctx)) {
    return undefined; // Allow
  }
  if (isBlocked(event, ctx)) {
    return { block: true, reason: "Blocked" };
  }
  return undefined;
});
```

---

## Data Extraction

### Session ID Extraction

**OpenCode:**
```typescript
function extractSessionId(...sources: any[]): string | null {
  for (const source of sources) {
    const candidates = [
      source?.sessionId,
      source?.sessionID,
      source?.session?.id,
      // ...
    ];
    // ...
  }
}
```

**Pi:**
```typescript
// In hooks, session ID is typically available via ctx
const sessionId = ctx.sessionId;

// Or from event properties
const sessionId = event.properties?.sessionId;
```

### User Text Extraction

**OpenCode:**
```typescript
function getUserTextPart(output: any): any | null {
  if (!Array.isArray(output?.parts)) return null;
  return output.parts.find((part) => part?.type === "text");
}
```

**Pi:**
```typescript
// In input hook, event.text is the raw string
pi.on("input", async (event, ctx) => {
  const text = event.text; // Already a string
});
```

---

## Prompt Manipulation

### Modify Prompt Text

**OpenCode:**
```typescript
textPart.text = cleanedPrompt; // Direct mutation
```

**Pi:**
```typescript
// Return modified text to transform, or undefined to pass through
return cleanedPrompt;
```

### Append Context

**OpenCode:**
```typescript
await client.session.prompt({
  sessionID: scratchSessionId,
  parts: [{ type: "text", text: promptText }],
});
```

**Pi:**
```typescript
// Option 1: Return modified system prompt in before_agent_start
pi.on("before_agent_start", async (event, ctx) => {
  return {
    systemPrompt: event.systemPrompt + "\n\nExtra context",
  };
});

// Option 2: Use tool to append context
pi.on("input", async (event, ctx) => {
  ctx.ui.appendPrompt("\n\nContext to append");
});
```

---

## Tool Definition Comparison

### OpenCode (in Plugin)

```typescript
// OpenCode plugins don't define custom tools directly
// Tools are built-in and called via client.session.prompt()
```

### Pi

```typescript
import { Type } from "@mariozechner/pi-coding-agent";

const myTool: ToolDefinition = {
  name: "my_tool",
  description: "What this tool does",
  parameters: Type.Object({
    arg1: Type.String({ description: "First argument" }),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // Implementation
    return {
      content: [{ type: "text", text: "result" }],
      details: { /* extra data */ },
    };
  },
  renderCall: (params, theme) => "My Tool: action arg1",
  renderResult: (result, options, theme) => "Result: ...",
};

pi.registerTool(myTool);
```

---

## Configuration Patterns

### OpenCode Config

```json
{
  "plugin": ["my-plugin"]
}
```

### Pi Extension Config

```typescript
// src/config.ts
import { ConfigLoader } from "@aliou/pi-utils-settings";

interface Config {
  enabled?: boolean;
  option1?: string;
}

const DEFAULTS = {
  enabled: true,
  option1: "default",
};

export const configLoader = new ConfigLoader<Config, Config>(
  "my-extension",
  DEFAULTS
);

// In index.ts
await configLoader.load();
const config = configLoader.getConfig();
```

```json
// package.json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

---

## Key Differences Summary

1. **Event-driven → Hook-based**: OpenCode uses a single export with event routing; pi uses `pi.on(event, handler)` for each event
2. **SDK client → ExtensionAPI**: Different API surfaces with different method names
3. **Session-centric → Tool-centric**: OpenCode creates sessions; pi registers tools
4. **No config → ConfigLoader**: pi extensions have structured config
5. **Limited tools → Tool registry**: pi has a proper tool registration system
6. **Commands → Commands**: pi has built-in command registration with `/command` syntax
