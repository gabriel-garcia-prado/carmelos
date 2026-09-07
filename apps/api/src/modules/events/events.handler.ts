import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import {
  eventConfirmations as confirmationsTable,
  database,
  events as eventsTable,
  people as peopleTable,
  eventSpecialRequests as requestsTable,
  settings as settingsTable
} from '#database'
import type { DependencyError } from '#errors'
import { factory } from '#factory'
import { requireAuth, requireOwner } from '#require-auth'
import { validator } from '#validator'
import { addDays, parseDateKey } from '../../lib/time'
import type { Person } from '../people/people'
import type { Settings } from '../settings/settings'
import type {
  DeleteDependencies,
  DesiredConfirmation,
  EventRecord,
  GetDayViewDependencies,
  GetWeekViewDependencies,
  NewEventInput,
  Rig,
  UpdateDependencies,
  WriteDependencies
} from './events'
import {
  createEvent,
  deleteEvent,
  getDayView,
  getEvent,
  getWeekView,
  previewTurnaround,
  RIGS,
  updateEvent,
  updateRigCrew
} from './events'

const SETTINGS_ID = 'global'
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

const specialRequestSchema = z.object({
  requestType: z.enum(['gluten_free', 'halal', 'no_pork', 'vegetarian', 'vegan', 'dairy_free', 'paneer', 'spicy']),
  headcount: z.number().int().positive()
})

const newEventSchema = z.object({
  rig: z.enum(RIGS as [Rig, ...Rig[]]),
  firstPizzaTime: z.coerce.date(),
  headcount: z.number().int().positive(),
  address: z.string().min(1),
  clientName: z.string().trim().min(1).nullable(),
  driveMinutes: z.number().int().nonnegative(),
  driveMinutesBackToShop: z.number().int().nonnegative().nullable(),
  serviceDurationMinutes: z.number().int().positive(),
  setupMinutesOverride: z.number().int().positive().nullable().default(null),
  rackCount: z.number().int().nonnegative(),
  // Rig-owned, so optional here: omitted on create (inherited from the rig)
  // and only ever set through the rig's own "Edit crew".
  pizzaioloId: z.uuid().optional(),
  crewMemberId: z.uuid().optional(),
  fireDutyOverridePersonId: z.uuid().nullable().default(null),
  crewArrivalOverrideMinutes: z.number().int().nonnegative().nullable().default(null),
  truckId: z.string().min(1).nullable().default(null),
  specialRequests: z.array(specialRequestSchema)
})

const updateEventSchema = newEventSchema.partial()

const previewEventSchema = z.object({
  id: z.uuid().optional(),
  rig: z.enum(RIGS as [Rig, ...Rig[]]),
  firstPizzaTime: z.coerce.date(),
  driveMinutes: z.number().int().nonnegative(),
  driveMinutesBackToShop: z.number().int().nonnegative().nullable(),
  serviceDurationMinutes: z.number().int().positive(),
  setupMinutesOverride: z.number().int().positive().nullable().default(null),
  rackCount: z.number().int().nonnegative()
})

const rigCrewSchema = z.object({
  date: z.string().regex(DATE_KEY),
  rig: z.enum(RIGS as [Rig, ...Rig[]]),
  pizzaioloId: z.uuid(),
  crewMemberId: z.uuid(),
  fireDutyOverridePersonId: z.uuid().nullable(),
  crewArrivalOverrideMinutes: z.number().int().nonnegative().nullable(),
  truckId: z.string().min(1).nullable()
})

const paramSchema = z.object({ id: z.uuid() })
const dateParamSchema = z.object({ date: z.string().regex(DATE_KEY) })
const weekParamSchema = z.object({ startDate: z.string().regex(DATE_KEY) })

const dependencyError = (error: unknown, input: unknown): DependencyError => ({
  type: 'DependencyError' as const,
  message: `${error}`,
  dependency: 'db',
  input
})

