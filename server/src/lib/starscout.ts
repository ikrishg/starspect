import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../env'
import { fetchRepository, fetchStargazers, fetchUser} from './github'
import { selectTokens, fetchExistingUsers, fetchExistingRepository, createRepositoryRelation } from './database'
import chunk from 'lodash.chunk'

export async function score(env: AppBindings, owner: string, repo: string) {
  const name = `${owner}/${repo}`

  const existingRepository = await fetchExistingRepository(env.db, name)

  if (existingRepository) {
    return existingRepository
  }

  const baseToken = await selectTokens(env.db, 1)
  const stargazers = await fetchStargazers(owner, repo, baseToken[0])

  const precomputed = await fetchExistingUsers(env.db, ...stargazers)

  const newUsers = stargazers.filter(stargazer => !precomputed.get(stargazer))

  const chunks = chunk(newUsers, Math.ceil(4096 / 3)) /** 4096 requests per token, divided by 3 requests per user */

  const requiredTokens = chunks.length - 1 // base token

  const tokens = [...baseToken, ...await selectTokens(env.db, requiredTokens)]

  if (tokens.length < requiredTokens) {
    throw new HTTPException(429, { message: 'Not enough GitHub tokens are available for the estimated request count' })
  }

  const cachedUsers = precomputed.values()

  const requests = await Promise.all(chunks.map((chunk, i) => {
    return Promise.all(chunk.map(user => fetchUser(env.db, tokens[i], user)))
  })).then(results => results.flat())

  const users = [...cachedUsers, ...requests]

  // all users are now present in the database, let's create a relation between the users and the repository
  await createRepositoryRelation(env.db, name, ...users.map(user => user.username))

  const repository = await fetchRepository(env.db, name, tokens[0])
}
