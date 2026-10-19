import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from './env'
import { auth } from './routes/auth'
import { score as scoreRepository } from './lib/starscout'
import { clearSession, getSession } from './lib/auth'
import { enforceCheckRateLimit } from './lib/rate-limit'
import { normalizeGithubRepository } from './lib/github-names'
import { parseCheckBody } from './lib/check-body'

const MAX_REQUEST_BYTES = 4_096

const app = new Hono<{ Bindings: AppBindings }>()

app.get('/', (c) => c.text('Hello Hono!'))

app.route('/auth', auth)

app.post(
  '/check',
  bodyLimit({ maxSize: MAX_REQUEST_BYTES }),
  async (c) => {
    const session = await getSession(c)
    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const rateLimited = await enforceCheckRateLimit(c, session.userId)
    if (rateLimited) {
      return rateLimited
    }

    const contentType = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = parseCheckBody(rawBody)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400)
    }

    const normalized = normalizeGithubRepository(parsed.value.owner, parsed.value.repo)
    if ('error' in normalized) {
      return c.json({ error: normalized.error }, 400)
    }

    let scored
    try {
      scored = await scoreRepository(c.env, normalized.owner, normalized.repo, session.userId)
    } catch (error) {
      if (error instanceof HTTPException) {
        if (error.status === 401) {
          await clearSession(c)
          return c.json(
            {
              error: error.message,
              hint: 'Sign in with GitHub again',
            },
            401,
          )
        }
        if (error.status === 429) {
          return c.json(
            {
              error: error.message,
              hint: 'Try again after the one-hour cooldown',
            },
            429,
          )
        }
      }
      throw error
    }

    return c.json({
      score: scored.score ?? 0,
      n_stars: scored.n_stars ?? 0,
      n_scored_stars: scored.n_scored_stars ?? scored.n_stars ?? 0,
      is_partial: scored.isPartial ?? false,
      n_fake_stars: scored.n_fake_stars ?? 0,
      checkedAt: scored.checkedAt,
    })
  },
)

export default app
