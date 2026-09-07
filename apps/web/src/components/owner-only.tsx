import type { ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { useViewer } from '@/lib/use-viewer'

/**
 * Wraps a page that belongs to the operator.
 *
 * Hiding the nav entry isn't enough — the URL is still typeable, and what a
 * crew member would otherwise get is a page of failed requests rather than an
 * answer. This says so plainly instead. The data is protected by the API,
 * which refuses these routes outright; this is about not lying to the person
 * looking at the screen.
 */
export const OwnerOnly = ({ children }: Readonly<{ children: ReactNode }>) => {
  const { isOwner, isPending } = useViewer()

  if (isPending) {
    return (
      <div className="p-5" role="status" aria-busy="true" aria-label="Checking access">
        <Skeleton className="h-40 w-full max-w-md rounded-xl" />
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="p-5">
        <p className="text-sm text-muted-foreground">
          This page is for whoever runs the book. Your day is on{' '}
          <span className="font-medium text-foreground">Today</span>.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
