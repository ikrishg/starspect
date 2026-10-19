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
  clearStargazerFetchFailure,
  markStargazersSkipped,
  MAX_STARGAZER_FETCH_FAILURES,
  recordStargazerFetchFailure,
  releaseReservedTokens,
  saveEmptyRepositoryScore,
  saveRepositoryScore,
  selectTokens,
} from './database'
import { isGitHubRateLimitResponse } from './github-errors'
import {
  finalizeReservedTokensOnError,
  isGitHubTokenUnauthorized,
} from './token-errors'
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

  const previouslyScored = await fetchScoredStargazersForRepository(db, name)
  const skippedStargazers = await fetchSkippedStargazersForRepository(db, name)

  const baseReserved = await selectTokens(db, 1, env.SESSION_SECRET)
  if (baseReserved.length === 0) {
    throw new HTTPException(429, {
      message: 'Not enough GitHub tokens are available for the estimated request count',
    })
  }

  const reservedTokens = [...baseReserved]
  let tokensFinalized = false

  try {
    const metadata = await deps.fetchRepositoryMetadata(owner, repo, baseReserved[0].plaintext)
    await ensureRepositoryRow(db, name)

    if (metadata.stargazers_count === 0) {
      await releaseReservedTokens(db, reservedTokens)
      return saveEmptyRepositoryScore(db, name)
    }

    const sampleListed = await deps.fetchStargazers(owner, repo, baseReserved[0].plaintext)
    const totalStarCount = metadata.stargazers_count
    const sampleSet = new Set(sampleListed)
    const scoredUsernames = new Set(
      previouslyScored.filter((user) => sampleSet.has(user.username)).map((user) => user.username),
    )

    const precomputed = await fetchExistingUsers(
      db,
      ...sampleListed.filter((login) => !scoredUsernames.has(login) && !skippedStargazers.has(login)),
    )

    for (const user of previouslyScored) {
      if (sampleSet.has(user.username)) {
        precomputed.set(user.username, user)
      }
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
    let hitRateLimit = false
    const unavailableThisRequest: string[] = []
    const scoredUsernameSet = new Set<string>()
    const fetchedUsers: Array<typeof schema.stargazers.$inferSelect> = []

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      if (hitRateLimit) {
        break
      }

      const userChunk = chunks[chunkIndex]
      const settled = await Promise.allSettled(
        userChunk.map((user) =>
          deps.fetchUser(env.db, reservedTokens[chunkIndex].plaintext, user),
        ),
      )

      for (let resultIndex = 0; resultIndex < settled.length; resultIndex++) {
        const result = settled[resultIndex]
        const username = userChunk[resultIndex]

        if (result.status === 'fulfilled') {
          if (result.value) {
            fetchedUsers.push(result.value)
            scoredUsernameSet.add(username)
            await clearStargazerFetchFailure(db, name, username)
            continue
          }
          unavailableThisRequest.push(username)
          skippedStargazers.add(username)
          continue
        }

        if (isGitHubTokenUnauthorized(result.reason)) {
          await finalizeReservedTokensOnError(
            db,
            reservedTokens,
            result.reason,
            reservedTokens[chunkIndex],
          )
          tokensFinalized = true
          throw result.reason
        }

        if (isGitHubRateLimitResponse(result.reason)) {
          hadFetchFailures = true
          hitRateLimit = true
          continue
        }

        hadFetchFailures = true
        const failureCount = await recordStargazerFetchFailure(db, name, username)
        if (failureCount >= MAX_STARGAZER_FETCH_FAILURES) {
          unavailableThisRequest.push(username)
          skippedStargazers.add(username)
        }
      }
    }

    if (unavailableThisRequest.length > 0) {
      await markStargazersSkipped(db, name, ...unavailableThisRequest)
    }

    const users = [...precomputed.values(), ...fetchedUsers]
    const uniqueUsers = [...new Map(users.map((user) => [user.username, user])).values()]
    const scoredCount = uniqueUsers.length

    if (fetchedUsers.length > 0) {
      await createRepositoryRelation(db, name, ...fetchedUsers.map((user) => user.username))
    }

    const resolvedInSample = new Set<string>([
      ...precomputed.keys(),
      ...scoredUsernameSet,
      ...skippedStargazers,
    ])
    const unresolvedInSample = sampleListed.filter((login) => !resolvedInSample.has(login))

    if (totalStarCount > 0 && sampleListed.length === 0) {
      const repositoryStats = scoreRepository(uniqueUsers, totalStarCount)
      return saveRepositoryScore(db, name, {
        ...repositoryStats,
        is_partial: true,
      })
    }

    const isPartial = hadFetchFailures || hitRateLimit || unresolvedInSample.length > 0

    if (
      scoredCount === 0 &&
      unresolvedInSample.length > 0 &&
      skippedStargazers.size === 0 &&
      !hadFetchFailures
    ) {
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
    if (!tokensFinalized) {
      const unauthorizedToken =
        isGitHubTokenUnauthorized(error) && reservedTokens.length > 0
          ? reservedTokens[0]
          : undefined
      await finalizeReservedTokensOnError(db, reservedTokens, error, unauthorizedToken)
    }
    throw error
  }
}
