This is an Opencode (https://opencode.ai/) plugin to support review-driven workflows.

Documentation about agents, plugins, and the SDK are in `ref-docs/opencode.ai-agents.md`, `ref-docs/opencode.ai-plugins.md`, and `ref-docs/opencode.ai-sdk.md` respectively.

If you need to access the Opencode source code, you can get it locally at `/home/jmarceno/Projects/cloned/opencode/`, I just pulled the most recent changes.


# OpenCode Agent & Plugin Development Guide

This document captures the key learnings from building the Easy Workflow plugin for OpenCode, including agent configuration, plugin architecture, and SDK usage patterns.

## Table of Contents

1. [Agent Configuration](#agent-configuration)
2. [Plugin Architecture](#plugin-architecture)
3. [SDK Integration Patterns](#sdk-integration-patterns)
4. [Model Compatibility](#model-compatibility)
5. [Testing Strategies](#testing-strategies)
6. [Common Pitfalls](#common-pitfalls)

---

## Agent Configuration

### Agent File Structure

Agents are defined in Markdown files with YAML frontmatter:

```markdown
---
description: Brief description of what this agent does
mode: subagent  # or "primary"
model: provider/model-id  # e.g., "opencode-go/kimi-k2.5"
permission:
  edit: deny
  webfetch: deny
  bash:
    "*": ask
    "git status*": allow
    "git diff*": allow
---

Agent instructions here...
```

### Key Frontmatter Fields

- **description**: Human-readable description shown in agent listings
- **mode**: 
  - `primary` - Can be used as the main agent for user interactions
  - `subagent` - Can only be invoked via `@agentname` or programmatically
- **model**: Full model identifier in `provider/model-id` format
  - Examples: `opencode-go/kimi-k2.5`, `openai/gpt-4`, `anthropic/claude-3`
- **permission**: Tool access control rules
  - Use `"*": ask` for most operations to require user confirmation
  - Use `"git status*": allow` for read-only git operations
  - Use `edit: deny` to prevent file modifications

### Agent Discovery

Agents are auto-loaded from `.opencode/agents/` directory. To verify an agent is loaded:

```typescript
const agents = unwrapResponseData<any[]>(await client.app.agents());
const isLoaded = agents.some(agent => 
  agent.name === "your-agent-name" || 
  agent.id === "your-agent-name" ||
  agent.slug === "your-agent-name"
);
```

---

## Plugin Architecture

### Plugin Registration

Plugins export a default async function that receives a client instance:

```typescript
export const MyPlugin = async ({ client }: { client: any }) => {
  // Plugin initialization
  return {
    // Hook handlers
  };
};

export default MyPlugin;
```

### Available Hooks

#### 1. chat.message

Intercept and modify user messages before processing:

```typescript
"chat.message": async (input: any, output: any) => {
  // input contains: sessionID, agent, model, messageID, variant
  // output contains: message (info), parts (array of parts)
  
  const textPart = output.parts.find(
    (part: any) => part?.type === "text" && typeof part.text === "string"
  );
  
  if (textPart) {
    // Modify the prompt text
    textPart.text = modifiedText;
  }
}
```

**Key Points:**
- Modify `output.parts` to change what the agent sees
- Use `input.agent` and `input.model` to get current context
- Return void or throw to halt processing

#### 2. event

Listen to system events (e.g., session idle):

```typescript
event: async ({ event }: { event: any }) => {
  if (event?.type === "session.idle") {
    const sessionId = extractSessionId(event);
    // Trigger review, cleanup, etc.
  }
}
```

**Event Types:**
- `session.idle` - Session is waiting for user input
- `worktree.ready` - Git worktree is ready
- `worktree.failed` - Git worktree creation failed

### Response Unwrapping

All SDK responses are wrapped with a `.data` property:

```typescript
function unwrapResponseData<T>(response: any): T {
  if (response && typeof response === "object" && "data" in response) {
    return response.data as T;
  }
  return response as T;
}

// Usage
const result = unwrapResponseData<any>(await client.session.create({
  body: { title: "Session Title" }
}));
```

---

## SDK Integration Patterns

### Creating Scratch Sessions

For operations that shouldn't affect the main session (e.g., goal extraction):

```typescript
const session = unwrapResponseData<any>(await client.session.create({
  body: { title: "Scratch Session Title" }
}));

const scratchSessionId = session?.id;

try {
  const result = unwrapResponseData<any>(await client.session.prompt({
    path: { id: scratchSessionId },
    body: {
      agent: context?.agent,
      model: context?.model,
      parts: [{ type: "text", text: promptText }],
    },
  }));
  
  // Process result
} finally {
  await client.session.delete({ path: { id: scratchSessionId } })
    .catch(() => undefined);
}
```

### Extracting Text from Responses

```typescript
const textPart = result?.parts?.find(
  (part: any) => part?.type === "text" && typeof part.text === "string"
);
const responseText = textPart?.text ?? "";
```

### Structured Output (When Supported)

For models that support structured output:

```typescript
const schema = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pass", "fail"] },
      summary: { type: "string" },
    },
    required: ["status", "summary"],
  },
};

const result = unwrapResponseData<any>(await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: prompt }],
    format: schema,
  },
}));

const structuredOutput = result?.info?.structured;
```

**Important:** Check `result?.info?.structured` for the parsed output, not `result?.info?.structured_output`.

---

## Model Compatibility

### opencode-go Provider

The `opencode-go` provider hosts models like `kimi-k2.5`, `kimi-k2-thinking`, etc.

**Limitations:**
- Does NOT support structured output via `json_schema` format
- Must use text-based parsing with clear formatting instructions
- Thinking/reasoning tokens may be returned in `reasoning_content` field

### Text-Based Parsing Pattern

When structured output isn't available, use text parsing:

```typescript
// In agent instructions:
const promptText = `
Respond in this exact format:

STATUS: <pass|gaps_found|blocked>

SUMMARY:
<brief summary>

GAPS:
- <first gap>
- <second gap>

RECOMMENDED_PROMPT:
<specific prompt or "None">
`;

// Parsing the response:
const statusMatch = responseText.match(/STATUS:\s*(\w+)/i);
const summaryMatch = responseText.match(/SUMMARY:\s*([\s\S]+?)(?=\nGAPS:|$)/i);
const gapsMatch = responseText.match(/GAPS:\s*([\s\S]+?)(?=\nRECOMMENDED_PROMPT:|$)/i);

const status = statusMatch?.[1]?.toLowerCase().trim() || "blocked";
const summary = summaryMatch?.[1]?.trim() || "No summary provided";

const gapsText = gapsMatch?.[1] || "";
const gaps = gapsText
  .split("\n")
  .map(line => line.trim())
  .filter(line => line.startsWith("- ") || line.startsWith("* "))
  .map(line => line.replace(/^[-*]\s+/, "").trim())
  .filter(gap => gap.length > 0 && gap.toLowerCase() !== "none");
```

### Recommended Model Choices

- **For review tasks**: `opencode-go/kimi-k2.5` - Good reasoning, follows instructions well
- **For structured output**: `openai/gpt-4` or `anthropic/claude-3` - Native schema support
- **For fast operations**: Any lightweight model via opencode-go

---

## Testing Strategies

### Local Server Testing

Use `createOpencode` to spin up a temporary server for testing:

```typescript
import { createOpencode } from "@opencode-ai/sdk";

const opencode = await createOpencode({ port: 0 });  // Auto-assign port
const server = opencode.server;
const client = opencode.client;

// Run tests...

server.close();
```

### Test Pattern

```typescript
async function testWorkflow() {
  const opencode = await createOpencode({ port: 0 });
  const client = opencode.client;
  
  try {
    // Clear old logs
    if (existsSync(DEBUG_LOG_PATH)) {
      unlinkSync(DEBUG_LOG_PATH);
    }
    
    // Create session and send prompt
    const session = await client.session.create({
      body: { title: "Test Session" }
    });
    
    await client.session.prompt({
      path: { id: session.data.id },
      body: {
        parts: [{ type: "text", text: "Your test prompt #workflow" }]
      }
    });
    
    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check debug logs for results
    const logContent = readFileSync(DEBUG_LOG_PATH, "utf-8");
    const success = logContent.includes("workflow activation succeeded");
    
    return success;
  } finally {
    opencode.server.close();
  }
}
```

### Debug Logging

Always log to `.opencode/easy-workflow/debug.log`:

```typescript
const DEBUG_LOG_PATH = join(WORKFLOW_ROOT, "debug.log");

function appendDebugLog(kind: string, message: string, extra?: Record<string, unknown>): void {
  const payload = extra ? ` ${JSON.stringify(extra)}` : "";
  appendFileSync(
    DEBUG_LOG_PATH, 
    `[${new Date().toISOString()}] ${kind}: ${message}${payload}\n`, 
    "utf-8"
  );
}
```

---

## Common Pitfalls

### 1. Response Data Access

❌ **Wrong:**
```typescript
const result = await client.session.create({ body: { title: "Test" } });
console.log(result.id);  // undefined!
```

✅ **Correct:**
```typescript
const response = await client.session.create({ body: { title: "Test" } });
const result = unwrapResponseData<any>(response);
console.log(result.id);  // works!
```

### 2. Structured Output Field Name

❌ **Wrong:**
```typescript
const output = result?.info?.structured_output;
```

✅ **Correct:**
```typescript
const output = result?.info?.structured;
```

### 3. Model Provider Format

❌ **Wrong:**
```typescript
model: "kimi-k2.5"  // Missing provider prefix
```

✅ **Correct:**
```typescript
model: "opencode-go/kimi-k2.5"  // Full provider/model-id format
```

### 4. Tool Overrides and Structured Output

❌ **Wrong:**
```typescript
// Disabling all tools breaks StructuredOutput tool
body: {
  tools: { all_tools: false },
  format: schema
}
```

✅ **Correct:**
```typescript
// Let OpenCode manage tools naturally
body: {
  parts: [{ type: "text", text: prompt }]
  // Don't specify tools if you need structured output
}
```

### 5. Agent Matching

When checking if an agent is available, check multiple fields:

```typescript
function appAgentMatchesName(agent: unknown, name: string): boolean {
  const target = name.toLowerCase().replace(/[\s_]+/g, "-");
  
  if (typeof agent === "string") {
    return agent.toLowerCase().replace(/[\s_]+/g, "-") === target;
  }
  
  if (!agent || typeof agent !== "object") {
    return false;
  }
  
  const candidate = agent as Record<string, unknown>;
  return [candidate.name, candidate.id, candidate.slug]
    .map((value) => typeof value === "string" ? value.toLowerCase().replace(/[\s_]+/g, "-") : null)
    .some((value) => value === target);
}
```

### 6. Session Context in Hooks

The `chat.message` hook provides context via `input`:

```typescript
"chat.message": async (input: any, output: any) => {
  const agent = input?.agent;  // Current agent name
  const model = input?.model;  // { providerID, modelID }
  const sessionId = input?.sessionID;
  
  // Use these to route sub-tasks through the same agent/model
}
```

### 7. Error Handling

Provider errors have the message in `error.data.message`:

```typescript
function getAssistantErrorMessage(error: any): string {
  if (!error) return "Unknown error";
  
  // Check provider error first
  if (typeof error.data?.message === "string") {
    const statusCode = typeof error.data?.statusCode === "number" 
      ? ` (status ${error.data.statusCode})` 
      : "";
    return `${error.data.message}${statusCode}`;
  }
  
  // Fall back to standard error message
  if (typeof error.message === "string") {
    return error.message;
  }
  
  return JSON.stringify(error);
}
```

---

## Best Practices

1. **Always use try/finally** when creating scratch sessions to ensure cleanup
2. **Log everything** during development - use debug.log for diagnostics
3. **Check agent availability** before routing to subagents
4. **Use text parsing** as a fallback when structured output isn't available
5. **Preserve user context** - use the same agent/model from input when creating scratch sessions
6. **Handle missing data gracefully** - always provide fallback values
7. **Test with multiple models** - behavior varies between providers

---

## Reference Files

- Plugin implementation: `.opencode/plugins/easy-workflow.ts`
- Agent definitions: `.opencode/agents/`
- Workflow template: `.opencode/easy-workflow/workflow.md`
- Test script: `test-workflow.ts`
- OpenCode source: `/home/jmarceno/Projects/cloned/opencode/`
- SDK docs: `ref-docs/opencode.ai-sdk.md`
- Plugin docs: `ref-docs/opencode.ai-plugins.md`
- Agent docs: `ref-docs/opencode.ai-agents.md`

---

## About the Project

