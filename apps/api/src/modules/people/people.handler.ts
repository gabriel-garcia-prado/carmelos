import { asc, desc, eq } from 'drizzle-orm'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { eventAssignments as assignmentsTable, database, people as peopleTable } from '#database'
import type { DependencyError } from '#errors'
import { factory } from '#factory'
import { requireAuth, requireOwner } from '#require-auth'
import { validator } from '#validator'
import type { NewPerson, Person, PersonUpdate } from './people'
import { createPerson, deletePerson, listPeople, redactPeople, updatePerson } from './people'

const newPersonSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  isPizzaiolo: z.boolean(),
  canDrive: z.boolean(),
  canDriveTrailer: z.boolean(),
  rackRateOverridePer30Min: z.number().int().positive().nullable(),
  minutesBeforeDepartureOverride: z.number().int().nonnegative().nullable(),
  homeBaseAddress: z.string().nullable()
})

const updatePersonSchema = newPersonSchema.partial()
const paramSchema = z.object({ id: z.uuid() })

const dependencyError = (error: unknown, input: unknown): DependencyError => ({
  type: 'DependencyError' as const,
  message: `${error}`,
  dependency: 'db',
  input
})

const dependencies = {
  generateId: () => crypto.randomUUID(),
  // Pizzaioli first, then everyone else, each alphabetical — every picker in
  // the app reads this order, and the pizzaiolo is the one being chosen most.
  fetchPeople: (): ResultAsync<readonly Person[], DependencyError> =>
    ResultAsync.fromPromise(
      database.select().from(peopleTable).orderBy(desc(peopleTable.isPizzaiolo), asc(peopleTable.name)),
      (error) => dependencyError(error, undefined)
    ),
  insertPerson: (person: Person): ResultAsync<Person, DependencyError> =>
    ResultAsync.fromPromise(database.insert(peopleTable).values(person).returning(), (error) =>
      dependencyError(error, person)
    ).map(([row]) => row as Person),
  savePerson: ({ id, ...update }: PersonUpdate): ResultAsync<Person, DependencyError> =>
    ResultAsync.fromPromise(
      database.update(peopleTable).set(update).where(eq(peopleTable.id, id)).returning(),
      (error) => dependencyError(error, { id, ...update })
    ).andThen(([row]) => (row ? okAsync(row as Person) : errAsync(dependencyError('person not found', id)))),
  countEventsUsing: (id: string): ResultAsync<number, DependencyError> =>
    ResultAsync.fromPromise(
      database.select({ id: assignmentsTable.id }).from(assignmentsTable).where(eq(assignmentsTable.personId, id)),
      (error) => dependencyError(error, id)
    ).map((rows) => rows.length),
  removePerson: (id: string): ResultAsync<void, DependencyError> =>
    ResultAsync.fromPromise(database.delete(peopleTable).where(eq(peopleTable.id, id)), (error) =>
      dependencyError(error, id)
    ).map(() => undefined)
}

export const peopleRoutes = factory
  .createApp()
  // Everyone needs the roster to put names to the ids on their own shift, so
  // the list stays open — but a non-owner gets it redacted down to that.
  .get('/', requireAuth, async (c) =>
    c.var.appResponse((await listPeople(dependencies)()).map((people) => redactPeople(people, c.var.viewer)))
  )
  .post('/', requireOwner, validator('json', newPersonSchema), async (c) =>
    c.var.appResponse(await createPerson(dependencies)(c.req.valid('json') as NewPerson))
  )
  .patch('/:id', requireOwner, validator('param', paramSchema), validator('json', updatePersonSchema), async (c) =>
    c.var.appResponse(await updatePerson(dependencies)({ id: c.req.valid('param').id, ...c.req.valid('json') }))
  )
  .delete('/:id', requireOwner, validator('param', paramSchema), async (c) =>
    c.var.appResponse(await deletePerson(dependencies)(c.req.valid('param').id))
  )