const toEventRecord = (
  row: typeof eventsTable.$inferSelect,
  requests: readonly (typeof requestsTable.$inferSelect)[]
): EventRecord => ({
  id: row.id,
  rig: row.rig,
  firstPizzaTime: row.firstPizzaTime,
  headcount: row.headcount,
  address: row.address,
  clientName: row.clientName,
  driveMinutes: row.driveMinutes,
  driveMinutesBackToShop: row.driveMinutesBackToShop,
  serviceDurationMinutes: row.serviceDurationMinutes,
  setupMinutesOverride: row.setupMinutesOverride,
  rackCount: row.rackCount,
  pizzaioloId: row.pizzaioloId,
  crewMemberId: row.crewMemberId,
  fireDutyOverridePersonId: row.fireDutyOverridePersonId,
  crewArrivalOverrideMinutes: row.crewArrivalOverrideMinutes,
  truckId: row.truckId,
  specialRequests: requests
    .filter((request) => request.eventId === row.id)
    .map((request) => ({ requestType: request.requestType, headcount: request.headcount }))
})

const dateRange = (date: string) => ({ start: parseDateKey(date), endExclusive: parseDateKey(addDays(date, 1)) })

const fetchEventsForDate = (date: string): ResultAsync<readonly EventRecord[], DependencyError> => {
  const { start, endExclusive } = dateRange(date)
  return ResultAsync.fromPromise(
    database
      .select()
      .from(eventsTable)
      .where(and(gte(eventsTable.firstPizzaTime, start), lt(eventsTable.firstPizzaTime, endExclusive))),
    (error) => dependencyError(error, date)
  ).andThen((rows) => {
    if (rows.length === 0) return okAsync([])
    return ResultAsync.fromPromise(
      database
        .select()
        .from(requestsTable)
        .where(
          inArray(
            requestsTable.eventId,
            rows.map((row) => row.id)
          )
        ),
      (error) => dependencyError(error, date)
    ).map((requests) => rows.map((row) => toEventRecord(row, requests)))
  })
}

const fetchEventById = (id: string): ResultAsync<EventRecord, DependencyError> =>
  ResultAsync.fromPromise(database.select().from(eventsTable).where(eq(eventsTable.id, id)), (error) =>
    dependencyError(error, id)
  ).andThen(([row]) => {
    if (!row) return errAsync(dependencyError('event not found', id))
    return ResultAsync.fromPromise(
      database.select().from(requestsTable).where(eq(requestsTable.eventId, id)),
      (error) => dependencyError(error, id)
    ).map((requests) => toEventRecord(row, requests))
  })

const fetchSettings = (): ResultAsync<Settings, DependencyError> =>
  ResultAsync.fromPromise(database.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ID)), (error) =>
    dependencyError(error, undefined)
  ).andThen(([row]) =>
    row ? okAsync(row as Settings) : errAsync(dependencyError('settings row is missing', undefined))
  )

const fetchPeople = (): ResultAsync<readonly Person[], DependencyError> =>
  ResultAsync.fromPromise(database.select().from(peopleTable), (error) => dependencyError(error, undefined))

const persistEvent = (event: EventRecord): ResultAsync<EventRecord, DependencyError> =>
  ResultAsync.fromPromise(
    (async () => {
      const { specialRequests, ...row } = event
      await database.insert(eventsTable).values(row).onConflictDoUpdate({ target: eventsTable.id, set: row })
      await database.delete(requestsTable).where(eq(requestsTable.eventId, event.id))
      if (specialRequests.length > 0) {
        await database
          .insert(requestsTable)
          .values(specialRequests.map((request) => ({ ...request, eventId: event.id })))
      }
      return event
    })(),
    (error) => dependencyError(error, event)
  )

const removeEvent = (id: string): ResultAsync<void, DependencyError> =>
  ResultAsync.fromPromise(database.delete(eventsTable).where(eq(eventsTable.id, id)), (error) =>
    dependencyError(error, id)
  ).map(() => undefined)

