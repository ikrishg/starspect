import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppBindings } from './env'
import { auth } from './routes/auth'
import { score as scoreRepository } from './lib/starscout'
import { getSession } from './lib/auth'
import { enforceCheckRateLimit } from './lib/rate-limit'
import { normalizeGithubRepository } from './lib/github-names'

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

    const rateLimited = await enforceCheckRateLimit(c, session.login)
    if (rateLimited) {
      return rateLimited
    }

    const contentType = c.req.header('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }

    let body: { owner?: string; repo?: string }
    try {
      body = await c.req.json<{ owner?: string; repo?: string }>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const normalized = normalizeGithubRepository(body.owner ?? '', body.repo ?? '')
    if ('error' in normalized) {
      return c.json({ error: normalized.error }, 400)
    }

    const scored = await scoreRepository(c.env, normalized.owner, normalized.repo)

    return c.json({
      score: scored.score ?? 0,
      n_stars: scored.n_stars ?? 0,
      n_fake_stars: scored.n_fake_stars ?? 0,
      checkedAt: scored.checkedAt,
    })
  },
)

export default app
