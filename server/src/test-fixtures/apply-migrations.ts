import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

const loadMigrationStatements = (filename: string) =>
  readFileSync(join(migrationsDir, filename), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement: string) => statement.trim())
    .filter((statement: string) => statement.length > 0)

export const applyD1Migrations = async (db: D1Database) => {
  await db.exec('PRAGMA foreign_keys = ON')
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const filename of migrationFiles) {
    for (const statement of loadMigrationStatements(filename)) {
      await db.prepare(statement).run()
    }
  }
}
