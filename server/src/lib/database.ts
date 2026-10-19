import * as schema from '../db/schema'
import { asc, and, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import type { Drizzle } from '../db'
import { decryptGitHubToken } from './tokens'

const TOKEN_COOLDOWN_MS = 1000 * 60 * 60
const D1_MAX_BOUND_PARAMS = 100
const USER_LOOKUP_BATCH_SIZE = D1_MAX_BOUND_PARAMS - 1
const RELATION_INSERT_BATCH_SIZE = Math.floor(D1_MAX_BOUND_PARAMS / 2)

const chunkValues = <T>(values: T[], batchSize: number): T[][] => {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize))
  }
  return batches
}

export async function selectTokens(db: Drizzle, needed: number, sessionSecret: string) {
  if (needed <= 0) {
    return []
  }

  const now = Date.now()
  const cutoff = now - TOKEN_COOLDOWN_MS

  const rows = await db.all<{ github_token: string }>(sql`
    UPDATE tokens
    SET last_token_use_at = ${now}
    WHERE rowid IN (
      SELECT rowid FROM tokens
      WHERE last_token_use_at < ${cutoff}
      ORDER BY last_token_use_at ASC
      LIMIT ${needed}
    )
    RETURNING github_token
  `)

  return Promise.all(rows.map((row) => decryptGitHubToken(row.github_token, sessionSecret)))
}

export async function fetchExistingUsers(db: Drizzle, ...usernames: string[]) {
  if (usernames.length === 0) {
    return new Map<string, typeof schema.stargazers.$inferSelect>()
  }

  const checkedAfter = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365)
  const users: Array<typeof schema.stargazers.$inferSelect> = []

  for (const batch of chunkValues(usernames, USER_LOOKUP_BATCH_SIZE)) {
    const batchUsers = await db
      .select()
      .from(schema.stargazers)
      .where(
        and(
          inArray(schema.stargazers.username, batch),
          gt(schema.stargazers.checkedAt, checkedAfter),
        ),
      )
      .execute()

    users.push(...batchUsers)
  }

  return new Map(users.map((user) => [user.username, user]))
}

export async function fetchExistingRepository(db: Drizzle, name: string) {
  const repository = await db
    .select()
    .from(schema.repositories)
    .where(
      and(
        eq(schema.repositories.name, name),
        gt(schema.repositories.checkedAt, new Date(Date.now() - 1000 * 60 * 60 * 24 * 365)),
      ),
    )
    .execute()

  if (repository.length === 0) {
    await db
      .insert(schema.repositories)
      .values({ name })
      .onConflictDoNothing()
      .execute()

    return null
  }

  return repository
}

export async function createRepositoryRelation(db: Drizzle, name: string, ...usernames: string[]) {
  if (usernames.length === 0) {
    return
  }

  for (const batch of chunkValues(usernames, RELATION_INSERT_BATCH_SIZE)) {
    await db
      .insert(schema.stargazersToRepos)
      .values(
        batch.map((username) => ({
          stargazerUsername: username,
          repositoryId: name,
        })),
      )
      .onConflictDoNothing()
      .execute()
  }
}

export async function saveRepositoryScore(
  db: Drizzle,
  name: string,
  stats: {
    n_stars: number
    n_fake_stars: number
    n_low_activity: number
    n_activity_cluster: number
    score: number
  },
) {
  const checkedAt = new Date()

  await db
    .insert(schema.repositories)
    .values({
      name,
      ...stats,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: schema.repositories.name,
      set: {
        ...stats,
        checkedAt,
      },
    })
    .execute()

  const [repository] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.name, name))
    .execute()

  return repository
}
