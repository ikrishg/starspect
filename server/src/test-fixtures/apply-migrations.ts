import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

const loadMigrationStatements = (filename: string) =>
  readFileSync(join(migrationsDir, filename), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

export const applyD1Migrations = async (db: D1Database) => {
  await db.exec('PRAGMA foreign_keys = ON')
  for (const filename of ['0000_schema.sql', '0001_partial_scoring.sql']) {
    for (const statement of loadMigrationStatements(filename)) {
      await db.prepare(statement).run()
    }
  }
}
