import { Hono } from 'hono'
import type { AppBindings } from './env'
import { auth } from './routes/auth'
import { isLoggedIn } from './auth/util'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './db/schema'

const app = new Hono<{ Bindings: AppBindings }>()

app.get('/', (c) => c.text('Hello Hono!'))

app.route('/auth', auth)

app.get('/check/:owner/:repo', (c) => {
  if (!isLoggedIn(c)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const { owner, repo } = c.req.param()

  const db = drizzle(c.env.db, { schema })



  return c.json({ message: 'Hello World' })
})

export default app
