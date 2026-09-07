import { and, asc, eq, isNull, or } from 'drizzle-orm'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { database, events as eventsTable, trucks as trucksTable } from '#database'
import type { DependencyError } from '#errors'
import { factory } from '#factory'
import { requireAuth } from '#require-auth'
import { validator } from '#validator'
import type { Rig } from '../events/events'
import { RIGS } from '../events/events'
import type { NewTruck, Truck, TruckUpdate } from './trucks'
import { createTruck, deleteTruck, listTrucks, updateTruck } from './trucks'

const truckSchema = z.object({
  name: z.string().min(1),
  shortName: z.string().trim().min(1).max(8).nullable(),
  ovenMount: z.enum(['trailer', 'built_in']),
  rangeMiles: z.number().int().positive(),
  comfort: z.number().int().min(1).max(5),
  notes: z.string().nullable()
})

const updateTruckSchema = truckSchema.partial()

const paramSchema = z.object({ id: z.string().min(1) })

const dependencyError = (error: unknown, input: unknown): DependencyError => ({
  type: 'DependencyError' as const,
  message: `${error}`,
  dependency: 'db',
  input
})

const dependencies = {
  fetchTrucks: (): ResultAsync<readonly Truck[], DependencyError> =>
    ResultAsync.fromPromise(database.select().from(trucksTable).orderBy(asc(trucksTable.name)), (error) =>
      dependencyError(error, undefined)
    ).map((rows) => rows as Truck[]),
  generateId: () => crypto.randomUUID(),
  insertTruck: (truck: Truck): ResultAsync<Truck, DependencyError> =>
    ResultAsync.fromPromise(database.insert(trucksTable).values(truck).returning(), (error) =>
      dependencyError(error, truck)
    ).map(([row]) => row as Truck),
  // A day counts as using this truck two ways: it names it outright, OR it
  // names nothing and this is its rig's namesake truck. Missing the second
  // case let a truck every booked day actually relies on delete cleanly,
  // because the default relationship is implicit rather than a foreign key.
  countEventsUsing: (id: string): ResultAsync<number, DependencyError> => {
    const isNamesake = (RIGS as readonly string[]).includes(id)
    const usedBy = isNamesake
      ? or(eq(eventsTable.truckId, id), and(isNull(eventsTable.truckId), eq(eventsTable.rig, id as Rig)))
      : eq(eventsTable.truckId, id)
    return ResultAsync.fromPromise(database.select({ id: eventsTable.id }).from(eventsTable).where(usedBy), (error) =>
      dependencyError(error, id)
    ).map((rows) => rows.length)
  },
  removeTruck: (id: string): ResultAsync<void, DependencyError> =>
    ResultAsync.fromPromise(database.delete(trucksTable).where(eq(trucksTable.id, id)), (error) =>
      dependencyError(error, id)
    ).map(() => undefined),
  saveTruck: ({ id, ...update }: TruckUpdate): ResultAsync<Truck, DependencyError> =>
    ResultAsync.fromPromise(
      database.update(trucksTable).set(update).where(eq(trucksTable.id, id)).returning(),
      (error) => dependencyError(error, { id, ...update })
    ).andThen(([row]) => (row ? okAsync(row as Truck) : errAsync(dependencyError('truck not found', id))))
}

export const truckRoutes = factory
  .createApp()
  .get('/', requireAuth, async (c) => c.var.appResponse(await listTrucks(dependencies)()))
  .post('/', requireAuth, validator('json', truckSchema), async (c) =>
    c.var.appResponse(await createTruck(dependencies)(c.req.valid('json') as NewTruck))
  )
  .patch('/:id', requireAuth, validator('param', paramSchema), validator('json', updateTruckSchema), async (c) =>
    c.var.appResponse(await updateTruck(dependencies)({ id: c.req.valid('param').id, ...c.req.valid('json') }))
  )
  .delete('/:id', requireAuth, validator('param', paramSchema), async (c) =>
    c.var.appResponse(await deleteTruck(dependencies)(c.req.valid('param').id))
  )
