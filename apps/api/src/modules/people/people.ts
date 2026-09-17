import { errAsync, type ResultAsync } from 'neverthrow'
import type { AppError, DependencyError } from '#errors'
import type { Viewer } from '../../lib/viewer'
import { isOwner } from '../../lib/viewer'

export type Person = Readonly<{
  id: string
  name: string
  phone: string
  isPizzaiolo: boolean
  /** False only for someone who cuts and nothing else — everyone else sticks. */
  canStick: boolean
  canDrive: boolean
  canDriveTrailer: boolean
  rackRateOverridePer30Min: number | null
  minutesBeforeDepartureOverride: number | null
  homeBaseAddress: string | null
}>

/**
 * What a non-owner may see of the crew pool.
 *
 * Names stay: the day view identifies everyone by id, so without them a crew
 * member can't be told who is running their rig. What goes is the reason the
 * directory is sensitive in the first place — everyone's phone number, what
 * they're paid, and where they live. `minutesBeforeDepartureOverride` stays
 * because the client needs it to show the viewer their own arrival time.
 */
export type VisiblePerson = Omit<Person, 'phone'> & Readonly<{ phone: string | null }>

export const redactPeople = (people: readonly Person[], viewer: Viewer): readonly VisiblePerson[] =>
  isOwner(viewer)
    ? people
    : people.map((person) => ({
        ...person,
        phone: null,
        rackRateOverridePer30Min: null,
        homeBaseAddress: null
      }))

export type NewPerson = Readonly<{
  name: string
  phone: string
  isPizzaiolo: boolean
  /** False only for someone who cuts and nothing else — everyone else sticks. */
  canStick: boolean
  canDrive: boolean
  canDriveTrailer: boolean
  rackRateOverridePer30Min: number | null
  minutesBeforeDepartureOverride: number | null
  homeBaseAddress: string | null
}>

export type PersonUpdate = Readonly<{ id: string } & Partial<NewPerson>>

type ListDependencies = {
  fetchPeople: () => ResultAsync<readonly Person[], DependencyError>
}

export const listPeople = (dependencies: ListDependencies) => (): ResultAsync<readonly Person[], DependencyError> =>
  dependencies.fetchPeople()

type CreateDependencies = {
  generateId: () => string
  insertPerson: (person: Person) => ResultAsync<Person, DependencyError>
}

export const createPerson =
  (dependencies: CreateDependencies) =>
  (input: NewPerson): ResultAsync<Person, DependencyError> =>
    dependencies.insertPerson({ id: dependencies.generateId(), ...input })

type UpdateDependencies = {
  savePerson: (update: PersonUpdate) => ResultAsync<Person, DependencyError>
}

export const updatePerson =
  (dependencies: UpdateDependencies) =>
  (input: PersonUpdate): ResultAsync<Person, DependencyError> =>
    dependencies.savePerson(input)

type DeleteDependencies = {
  countEventsUsing: (id: string) => ResultAsync<number, DependencyError>
  removePerson: (id: string) => ResultAsync<void, DependencyError>
}

/** Refuses while they're still crewing a booked day. The foreign key would
 * stop it anyway, but as a raw database error rather than something that
 * says which days to clear first. */
export const deletePerson =
  (dependencies: DeleteDependencies) =>
  (id: string): ResultAsync<void, AppError> =>
    dependencies.countEventsUsing(id).andThen((inUse) =>
      inUse > 0
        ? errAsync({
            type: 'ValidationError' as const,
            message: `They're on the crew for ${inUse} booked day${inUse === 1 ? '' : 's'}. Take them off those first.`,
            input: id
          })
        : dependencies.removePerson(id)
    )
