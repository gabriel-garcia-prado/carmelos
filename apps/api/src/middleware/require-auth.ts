import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CustomEnvironment } from '#factory'
import type { Viewer } from '../lib/viewer'
import { roleFrom } from '../lib/viewer'
import type { Session } from '../modules/auth/auth'
import { auth } from '../modules/auth/auth'

type AuthEnvironment = {
  Variables: CustomEnvironment['Variables'] & {
    user: Session['user']
    session: Session['session']
    viewer: Viewer
  }
}

/**
 * Resolves the session and the viewer it implies, or null when unauthenticated.
 *
 * The role and person live in columns Better Auth carries as additional fields,
 * so they arrive loosely typed; both are read defensively and fall back to the
 * least-privileged reading.
 */
const authenticate = async (c: Context) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) {
    return null
  }

  const account = session.user as { role?: unknown; personId?: unknown }
  const viewer: Viewer = {
    role: roleFrom(account.role),
    personId: typeof account.personId === 'string' ? account.personId : null
  }
  return { session, viewer }
}

/**
 * Rejects the request with a 401 unless it carries a valid session cookie.
 * Downstream handlers can read the authenticated user via `c.var.user` and
 * what they're allowed to see via `c.var.viewer`.
 */
export const requireAuth = createMiddleware<AuthEnvironment>(async (c, next) => {
  const authenticated = await authenticate(c)
  if (!authenticated) {
    return c.json({ message: 'Unauthorized' }, 401)
  }

  c.set('user', authenticated.session.user)
  c.set('session', authenticated.session.session)
  c.set('viewer', authenticated.viewer)
  await next()
})

/**
 * Everything only the operator may reach: the book as a whole, the people
 * directory, pay rates, the ops constants, and every write.
 *
 * Self-contained rather than layered on `requireAuth`, so a route can't be
 * left half-guarded by listing them in the wrong order.
 */
export const requireOwner = createMiddleware<AuthEnvironment>(async (c, next) => {
  const authenticated = await authenticate(c)
  if (!authenticated) {
    return c.json({ message: 'Unauthorized' }, 401)
  }
  if (authenticated.viewer.role !== 'owner') {
    return c.json({ message: 'Forbidden' }, 403)
  }

  c.set('user', authenticated.session.user)
  c.set('session', authenticated.session.session)
  c.set('viewer', authenticated.viewer)
  await next()
})
