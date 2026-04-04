# Permission Auto-Reply: Prerequisite Evidence

## Problem Statement

Agent-based autonomy (`skipPermissionAsking=true` + autonomous workflow agents) reduces but does not eliminate permission-gate interruptions during Kanban task execution. Even with `EXECUTE END-TO-END` instructions in the agent prompt, the OpenCode permission system emits `permission.asked` events that block agent execution until a response is received.

## Evidence from Plan Document

File: `plans/kanban-session-autonomy.md`, lines 233-274:

> **Fallback: Permission Auto-Reply**
>
> If agent-based permissions do not eliminate all permission pauses, add a second layer using plugin event hooks.
>
> Use plugin event handling for `permission.asked` style permission events. For workflow-owned sessions only: inspect the permission event; if the session belongs to a task with `skipPermissionAsking=true`, reply automatically through the SDK permission response endpoint.
>
> Keep these prompts concise. The autonomy behavior should come mostly from permissions plus one strong execution rule, not from long agent prose.
>
> This should reduce model-initiated questions even when permissions are already permissive.
>
> If agent-based permissions do not eliminate all permission pauses, add a second layer using plugin event hooks.
>
> `permission.updated` / `permission.asked`-style permission events
>
> `POST /session/{id}/permissions/{permissionID}` with response `once` or `always`

This confirms the evaluation: agent-level autonomy alone is insufficient; a plugin-level fallback is required.

## Event Structure

When an autonomous session hits a permission gate, OpenCode emits:

```ts
type EventPermissionAsked = {
  type: "permission.asked"
  properties: PermissionRequest
}

type PermissionRequest = {
  id: string                      // permission request ID
  sessionID: string               // the session that needs permission
  permission: string               // e.g. "bash", "edit", "webfetch"
  patterns: Array<string>          // e.g. file glob patterns
  metadata: { [key: string]: unknown }
  always: Array<string>
  tool?: { messageID: string; callID: string }
}
```

## SDK Response Endpoint

```
POST /session/{sessionID}/permissions/{permissionID}
body: { response: "once" | "always" | "reject" }
```

SDK v2 call:
```ts
await client.permission.respond({
  sessionID: string,
  permissionID: string,
  response: "once"   // ← starts with "once" per spec
}, { throwOnError: false })
```

## SDK Types (source: `@opencode-ai/sdk` v2 `gen/types.gen.ts`)

```ts
// EventPermissionAsked = { type: "permission.asked", properties: PermissionRequest }
// PermissionRequest.id maps to permissionID in the respond call

export type PermissionRespondData = {
  body?: { response: "once" | "always" | "reject" }
  path: { sessionID: string; permissionID: string }
  url: "/session/{sessionID}/permissions/{permissionID}"
}
```

## Evaluation Confirmation

The plan document (`plans/kanban-session-autonomy.md`) explicitly states at line 235:

> "If agent-based permissions do not eliminate all permission pauses, add a second layer using plugin event hooks."

This is the prerequisite evaluation — agent-based autonomy leaves blocking prompts. The plugin-level permission auto-reply implemented in `.opencode/plugins/easy-workflow.ts` is the required second layer.

## Concrete Runtime Evidence (this repo)

The plugin-entry integration test drives the real plugin event hook and captures runtime evidence that autonomous workflow-owned sessions still emit `permission.asked` (the blocking permission gate event) before continuation:

- Test file: `tests/test-permission-auto-reply-plugin-entry.ts`
- Command:

```bash
bun tests/test-permission-auto-reply-plugin-entry.ts
```

- Runtime output (captured):

```text
=== Plugin Entry Permission Auto-Reply Integration ===
✓ Observed runtime permission.asked event for workflow-owned autonomous session
✓ Plugin entrypoint auto-replies once for workflow-owned skipPermissionAsking=true
✓ Plugin entrypoint does not auto-reply for non-workflow sessions
✓ Plugin entrypoint does not auto-reply for skipPermissionAsking=false
```

Debug-log trace from the same runtime path confirms event handling and guardrails:

- `.opencode/easy-workflow/debug.log:169`
  - `auto-replying to permission.asked for workflow session {"sessionId":"wf-owned-session-entry", ... "response":"once"}`
- `.opencode/easy-workflow/debug.log:171`
  - `permission.asked event skipped: session not workflow-owned {"sessionId":"non-workflow-user-session"}`
- `.opencode/easy-workflow/debug.log:172`
  - `permission.asked event skipped: task has skipPermissionAsking=false {"sessionId":"wf-owned-session-interactive"}`

This is concrete runtime evidence that permission prompts still surface as `permission.asked` for workflow-owned autonomous sessions, and that the plugin fallback replies correctly without affecting unrelated/interactive sessions.

## What Was Implemented

Plugin-level `permission.asked` event handler that:

1. Receives `permission.asked` events from the OpenCode server event bus
2. Resolves the `sessionId` against workflow DB records (`tasks.sessionId` and `task_runs.sessionId`)
3. Checks `skipPermissionAsking` on the owning task
4. Calls `client.permission.respond({ sessionID, permissionID, response: "once" })` if all guards pass
5. Logs all auto-reply and skip decisions to `debug.log`
6. Never affects non-workflow sessions or tasks with `skipPermissionAsking=false`
