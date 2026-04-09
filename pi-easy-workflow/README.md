# Pi Easy Workflow (MVP)

Pi-based Easy Workflow runtime and kanban server, migrated from the OpenCode execution model.

This project is intentionally isolated under `pi-easy-workflow/` and does not replace the legacy implementation in-place.

## Quick start

```bash
bun install
bun run setup
bun run src/index.ts
```

The server starts on `PI_EASY_WORKFLOW_PORT` when set, or an automatic/default port otherwise.

## Main commands

```bash
# Start server
bun run start

# Dev mode
bun run dev

# Run tests
bun test

# Run tests with coverage
bun test --coverage

# Sync project-local skills to .pi/skills
bun run skills:install

# Verify local Pi setup files
bun run skills:verify
```

## Environment variables

- `PI_EASY_WORKFLOW_PORT` - HTTP server port (`0` allowed for random free port)
- `PI_EASY_WORKFLOW_DB_PATH` - Override SQLite DB path
- `PI_EASY_WORKFLOW_PI_BIN` - Override Pi binary path (used heavily by tests/mocks)
- `PI_EASY_WORKFLOW_PI_ARGS` - Override Pi runtime args (default is `--rpc --no-extensions`)

## Runtime model (MVP)

- One Pi RPC process per workflow-owned session
- Full raw capture to DB (`session_io`) for stdin/stdout/stderr/lifecycle/snapshots/prompts
- Normalized projection in `session_messages`
- Prompt templates are DB-backed (`prompt_templates`)
- Skills are file-based and synced into `.pi/skills/`

## Verification and migration status

- MVP verification report: `./MVP_VERIFICATION.md`
- Explicit known gaps and next steps: `./MVP_GAPS.md`
