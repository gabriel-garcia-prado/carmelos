import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { EventForm } from '@/components/event-form'
import { toDateKey } from '@/lib/format'
import { RIGS } from '@/lib/rigs'

const searchSchema = z.object({
  date: z.string().optional(),
  rig: z.enum(RIGS).optional()
})

const NewEvent = () => {
  const { date, rig } = Route.useSearch()
  return <EventForm defaultDate={date ?? toDateKey(new Date())} defaultRig={rig} />
}

export const Route = createFileRoute('/_auth/events/new')({
  validateSearch: searchSchema,
  component: NewEvent
})
