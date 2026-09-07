import { describe, expect, test } from 'bun:test'
import type { InferResponseType } from 'hono/client'
import { hc } from 'hono/client'

// Type-only import: erased at runtime, so it can't trigger the eager env
// validation before the defaults below are set.
import type { AppType } from './index'

// Provide defaults so the app module (which validates env eagerly) can load
// without a .env file (e.g. in CI). No test below talks to a real database.
process.env.DATABASE_CONNECTION_STRING ??= 'postgres://postgres:postgres@localhost:5432/postgres'
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret'
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000'

const { app } = await import('./index')

describe('app (integration)', () => {
  test('GET /health returns 200', async () => {
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  test('GET /api/me without a session returns 401', async () => {
    const response = await app.request('/api/me')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'Unauthorized' })
  })

  // Guards the wiring, not the rules: the rules themselves are unit-tested in
  // events.test.ts. What this catches is a route registered without a guard at
  // all, which is the mistake that actually happens — one new `.get(...)` that
  // forgets the middleware and quietly serves the whole book.
  test.each([
    ['/api/events/day/2026-09-05'],
    ['/api/events/week/2026-09-05'],
    ['/api/people'],
    ['/api/trucks'],
    ['/api/settings'],
    ['/api/confirmations/day/2026-09-05']
  ])('GET %s without a session returns 401', async (path) => {
    const response = await app.request(path)

    expect(response.status).toBe(401)
  })
})

// --- compile-time guardrails for the typed RPC client ---------------------
// These lines fail `bun typecheck` if Hono's schema inference ever collapses
// again (e.g. a validator wrapped in createMiddleware, or a dependency bump
// changing inference), which the runtime tests above cannot catch.
const client = hc<AppType>('http://localhost')

type Assert<T extends true> = T
// `any extends X` is always true, so guard against inference degrading to any.
type IsNotAny<T> = 0 extends 1 & T ? false : true
type MeOutput = InferResponseType<typeof client.api.me.$get, 200>

type _MeOutputIsTyped = Assert<MeOutput extends { user: { email: string } } ? IsNotAny<MeOutput> : false>
