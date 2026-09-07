// Validate environment variables once, eagerly, before anything else loads.
import '#environment'

import { serveStatic } from 'hono/bun'
import { secureHeaders } from 'hono/secure-headers'

import { factory } from '#factory'
import { appResponseMiddleware } from './middleware/app-response'
import { loggerMiddleware } from './middleware/logger'
import { authRoutes } from './modules/auth/auth.handler'
import { confirmationsRoutes } from './modules/confirmations/confirmations.handler'
import { driveTimeRoutes } from './modules/drive-time/drive-time.handler'
import { eventsRoutes } from './modules/events/events.handler'
import { meRoutes } from './modules/me/me.handler'
import { peopleRoutes } from './modules/people/people.handler'
import { settingsRoutes } from './modules/settings/settings.handler'
import { truckRoutes } from './modules/trucks/trucks.handler'
import { weatherRoutes } from './modules/weather/weather.handler'

const app = factory
  .createApp()
  .use(secureHeaders())
  .use(loggerMiddleware)
  .use(appResponseMiddleware)
  .get('/health', (c) => c.json({ status: 'ok' }, 200))
  .route('/api/auth', authRoutes)
  .route('/api/me', meRoutes)
  .route('/api/settings', settingsRoutes)
  .route('/api/people', peopleRoutes)
  .route('/api/trucks', truckRoutes)
  .route('/api/events', eventsRoutes)
  .route('/api/confirmations', confirmationsRoutes)
  .route('/api/drive-time', driveTimeRoutes)
  .route('/api/weather', weatherRoutes)

// Capture the RPC type *before* the catch-all static handlers below. A
// `.use('*', ...)` entry collapses Hono's route inference, which would strip
// every API route from the typed client (hc<AppType>).
export type AppType = typeof app

// Serve built web assets; falls through to the next handler if the file isn't found.
app.use('*', serveStatic({ root: './public' }))
// SPA fallback: serve index.html for any unmatched route (client-side routing).
app.use('*', serveStatic({ path: './public/index.html' }))

// Named export of the raw Hono instance for tests (`app.request(...)`) — the
// default export below is a plain object, not a Hono app, so it can't offer that.
export { app }

// Explicit port: Bun.serve otherwise defaults to `process.env.PORT`, which the
// dev tooling sets for the Vite process — without this the API would silently
// try to bind Vite's own port instead of its own.
export default {
  fetch: app.fetch,
  port: 3000
}
