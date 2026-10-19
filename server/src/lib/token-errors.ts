import { RequestError } from '@octokit/request-error'
import type { Drizzle } from '../db'
import { quarantineToken, releaseReservedTokens, type ReservedGitHubToken } from './database'

export const isGitHubTokenUnauthorized = (error: unknown) =>
  error instanceof RequestError && error.status === 401

export const shouldRetainTokenCooldown = (error: unknown) =>
  error instanceof RequestError && (error.status === 403 || error.status === 429)

export const isTokenRelatedGitHubError = (error: unknown) =>
  isGitHubTokenUnauthorized(error) || shouldRetainTokenCooldown(error)

export async function finalizeReservedTokensOnError(
  db: Drizzle,
  reserved: ReservedGitHubToken[],
  error: unknown,
) {
  if (isGitHubTokenUnauthorized(error)) {
    for (const token of reserved) {
      await quarantineToken(db, token.stored)
    }
    return
  }

  if (shouldRetainTokenCooldown(error)) {
    return
  }

  await releaseReservedTokens(db, reserved)
}
