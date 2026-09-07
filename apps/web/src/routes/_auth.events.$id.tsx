import { createFileRoute } from '@tanstack/react-router'
import { EventForm } from '@/components/event-form'
import { OwnerOnly } from '@/components/owner-only'
import { toDateKey } from '@/lib/format'

const EditEvent = () => {
  const { id } = Route.useParams()
  return <EventForm eventId={id} defaultDate={toDateKey(new Date())} />
}

const GuardedEditEvent = () => (
  <OwnerOnly>
    <EditEvent />
  </OwnerOnly>
)

export const Route = createFileRoute('/_auth/events/$id')({ component: GuardedEditEvent })
