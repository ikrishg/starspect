import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../env'
import * as github from './github'
import {
  GITHUB_HTTP_CALLS_PER_USER,
  MAX_STARGAZERS_TO_LIST,
  STARGAZERS_PER_LIST_PAGE,
  WORKER_SUBREQUEST_BUDGET,
} from './github'
import { ensureSessionSecret } from './crypto-keys'
import {
  countAvailableTokens,
  createRepositoryRelation,
  ensureRepositoryRow,
  fetchExistingRepository,
  fetchExistingUsers,
  fetchScoredStargazersForRepository,
  fetchSkippedStargazersForRepository,
  markStargazersSkipped,
  releaseReservedTokens,
  saveEmptyRepositoryScore,
  saveRepositoryScore,
  selectTokens,
} from './database'
import chunk from 'lodash.chunk'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { scoreRepository } from './scoring'

const STARGAZER_LIST_PAGES = Math.ceil(MAX_STARGAZERS_TO_LIST / STARGAZERS_PER_LIST_PAGE)
const RESERVED_SUBREQUESTS = 6
const GITHUB_USERS_PER_TOKEN = Math.floor(4096 / GITHUB_HTTP_CALLS_PER_USER)

// Per-request subrequest budget: list pages + repo verify + D1/KV/rate-limit overhead + up to
// MAX_NEW_USERS_PER_REQUEST stargazer profiles at GITHUB_HTTP_CALLS_PER_USER calls each.
export const MAX_NEW_USERS_PER_REQUEST = Math.max(
  1,
  Math.min(
    10,
    Math.floor(
      (WORKER_SUBREQUEST_BUDGET - RESERVED_SUBREQUESTS - STARGAZER_LIST_PAGES - 1) /
        GITHUB_HTTP_CALLS_PER_USER,
    ),
  ),
)

export type ScoreGithubDeps = {
  fetchRepositoryMetadata: typeof github.fetchRepositoryMetadata
  fetchStargazers: typeof github.fetchStargazers
  fetchUser: typeof github.fetchUser
}

const defaultGithubDeps: ScoreGithubDeps = {
  fetchRepositoryMetadata: github.fetchRepositoryMetadata,
  fetchStargazers: github.fetchStargazers,
  fetchUser: github.fetchUser,
}

const assertSessionSecretConfigured = (sessionSecret: string) => {
  try {
    ensureSessionSecret(sessionSecret)
  } catch {
    throw new HTTPException(500, { message: 'Server session encryption is misconfigured' })
  }
}

export async function score(
  env: AppBindings,
  owner: string,
  repo: string,
  deps: ScoreGithubDeps = defaultGithubDeps,
) {
  const db = drizzle(env.db, { schema })
  const name = `${owner}/${repo}`

  const existingRepository = await fetchExistingRepository(db, name)
  if (existingRepository && !existingRepository[0].isPartial) {
    return existingRepository[0]
  }

  assertSessionSecretConfigured(env.SESSION_SECRET)

  const partialRow = existingRepository?.[0]?.isPartial ? existingRepository[0] : null
  const previouslyScored = partialRow ? await fetchScoredStargazersForRepository(db, name) : []
  const skippedStargazers = partialRow
    ? await fetchSkippedStargazersForRepository(db, name)
    : new Set<string>()

  const baseReserved = await selectTokens(db, 1, env.SESSION_SECRET)
  if (baseReserved.length === 0) {
    throw new HTTPException(429, {
      message: 'Not enough GitHub tokens are available for the estimated request count',
    })
  }

  const reservedTokens = [...baseReserved]

  try {
    const metadata = await deps.fetchRepositoryMetadata(owner, repo, baseReserved[0].plaintext)
    await ensureRepositoryRow(db, name)

    if (metadata.stargazers_count === 0) {
      await releaseReservedTokens(db, reservedTokens)
      return saveEmptyRepositoryScore(db, name)
    }

    const stargazers = await deps.fetchStargazers(owner, repo, baseReserved[0].plaintext)
    const sampleListed = stargazers
    const totalStarCount = metadata.stargazers_count
    const scoredUsernames = new Set(previouslyScored.map((user) => user.username))

    const precomputed = await fetchExistingUsers(
      db,
      ...sampleListed.filter((login) => !scoredUsernames.has(login) && !skippedStargazers.has(login)),
    )

    for (const user of previouslyScored) {
      precomputed.set(user.username, user)
    }

    const isResolved = (login: string) =>
      precomputed.has(login) || scoredUsernames.has(login) || skippedStargazers.has(login)

    const newUsers = sampleListed.filter((stargazer) => !isResolved(stargazer)).slice(0, MAX_NEW_USERS_PER_REQUEST)

    const chunks = chunk(newUsers, GITHUB_USERS_PER_TOKEN)
    const additionalNeeded = Math.max(0, chunks.length - 1)

    if (additionalNeeded > 0) {
      const available = await countAvailableTokens(db)
      if (available < additionalNeeded) {
        throw new HTTPException(429, {
          message: 'Not enough GitHub tokens are available for the estimated request count',
        })
      }

      const additionalReserved = await selectTokens(db, additionalNeeded, env.SESSION_SECRET)
      reservedTokens.push(...additionalReserved)
    }

    if (reservedTokens.length < chunks.length) {
      throw new HTTPException(429, {
        message: 'Not enough GitHub tokens are available for the estimated request count',
      })
    }

    let hadFetchFailures = false
    const unavailableThisRequest: string[] = []

    const fetchedUsers =
      chunks.length === 0
        ? []
        : (
            await Promise.all(
              chunks.map(async (userChunk, index) => {
                const settled = await Promise.allSettled(
                  userChunk.map((user) =>
                    deps.fetchUser(env.db, reservedTokens[index].plaintext, user),
                  ),
                )

                return settled.flatMap((result, resultIndex) => {
                  const username = userChunk[resultIndex]
                  if (result.status === 'fulfilled') {
                    if (result.value) {
                      return [result.value]
                    }
                    unavailableThisRequest.push(username)
                    skippedStargazers.add(username)
                    return []
                  }
                  hadFetchFailures = true
                  return []
                })
              }),
            )
          ).flat()

    if (unavailableThisRequest.length > 0) {
      await markStargazersSkipped(db, name, ...unavailableThisRequest)
    }

    const users = [...precomputed.values(), ...fetchedUsers]
    const uniqueUsers = [...new Map(users.map((user) => [user.username, user])).values()]
    const scoredCount = uniqueUsers.length

    if (fetchedUsers.length > 0) {
      await createRepositoryRelation(db, name, ...fetchedUsers.map((user) => user.username))
    }

    const unresolvedInSample = sampleListed.filter(
      (login) =>
        !uniqueUsers.some((user) => user.username === login) && !skippedStargazers.has(login),
    )

    const isPartial = hadFetchFailures || unresolvedInSample.length > 0

    if (scoredCount === 0 && skippedStargazers.size === 0 && unresolvedInSample.length > 0) {
      throw new HTTPException(503, {
        message: 'Could not score any stargazers for this repository yet',
      })
    }

    const repositoryStats = scoreRepository(uniqueUsers, totalStarCount)
    return saveRepositoryScore(db, name, {
      ...repositoryStats,
      is_partial: isPartial,
    })
  } catch (error) {
    await releaseReservedTokens(db, reservedTokens)
    throw error
  }
}
