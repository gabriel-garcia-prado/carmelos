import { errAsync, type ResultAsync } from 'neverthrow'
import type { AppError, DependencyError } from '#errors'

/** Where a truck's oven sits — a trailer is towed, built-in rides along. */
export type OvenMount = 'trailer' | 'built_in'

export type Truck = Readonly<{
  id: string
  name: string
  shortName: string | null
  ovenMount: OvenMount
  rangeMiles: number
  comfort: number
  notes: string | null
}>

export type TruckUpdate = Readonly<{ id: string } & Partial<Omit<Truck, 'id'>>>
export type NewTruck = Omit<Truck, 'id'>

type ListDependencies = {
  fetchTrucks: () => ResultAsync<readonly Truck[], DependencyError>
}

export const listTrucks = (dependencies: ListDependencies) => (): ResultAsync<readonly Truck[], DependencyError> =>
  dependencies.fetchTrucks()

type CreateDependencies = {
  generateId: () => string
  insertTruck: (truck: Truck) => ResultAsync<Truck, DependencyError>
}

export const createTruck =
  (dependencies: CreateDependencies) =>
  (input: NewTruck): ResultAsync<Truck, DependencyError> =>
    dependencies.insertTruck({ id: dependencies.generateId(), ...input })

type DeleteDependencies = {
  countEventsUsing: (id: string) => ResultAsync<number, DependencyError>
  removeTruck: (id: string) => ResultAsync<void, DependencyError>
}

/** Refuses while any day still has this truck assigned — silently nulling
 * those out would quietly change who's driving what on a booked day. */
export const deleteTruck =
  (dependencies: DeleteDependencies) =>
  (id: string): ResultAsync<void, AppError> =>
    dependencies.countEventsUsing(id).andThen((inUse) =>
      inUse > 0
        ? errAsync({
            type: 'ValidationError' as const,
            message: `That truck is assigned to ${inUse} booked day${inUse === 1 ? '' : 's'}. Move those onto another truck first.`,
            input: id
          })
        : dependencies.removeTruck(id)
    )

type UpdateDependencies = {
  saveTruck: (update: TruckUpdate) => ResultAsync<Truck, DependencyError>
}

export const updateTruck =
  (dependencies: UpdateDependencies) =>
  (input: TruckUpdate): ResultAsync<Truck, DependencyError> =>
    dependencies.saveTruck(input)

/**
 * Whether this pair can legally move the truck: someone has to be able to
 * drive it, and a towed oven needs someone cleared for a trailer. Returns the
 * problem as a sentence, or null when the assignment is fine — a warning for
 * the UI to show, not a rule that blocks a save.
 */
export const truckCrewProblem = (
  truck: Truck,
  crew: readonly Readonly<{ name: string; canDrive: boolean; canDriveTrailer: boolean }>[]
): string | null => {
  if (!crew.some((person) => person.canDrive)) {
    return `Nobody on this rig can drive ${truck.name}.`
  }
  if (truck.ovenMount === 'trailer' && !crew.some((person) => person.canDrive && person.canDriveTrailer)) {
    return `${truck.name} tows its oven, and nobody on this rig is cleared for a trailer.`
  }
  return null
}
