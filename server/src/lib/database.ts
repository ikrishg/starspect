import * as schema from '../db/schema'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Drizzle } from '../db'
const D1_MAX_BOUND_PARAMS = 100
const USER_LOOKUP_BATCH_SIZE = D1_MAX_BOUND_PARAMS - 1
const RELATION_INSERT_BATCH_SIZE = Math.floor(D1_MAX_BOUND_PARAMS / 2)
/** Skipped rows use 3 bound columns each; D1 allows at most 100 variables per statement. */
export const SKIPPED_INSERT_BATCH_SIZE = 33
export const FULL_REPOSITORY_CACHE_MS = 1000 * 60 * 60 * 24 * 365
export const PARTIAL_REPOSITORY_CACHE_MS = 1000 * 60 * 60
export const SKIPPED_STARGAZER_TTL_MS = 1000 * 60 * 60 * 24 * 30
export const MAX_STARGAZER_FETCH_FAILURES = 3
export const STARGAZER_FAILURE_TTL_MS = 1000 * 60 * 60 * 24

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

export async function quarantineToken(db: Drizzle, stored: string) {
  await db
    .update(schema.tokens)
    .set({ tokenUnusable: true, lastTokenUseAt: new Date() })
    .where(eq(schema.tokens.token, stored))
    .execute()
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

  return [repository]
}

export async function fetchSkippedStargazersForRepository(db: Drizzle, name: string) {
  const skippedAfter = new Date(Date.now() - SKIPPED_STARGAZER_TTL_MS)
  const rows = await db
    .select()
    .from(schema.repositorySkippedStargazers)
    .where(
      and(
        eq(schema.repositorySkippedStargazers.repositoryId, name),
        gt(schema.repositorySkippedStargazers.skippedAt, skippedAfter),
      ),
    )
    .execute()

  return new Set(rows.map((row) => row.stargazerUsername))
}

export async function markStargazersSkipped(db: Drizzle, name: string, ...usernames: string[]) {
  if (usernames.length === 0) {
    return
  }

  const skippedAt = new Date()

  for (const batch of chunkValues(usernames, SKIPPED_INSERT_BATCH_SIZE)) {
    await db
      .insert(schema.repositorySkippedStargazers)
      .values(
        batch.map((username) => ({
          stargazerUsername: username,
          repositoryId: name,
          skippedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.repositorySkippedStargazers.repositoryId,
          schema.repositorySkippedStargazers.stargazerUsername,
        ],
        set: { skippedAt },
      })
      .execute()
  }
}

export async function clearStargazerFetchFailure(db: Drizzle, name: string, username: string) {
  await db
    .delete(schema.repositoryStargazerFailures)
    .where(
      and(
        eq(schema.repositoryStargazerFailures.repositoryId, name),
        eq(schema.repositoryStargazerFailures.stargazerUsername, username),
      ),
    )
    .execute()
}

export async function recordStargazerFetchFailure(db: Drizzle, name: string, username: string) {
  const now = new Date()
  const staleBefore = new Date(Date.now() - STARGAZER_FAILURE_TTL_MS)
  const staleBeforeSeconds = Math.floor(staleBefore.getTime() / 1000)
  const nowSeconds = Math.floor(now.getTime() / 1000)

  const rows = await db.all<{ failure_count: number }>(sql`
    INSERT INTO repository_stargazer_failures (repository_id, stargazer_username, failure_count, last_failed_at)
    VALUES (${name}, ${username}, 1, ${nowSeconds})
    ON CONFLICT (repository_id, stargazer_username) DO UPDATE SET
      failure_count = CASE
        WHEN last_failed_at < ${staleBeforeSeconds} THEN 1
        ELSE failure_count + 1
      END,
      last_failed_at = ${nowSeconds}
    RETURNING failure_count
  `)

  return rows[0]?.failure_count ?? 1
}

export async function fetchScoredStargazersForRepository(db: Drizzle, name: string) {
  const checkedAfter = new Date(Date.now() - FULL_REPOSITORY_CACHE_MS)
  const rows = await db
    .select({ stargazer: schema.stargazers })
    .from(schema.stargazersToRepos)
    .innerJoin(schema.stargazers, eq(schema.stargazersToRepos.stargazerUsername, schema.stargazers.username))
    .where(
      and(
        eq(schema.stargazersToRepos.repositoryId, name),
        gt(schema.stargazers.checkedAt, checkedAfter),
      ),
    )
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

export async function saveEmptyRepositoryScore(db: Drizzle, name: string) {
  return saveRepositoryScore(db, name, {
    n_stars: 0,
    n_scored_stars: 0,
    n_fake_stars: 0,
    n_low_activity: 0,
    n_activity_cluster: 0,
    score: 0,
    is_partial: false,
  })
}
