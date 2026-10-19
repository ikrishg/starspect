import { HTTPException } from 'hono/http-exception'
import { eq, sql } from 'drizzle-orm'
import type { Drizzle } from '../db'
import * as schema from '../db/schema'
import { decryptGitHubToken } from './tokens'
import {
  quarantineToken,
  releaseReservedTokens,
  type ReservedGitHubToken,
} from './database'

const TOKEN_COOLDOWN_SECONDS = 60 * 60
const nowSeconds = () => Math.floor(Date.now() / 1000)

export async function reserveUserGitHubToken(
  db: Drizzle,
  userId: string,
  sessionSecret: string,
): Promise<ReservedGitHubToken> {
  const now = nowSeconds()
  const cutoff = now - TOKEN_COOLDOWN_SECONDS

  const rows = await db.all<{ github_token: string; user_id: string }>(sql`
    UPDATE tokens
    SET last_token_use_at = ${now}
    WHERE user_id = ${userId}
      AND (token_unusable IS NULL OR token_unusable = 0)
      AND last_token_use_at < ${cutoff}
    RETURNING github_token, user_id
  `)

  if (rows.length === 0) {
    const [existing] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.userId, userId))
      .execute()

    if (!existing) {
      throw new HTTPException(401, {
        message: 'No GitHub token for this account; sign in with GitHub first',
      })
    }

    if (existing.tokenUnusable) {
      throw new HTTPException(401, {
        message: 'GitHub token revoked or invalid; sign in with GitHub again',
      })
    }

    throw new HTTPException(429, {
      message: 'Your GitHub token is in a short cooldown after a recent API use; try again later',
    })
  }

  const row = rows[0]
  try {
    const plaintext = await decryptGitHubToken(row.github_token, sessionSecret, userId)
    return { plaintext, stored: row.github_token, userId: row.user_id }
  } catch {
    await quarantineToken(db, row.github_token)
    throw new HTTPException(401, {
      message: 'GitHub token could not be decrypted; sign in with GitHub again',
    })
  }
}

export async function releaseUserGitHubToken(db: Drizzle, reserved: ReservedGitHubToken) {
  await releaseReservedTokens(db, [reserved])
}
