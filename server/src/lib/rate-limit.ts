import type { Context } from 'hono'
import type { AppBindings } from '../env'

export async function enforceCheckRateLimit(
  c: Context<{ Bindings: AppBindings }>,
  userId: string,
): Promise<Response | null> {
  const { success } = await c.env.CHECK_RATE_LIMITER.limit({ key: `check:${userId}` })

  if (!success) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  return null
}
