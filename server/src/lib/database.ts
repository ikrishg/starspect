import * as schema from '../db/schema'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Drizzle } from '../db'
import { decryptGitHubToken } from './tokens'

const TOKEN_COOLDOWN_SECONDS = 60 * 60
const D1_MAX_BOUND_PARAMS = 100
const USER_LOOKUP_BATCH_SIZE = D1_MAX_BOUND_PARAMS - 1
const RELATION_INSERT_BATCH_SIZE = Math.floor(D1_MAX_BOUND_PARAMS / 2)
export const FULL_REPOSITORY_CACHE_MS = 1000 * 60 * 60 * 24 * 365
export const PARTIAL_REPOSITORY_CACHE_MS = 1000 * 60 * 60

export type ReservedGitHubToken = {
  plaintext: string
  stored: string
  userId: string
}

const chunkValues = <T>(values: T[], batchSize: number): T[][] => {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize))
  }
  return batches
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export async function countAvailableTokens(db: Drizzle) {
  const cutoff = nowSeconds() - TOKEN_COOLDOWN_SECONDS
  const [{ count }] = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM tokens
    WHERE last_token_use_at < ${cutoff}
      AND (token_unusable IS NULL OR token_unusable = 0)
  `)
  return count
}

export async function quarantineToken(db: Drizzle, stored: string) {
  await db
    .update(schema.tokens)
    .set({ tokenUnusable: true, lastTokenUseAt: new Date(0) })
    .where(eq(schema.tokens.token, stored))
    .execute()
}

export async function selectTokens(
  db: Drizzle,
  needed: number,
  sessionSecret: string,
): Promise<ReservedGitHubToken[]> {
  if (needed <= 0) {
    return []
  }

  const now = nowSeconds()
  const cutoff = now - TOKEN_COOLDOWN_SECONDS

  const rows = await db.all<{ github_token: string; user_id: string }>(sql`
    UPDATE tokens
    SET last_token_use_at = ${now}
    WHERE rowid IN (
      SELECT rowid FROM tokens
      WHERE last_token_use_at < ${cutoff}
        AND (token_unusable IS NULL OR token_unusable = 0)
      ORDER BY last_token_use_at ASC
      LIMIT ${needed}
    )
    RETURNING github_token, user_id
  `)

  const reserved: ReservedGitHubToken[] = []

  for (const row of rows) {
    const stored = row.github_token
    try {
      const plaintext = await decryptGitHubToken(stored, sessionSecret, row.user_id)
      reserved.push({ plaintext, stored, userId: row.user_id })
    } catch {
      await quarantineToken(db, stored)
    }
  }

  return reserved
}

export async function releaseReservedTokens(db: Drizzle, reserved: ReservedGitHubToken[]) {
  if (reserved.length === 0) {
    return
  }

  const storedTokens = reserved.map((token) => token.stored)

  for (const batch of chunkValues(storedTokens, USER_LOOKUP_BATCH_SIZE)) {
    await db
      .update(schema.tokens)
      .set({ lastTokenUseAt: new Date(0) })
      .where(inArray(schema.tokens.token, batch))
      .execute()
  }
}

export async function fetchExistingUsers(db: Drizzle, ...usernames: string[]) {
  if (usernames.length === 0) {
    return new Map<string, typeof schema.stargazers.$inferSelect>()
  }

  const checkedAfter = new Date(Date.now() - FULL_REPOSITORY_CACHE_MS)
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

const repositoryCacheCutoff = (isPartial: boolean) =>
  new Date(Date.now() - (isPartial ? PARTIAL_REPOSITORY_CACHE_MS : FULL_REPOSITORY_CACHE_MS))

export async function fetchExistingRepository(db: Drizzle, name: string) {
  const [repository] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.name, name))
    .execute()

  if (!repository?.checkedAt) {
    return null
  }

  const isPartial = repository.isPartial ?? false
  if (repository.checkedAt <= repositoryCacheCutoff(isPartial)) {
    return null
  }

  if (isPartial) {
    return null
  }

  return [repository]
}

export async function fetchPartialRepository(db: Drizzle, name: string) {
  const [repository] = await db
    .select()
    .from(schema.repositories)
    .where(eq(schema.repositories.name, name))
    .execute()

  if (!repository?.checkedAt || !repository.isPartial) {
    return null
  }

  if (repository.checkedAt <= repositoryCacheCutoff(true)) {
    return null
  }

  return repository
}

export async function fetchScoredStargazersForRepository(db: Drizzle, name: string) {
  const rows = await db
    .select({ stargazer: schema.stargazers })
    .from(schema.stargazersToRepos)
    .innerJoin(schema.stargazers, eq(schema.stargazersToRepos.stargazerUsername, schema.stargazers.username))
    .where(eq(schema.stargazersToRepos.repositoryId, name))
    .execute()

  return rows.map((row) => row.stargazer)
}

export async function ensureRepositoryRow(db: Drizzle, name: string) {
  await db
    .insert(schema.repositories)
    .values({
      name,
      checkedAt: null,
      isPartial: true,
    })
    .onConflictDoNothing()
    .execute()
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

export type RepositoryScoreStats = {
  n_stars: number
  n_scored_stars: number
  n_fake_stars: number
  n_low_activity: number
  n_activity_cluster: number
  score: number
  is_partial: boolean
}

export async function saveRepositoryScore(db: Drizzle, name: string, stats: RepositoryScoreStats) {
  const checkedAt = new Date()

  await db
    .insert(schema.repositories)
    .values({
      name,
      n_stars: stats.n_stars,
      n_scored_stars: stats.n_scored_stars,
      n_fake_stars: stats.n_fake_stars,
      n_low_activity: stats.n_low_activity,
      n_activity_cluster: stats.n_activity_cluster,
      score: stats.score,
      isPartial: stats.is_partial,
      checkedAt,
    })
    .onConflictDoUpdate({
      target: schema.repositories.name,
      set: {
        n_stars: stats.n_stars,
        n_scored_stars: stats.n_scored_stars,
        n_fake_stars: stats.n_fake_stars,
        n_low_activity: stats.n_low_activity,
        n_activity_cluster: stats.n_activity_cluster,
        score: stats.score,
        isPartial: stats.is_partial,
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
