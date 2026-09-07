import { ok } from 'neverthrow'
import { factory } from '#factory'
import { requireAuth } from '#require-auth'

/**
 * The signed-in user and what they're allowed to see.
 *
 * The web app reads `viewer` to decide which nav and which edit affordances to
 * render. That is presentation only — every route enforces the same thing
 * server-side, and hiding a button has never stopped anyone.
 */
export const meRoutes = factory
  .createApp()
  .get('/', requireAuth, (c) => c.var.appResponse(ok({ user: c.var.user, viewer: c.var.viewer })))
