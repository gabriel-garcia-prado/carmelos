import { useQuery } from '@tanstack/react-query'

import { useApiClient } from '@/components/api-client-provider'

export type Role = 'owner' | 'pizzaiolo' | 'crew'

export type Viewer = Readonly<{ role: Role; personId: string | null }>

/**
 * What the signed-in user is allowed to be shown.
 *
 * Presentation only. It decides which nav entries and which edit buttons to
 * render; every route enforces the same rules server-side, so a stale answer
 * here costs a hidden button and never leaks a booking. Treat it that way —
 * don't be tempted to make it the gate.
 *
 * Signed out, `/api/me` answers 401 and this settles on no viewer rather than
 * an error: the nav renders on the login screen too.
 */
export const useViewer = () => {
  const client = useApiClient()

  const query = useQuery({
    queryKey: ['me'],
    retry: false,
    queryFn: async (): Promise<Viewer | null> => {
      const response = await client.api.me.$get()
      if (!response.ok) {
        return null
      }
      const body = await response.json()
      return body.viewer as Viewer
    }
  })

  const viewer = query.data ?? null
  return {
    viewer,
    role: viewer?.role ?? null,
    isOwner: viewer?.role === 'owner',
    // Distinct from "not the owner": until this resolves we know nothing, and
    // flashing operator-only controls before hiding them looks like a bug.
    isPending: query.isPending
  }
}
