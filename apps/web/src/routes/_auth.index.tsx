import { createFileRoute, redirect } from '@tanstack/react-router'

import { toDateKey } from '@/lib/format'

export const Route = createFileRoute('/_auth/')({
  beforeLoad: () => {
    throw redirect({ to: '/day/$date', params: { date: toDateKey(new Date()) } })
  }
})
