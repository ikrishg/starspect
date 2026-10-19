import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../env'
import {
  fetchStargazers,
  fetchUser,
  GITHUB_HTTP_CALLS_PER_USER,
  MAX_STARGAZERS_TO_LIST,
  STARGAZERS_PER_LIST_PAGE,
  verifyRepositoryExists,
  WORKER_SUBREQUEST_BUDGET,
} from './github'
import {
  countAvailableTokens,
  createRepositoryRelation,
  fetchExistingRepository,
  fetchExistingUsers,
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

export async function score(env: AppBindings, owner: string, repo: string) {
  const db = drizzle(env.db, { schema })
  const name = `${owner}/${repo}`

  const existingRepository = await fetchExistingRepository(db, name)
  if (existingRepository) {
    return existingRepository[0]
  }

  const baseReserved = await selectTokens(db, 1, env.SESSION_SECRET)
  if (baseReserved.length === 0) {
    throw new HTTPException(429, {
      message: 'Not enough GitHub tokens are available for the estimated request count',
    })
  }

  const reservedTokens = [...baseReserved]

  try {
    await verifyRepositoryExists(owner, repo, baseReserved[0].plaintext)

    const stargazers = await fetchStargazers(owner, repo, baseReserved[0].plaintext)
    const precomputed = await fetchExistingUsers(db, ...stargazers)
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

    const fetchedUsers =
      chunks.length === 0
        ? []
        : (
            await Promise.all(
              chunks.map(async (userChunk, index) => {
                const settled = await Promise.allSettled(
                  userChunk.map((user) =>
                    fetchUser(env.db, reservedTokens[index].plaintext, user),
                  ),
                )

                return settled.flatMap((result) =>
                  result.status === 'fulfilled' && result.value ? [result.value] : [],
                )
              }),
            )
          ).flat()

    const users = [...precomputed.values(), ...fetchedUsers]

    if (users.length > 0) {
      await createRepositoryRelation(db, name, ...users.map((user) => user.username))
    }

    const repositoryStats = scoreRepository(users)
    return saveRepositoryScore(db, name, repositoryStats)
  } catch (error) {
    if (error instanceof HTTPException && error.status === 429) {
      await releaseReservedTokens(db, reservedTokens)
    }
    throw error
  }
}
