import { RequestError } from '@octokit/request-error'
import type { Drizzle } from '../db'
import { quarantineToken, releaseReservedTokens, type ReservedGitHubToken } from './database'
import { isGitHubRateLimitResponse } from './github-errors'

export const isGitHubTokenUnauthorized = (error: unknown) =>
  error instanceof RequestError && error.status === 401

export const shouldRetainTokenCooldown = (error: unknown) => isGitHubRateLimitResponse(error)

export const isTokenRelatedGitHubError = (error: unknown) =>
  isGitHubTokenUnauthorized(error) || shouldRetainTokenCooldown(error)

export async function finalizeReservedTokensOnError(
  db: Drizzle,
  reserved: ReservedGitHubToken[],
  error: unknown,
  unauthorizedToken?: ReservedGitHubToken,
) {
  if (isGitHubTokenUnauthorized(error)) {
    const toQuarantine = unauthorizedToken ? [unauthorizedToken] : reserved
    for (const token of toQuarantine) {
      const quarantined = await quarantineToken(db, token.stored)
      if (quarantined === 0) {
        await releaseReservedTokens(db, [token])
      }
    }

    if (unauthorizedToken) {
      const others = reserved.filter((token) => token.stored !== unauthorizedToken.stored)
      await releaseReservedTokens(db, others)
    }
    return
  }

  if (shouldRetainTokenCooldown(error)) {
    return
  }

  await releaseReservedTokens(db, reserved)
}
