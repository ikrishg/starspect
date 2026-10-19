import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../env'
import { fetchStargazers, fetchUser } from './github'
import {
  createRepositoryRelation,
  fetchExistingRepository,
  fetchExistingUsers,
  saveRepositoryScore,
  selectTokens,
} from './database'
import chunk from 'lodash.chunk'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { scoreRepository } from './scoring'

export async function score(env: AppBindings, owner: string, repo: string) {
  const db = drizzle(env.db, { schema })
  const name = `${owner}/${repo}`

  const existingRepository = await fetchExistingRepository(db, name)
  if (existingRepository) {
    return existingRepository[0]
  }

  const baseToken = await selectTokens(db, 1, env.SESSION_SECRET)
  if (baseToken.length === 0) {
    throw new HTTPException(429, { message: 'Not enough GitHub tokens are available for the estimated request count' })
  }

  const stargazers = await fetchStargazers(owner, repo, baseToken[0])
  const precomputed = await fetchExistingUsers(db, ...stargazers)
  const newUsers = stargazers.filter((stargazer) => !precomputed.has(stargazer))
  const chunks = chunk(newUsers, Math.ceil(4096 / 3))

  const additionalTokens =
    chunks.length > 0 ? await selectTokens(db, chunks.length - 1, env.SESSION_SECRET) : []
  const tokens = [...baseToken, ...additionalTokens]

  if (tokens.length < chunks.length) {
    throw new HTTPException(429, { message: 'Not enough GitHub tokens are available for the estimated request count' })
  }

  const requests =
    chunks.length === 0
      ? []
      : await Promise.all(
          chunks.map((userChunk, index) =>
            Promise.all(userChunk.map((user) => fetchUser(env.db, tokens[index], user))),
          ),
        ).then((results) => results.flat())

  const users = [...precomputed.values(), ...requests]

  if (users.length > 0) {
    await createRepositoryRelation(db, name, ...users.map((user) => user.username))
  }

  const repositoryStats = scoreRepository(users)
  return saveRepositoryScore(db, name, repositoryStats)
}
