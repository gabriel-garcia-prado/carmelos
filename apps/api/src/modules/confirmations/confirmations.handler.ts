import { and, eq, gte, lt } from 'drizzle-orm'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { eventConfirmations as confirmationsTable, database, events as eventsTable } from '#database'
import type { DependencyError } from '#errors'
import { factory } from '#factory'
import { requireOwner } from '#require-auth'
import { validator } from '#validator'
import { addDays, parseDateKey } from '../../lib/time'
import type { Confirmation, ConfirmationStatus } from './confirmations'
import { listConfirmationsForDate, updateConfirmationStatus } from './confirmations'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const dateParamSchema = z.object({ date: z.string().regex(DATE_KEY) })
const idParamSchema = z.object({ id: z.uuid() })
const statusSchema = z.object({ status: z.enum(['pending', 'sent', 'confirmed', 'declined']) })

const dependencyError = (error: unknown, input: unknown): DependencyError => ({
  type: 'DependencyError' as const,
  message: `${error}`,
  dependency: 'db',
  input
})

const timestampsFor = (status: ConfirmationStatus) => {
  const now = new Date()
  return {
    status,
    sentAt: status === 'sent' || status === 'confirmed' ? now : status === 'pending' ? null : undefined,
    confirmedAt: status === 'confirmed' ? now : status === 'pending' || status === 'declined' ? null : undefined
  }
}

const dependencies = {
  fetchConfirmationsForDate: (date: string): ResultAsync<readonly Confirmation[], DependencyError> => {
    const start = parseDateKey(date)
    const endExclusive = parseDateKey(addDays(date, 1))
    return ResultAsync.fromPromise(
      database
        .select({ confirmation: confirmationsTable })
        .from(confirmationsTable)
        .innerJoin(eventsTable, eq(confirmationsTable.eventId, eventsTable.id))
        .where(and(gte(eventsTable.firstPizzaTime, start), lt(eventsTable.firstPizzaTime, endExclusive))),
      (error) => dependencyError(error, date)
    ).map((rows) => rows.map((row) => row.confirmation as Confirmation))
  },
  saveStatus: (id: string, status: ConfirmationStatus): ResultAsync<Confirmation, DependencyError> =>
    ResultAsync.fromPromise(
      database.update(confirmationsTable).set(timestampsFor(status)).where(eq(confirmationsTable.id, id)).returning(),
      (error) => dependencyError(error, { id, status })
    ).andThen(([row]) => (row ? okAsync(row as Confirmation) : errAsync(dependencyError('confirmation not found', id))))
}

export const confirmationsRoutes = factory
  .createApp()
  .get('/day/:date', requireOwner, validator('param', dateParamSchema), async (c) =>
    c.var.appResponse(await listConfirmationsForDate(dependencies)(c.req.valid('param').date))
  )
  .patch('/:id', requireOwner, validator('param', idParamSchema), validator('json', statusSchema), async (c) =>
    c.var.appResponse(
      await updateConfirmationStatus(dependencies)({ id: c.req.valid('param').id, status: c.req.valid('json').status })
    )
  )
