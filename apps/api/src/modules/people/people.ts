import { errAsync, type ResultAsync } from 'neverthrow'
import type { AppError, DependencyError } from '#errors'

export type Person = Readonly<{
  id: string
  name: string
  phone: string
  isPizzaiolo: boolean
  canDrive: boolean
  canDriveTrailer: boolean
  rackRateOverridePer30Min: number | null
  minutesBeforeDepartureOverride: number | null
  homeBaseAddress: string | null
}>

export type NewPerson = Readonly<{
  name: string
  phone: string
  isPizzaiolo: boolean
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
