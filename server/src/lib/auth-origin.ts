import type { Context } from 'hono'
import type { AppBindings } from '../env'

export const isSameOriginStarRequest = (c: Context<{ Bindings: AppBindings }>) => {
  const expectedOrigin = new URL(c.req.url).origin
  const origin = c.req.header('Origin')

  if (origin === expectedOrigin) {
    return true
  }

  if (origin === undefined || origin === 'null') {
    return c.req.header('Sec-Fetch-Site') === 'same-origin'
  }

  return false
}
