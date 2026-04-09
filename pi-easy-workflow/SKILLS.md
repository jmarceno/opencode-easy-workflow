# Pi local skills setup

This project keeps Pi skills local and reproducible inside `pi-easy-workflow/`.

## Layout

- Source of truth (tracked): `skills/<skill-name>/SKILL.md`
- Pi runtime location (generated): `.pi/skills/<skill-name>/SKILL.md`
- Pi config (tracked): `.pi/settings.json`

The runtime directory is generated from source. Core workflow behavior should not depend on global skill installation.

## Commands

From `pi-easy-workflow/`:

```bash
bun run skills:sync
```

Incrementally copies source skills to `.pi/skills/`.

```bash
bun run skills:install
```

Performs a clean install (`--clean`): removes `.pi/skills/` then copies all source skills.

```bash
bun run skills:verify
```

Verifies:

- source skills exist
- each skill has required frontmatter
- `.pi/settings.json` is valid and configured for local skills
- `.pi/skills/` is writable

```bash
bun run setup
```

Runs full reproducible setup (`skills:install` + `skills:verify`).

## Adding a new skill

1. Create `skills/<new-skill>/SKILL.md`.
2. Include YAML frontmatter with at least `name` and `description`.
3. Run `bun run skills:sync` (or `bun run skills:install`).
4. Run `bun run skills:verify`.

## Pi settings

`.pi/settings.json` is configured with:

- `skills.localPath = "./skills"`
- `skills.autoLoad = true`
- `skills.allowGlobal = false`

This ensures Pi uses project-local skills and avoids global skill drift.

## Troubleshooting

- **"No skills found"**: ensure each skill folder contains `SKILL.md`.
- **Settings validation failed**: check `.pi/settings.json` fields and JSON syntax.
- **Skill changes not visible**: rerun `bun run skills:install`.
- **Permission errors writing `.pi/skills`**: ensure the workspace is writable.
