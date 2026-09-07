import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import { environment } from '#environment'

export const getAuth = (database: Parameters<typeof drizzleAdapter>['0']) =>
  betterAuth({
    database: drizzleAdapter(database, {
      provider: 'pg'
    }),
    secret: environment.BETTER_AUTH_SECRET,
    baseURL: environment.BETTER_AUTH_URL,
    trustedOrigins: environment.TRUSTED_ORIGINS,
    emailAndPassword: {
      enabled: true
    },
    user: {
      additionalFields: {
        // 'owner' is Billy: the whole app. 'pizzaiolo' and 'crew' are logins
        // for the crew pool, and see only their own work (see src/lib/viewer.ts).
        role: {
          type: 'string',
          required: false,
          defaultValue: 'crew',
          // Never settable through the sign-up or update-user endpoints —
          // a self-assigned role is not a role. Seeds and admins write it
          // straight to the row.
          input: false
        },
        // The people-pool row this login belongs to. Null for the owner, who
        // isn't in the pool; without one, a crew login has no "own" events.
        personId: {
          type: 'string',
          required: false,
          input: false
        }
      }
    }
  })