const applyConfirmations = (
  date: string,
  desired: readonly DesiredConfirmation[]
): ResultAsync<void, DependencyError> =>
  ResultAsync.fromPromise(
    (async () => {
      const { start, endExclusive } = dateRange(date)
      const dateEvents = await database
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(and(gte(eventsTable.firstPizzaTime, start), lt(eventsTable.firstPizzaTime, endExclusive)))
      const eventIds = dateEvents.map((row) => row.id)
      const existing =
        eventIds.length > 0
          ? await database.select().from(confirmationsTable).where(inArray(confirmationsTable.eventId, eventIds))
          : []

      const keyOf = (entry: { eventId: string; personId: string; role: string }) =>
        `${entry.eventId}:${entry.personId}:${entry.role}`
      const existingByKey = new Map(existing.map((row) => [keyOf(row), row]))
      const desiredKeys = new Set(desired.map(keyOf))

      const toDelete = existing.filter((row) => !desiredKeys.has(keyOf(row)))
      if (toDelete.length > 0) {
        await database.delete(confirmationsTable).where(
          inArray(
            confirmationsTable.id,
            toDelete.map((row) => row.id)
          )
        )
      }

      for (const entry of desired) {
        const existingRow = existingByKey.get(keyOf(entry))
        if (existingRow && existingRow.messageBody === entry.messageBody) continue
        if (existingRow) {
          await database
            .update(confirmationsTable)
            .set({ messageBody: entry.messageBody, status: 'pending', sentAt: null, confirmedAt: null })
            .where(eq(confirmationsTable.id, existingRow.id))
        } else {
          await database.insert(confirmationsTable).values(entry)
        }
      }
    })(),
    (error) => dependencyError(error, { date })
  ).map(() => undefined)

const readDependencies: GetDayViewDependencies & GetWeekViewDependencies = {
  fetchEventsForDate,
  fetchSettings,
  fetchPeople,
  fetchEventsForRange: (startDate, endDateExclusive) =>
    ResultAsync.fromPromise(
      database
        .select()
        .from(eventsTable)
        .where(
          and(
            gte(eventsTable.firstPizzaTime, parseDateKey(startDate)),
            lt(eventsTable.firstPizzaTime, parseDateKey(endDateExclusive))
          )
        ),
      (error) => dependencyError(error, { startDate, endDateExclusive })
    ).andThen((rows) => {
      if (rows.length === 0) return okAsync([])
      return ResultAsync.fromPromise(
        database
          .select()
          .from(requestsTable)
          .where(
            inArray(
              requestsTable.eventId,
              rows.map((row) => row.id)
            )
          ),
        (error) => dependencyError(error, { startDate, endDateExclusive })
      ).map((requests) => rows.map((row) => toEventRecord(row, requests)))
    })
}

const writeDependencies: WriteDependencies = {
  generateId: () => crypto.randomUUID(),
  fetchEventsForDate,
  fetchSettings,
  fetchPeople,
  persistEvent,
  applyConfirmations
}

const updateDependencies: UpdateDependencies = { ...writeDependencies, fetchEventById }
const deleteDependencies: DeleteDependencies = {
  fetchEventById,
  fetchEventsForDate,
  fetchSettings,
  fetchPeople,
  removeEvent,
  applyConfirmations
}

export const eventsRoutes = factory
  .createApp()
  // The two read routes are the only ones the crew reach, and both come back
  // scoped to the viewer. Everything below them is the operator's: reading a
  // single event is the edit form's fetch, and the rest are writes.
  .get('/day/:date', requireAuth, validator('param', dateParamSchema), async (c) =>
    c.var.appResponse(await getDayView(readDependencies)(c.req.valid('param').date, c.var.viewer))
  )
  .get('/week/:startDate', requireAuth, validator('param', weekParamSchema), async (c) =>
    c.var.appResponse(await getWeekView(readDependencies)(c.req.valid('param').startDate, c.var.viewer))
  )
  .get('/:id', requireOwner, validator('param', paramSchema), async (c) =>
    c.var.appResponse(await getEvent({ fetchEventById })(c.req.valid('param').id))
  )
  .post('/preview', requireOwner, validator('json', previewEventSchema), async (c) =>
    c.var.appResponse(await previewTurnaround(readDependencies)(c.req.valid('json')))
  )
  .patch('/rig-crew', requireOwner, validator('json', rigCrewSchema), async (c) =>
    c.var.appResponse(await updateRigCrew(writeDependencies)(c.req.valid('json')))
  )
  .post('/', requireOwner, validator('json', newEventSchema), async (c) =>
    c.var.appResponse(await createEvent(writeDependencies)(c.req.valid('json') as NewEventInput))
  )
  .patch('/:id', requireOwner, validator('param', paramSchema), validator('json', updateEventSchema), async (c) =>
    c.var.appResponse(await updateEvent(updateDependencies)({ id: c.req.valid('param').id, ...c.req.valid('json') }))
  )
  .delete('/:id', requireOwner, validator('param', paramSchema), async (c) =>
    c.var.appResponse(await deleteEvent(deleteDependencies)(c.req.valid('param').id))
  )
