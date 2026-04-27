import { Hono } from 'hono'
import type { AppBindings } from './env'
import { auth } from './routes/auth'
import { isLoggedIn } from './auth/util'
import { score as score } from './lib/starscout'
import { HTTPException } from 'hono/http-exception'

const app = new Hono<{ Bindings: AppBindings }>()

app.get('/', (c) => c.text('Hello Hono!'))

app.route('/auth', auth)

app.get('/check/:owner/:repo', async (c) => {
  if (!isLoggedIn(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const owner = c.req.param('owner').trim()
  const repo = c.req.param('repo').trim()

  if (!owner || !repo) {
    return c.json({ error: 'Owner and repo are required' }, 400)
  }
})

export default app
