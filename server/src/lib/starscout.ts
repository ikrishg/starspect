import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../env'
import * as github from './github'
import {
  GITHUB_HTTP_CALLS_PER_USER,
  MAX_STARGAZERS_TO_LIST,
  STARGAZERS_PER_LIST_PAGE,
  WORKER_SUBREQUEST_BUDGET,
} from './github'
import {
  countAvailableTokens,
  createRepositoryRelation,
  ensureRepositoryRow,
  fetchExistingRepository,
  fetchExistingUsers,
  fetchPartialRepository,
  fetchScoredStargazersForRepository,
  releaseReservedTokens,
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
  verifyRepositoryExists: typeof github.verifyRepositoryExists
  fetchStargazers: typeof github.fetchStargazers
  fetchUser: typeof github.fetchUser
}

const defaultGithubDeps: ScoreGithubDeps = {
  verifyRepositoryExists: github.verifyRepositoryExists,
  fetchStargazers: github.fetchStargazers,
  fetchUser: github.fetchUser,
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
  if (existingRepository) {
    return existingRepository[0]
  }

  const partialRepository = await fetchPartialRepository(db, name)
  const previouslyScored = partialRepository
    ? await fetchScoredStargazersForRepository(db, name)
    : []

  const baseReserved = await selectTokens(db, 1, env.SESSION_SECRET)
  if (baseReserved.length === 0) {
    throw new HTTPException(429, {
      message: 'Not enough GitHub tokens are available for the estimated request count',
    })
  }

  const reservedTokens = [...baseReserved]

  try {
    await deps.verifyRepositoryExists(owner, repo, baseReserved[0].plaintext)
    await ensureRepositoryRow(db, name)

    const stargazers = await deps.fetchStargazers(owner, repo, baseReserved[0].plaintext)
    const listedCount = stargazers.length
    const scoredUsernames = new Set(previouslyScored.map((user) => user.username))

    const precomputed = await fetchExistingUsers(
      db,
      ...stargazers.filter((login) => !scoredUsernames.has(login)),
    )

    for (const user of previouslyScored) {
      precomputed.set(user.username, user)
    }

    const newUsers = stargazers
      .filter((stargazer) => !precomputed.has(stargazer))
      .slice(0, MAX_NEW_USERS_PER_REQUEST)

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

                return settled.flatMap((result) => {
                  if (result.status === 'fulfilled') {
                    if (result.value) {
                      return [result.value]
                    }
                    return []
                  }
                  hadFetchFailures = true
                  return []
                })
              }),
            )
          ).flat()

    const users = [...precomputed.values(), ...fetchedUsers]
    const uniqueUsers = [...new Map(users.map((user) => [user.username, user])).values()]
    const scoredCount = uniqueUsers.length

    const isPartial =
      hadFetchFailures || listedCount >= MAX_STARGAZERS_TO_LIST || scoredCount < listedCount

    if (fetchedUsers.length > 0) {
      await createRepositoryRelation(db, name, ...fetchedUsers.map((user) => user.username))
    }

    if (scoredCount === 0) {
      throw new HTTPException(503, {
        message: 'Could not score any stargazers for this repository yet',
      })
    }

    const repositoryStats = scoreRepository(uniqueUsers, listedCount)
    return saveRepositoryScore(db, name, {
      ...repositoryStats,
      is_partial: isPartial,
    })
  } catch (error) {
    await releaseReservedTokens(db, reservedTokens)
    throw error
  }
}
