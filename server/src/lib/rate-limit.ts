import type { Context } from 'hono'
import type { AppBindings } from '../env'

const CHECKS_PER_MINUTE = 10

export async function enforceCheckRateLimit(
  c: Context<{ Bindings: AppBindings }>,
  login: string,
): Promise<Response | null> {
  const windowKey = `rate:check:${login}:${Math.floor(Date.now() / 60_000)}`
  const count = Number(await c.env.sessions.get(windowKey) ?? '0')

  if (count >= CHECKS_PER_MINUTE) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  await c.env.sessions.put(windowKey, String(count + 1), { expirationTtl: 120 })
  return null
}
