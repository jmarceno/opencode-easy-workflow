import type { Database } from "bun:sqlite"

export interface Migration {
  version: number
  description: string
  statements: string[]
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

export function runMigrations(db: Database, migrations: Migration[]): void {
  ensureMigrationTable(db)

  for (const migration of migrations.sort((a, b) => a.version - b.version)) {
    const alreadyApplied = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(migration.version) as { 1: number } | null

    if (alreadyApplied) continue

    const tx = db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement)
      }
      db
        .prepare("INSERT INTO schema_migrations (version, description) VALUES (?, ?)")
        .run(migration.version, migration.description)
    })

    tx()
  }
}
