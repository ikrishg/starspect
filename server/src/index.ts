import { Hono } from 'hono'
import type { AppBindings } from './env'
import { auth } from './routes/auth'
import { score as scoreRepository } from './lib/starscout'
import { getSession } from './lib/auth'
import { enforceCheckRateLimit } from './lib/rate-limit'

const MAX_REQUEST_BYTES = 4_096
const MAX_OWNER_REPO_LENGTH = 200
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/

const app = new Hono<{ Bindings: AppBindings }>()

app.use('*', async (c, next) => {
  const contentLength = c.req.header('content-length')
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    return c.json({ error: 'Request body too large' }, 413)
  }

  await next()
})

app.get('/', (c) => c.text('Hello Hono!'))

app.route('/auth', auth)

app.post('/check', async (c) => {
  const session = await getSession(c)
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const rateLimited = await enforceCheckRateLimit(c, session.login)
  if (rateLimited) {
    return rateLimited
  }

  let body: { owner?: string; repo?: string }
  try {
    body = await c.req.json<{ owner?: string; repo?: string }>()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const owner = body.owner?.trim() ?? ''
  const repo = body.repo?.trim() ?? ''

  if (!owner || !repo) {
    return c.json({ error: 'Owner and repo are required' }, 400)
  }

  if (owner.length > MAX_OWNER_REPO_LENGTH || repo.length > MAX_OWNER_REPO_LENGTH) {
    return c.json({ error: 'Owner and repo are too long' }, 400)
  }

  if (!GITHUB_NAME_PATTERN.test(owner) || !GITHUB_NAME_PATTERN.test(repo)) {
    return c.json({ error: 'Owner and repo contain invalid characters' }, 400)
  }

  const scored = await scoreRepository(c.env, owner, repo)

  return c.json({
    score: scored.score ?? 0,
    n_stars: scored.n_stars ?? 0,
    n_fake_stars: scored.n_fake_stars ?? 0,
    checkedAt: scored.checkedAt,
  })
})

export default app
