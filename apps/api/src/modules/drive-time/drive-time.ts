import type { ResultAsync } from 'neverthrow'
import type { AppError } from '#errors'

export type DriveTimeInput = Readonly<{
  origin: string
  destination: string
  // Unix seconds, or 'now' — when present, Google returns a traffic-aware
  // estimate for that time of day instead of the historical-average one.
  departureTime?: number | 'now'
}>

type Dependencies = {
  fetchDriveMinutes: (input: DriveTimeInput) => ResultAsync<number, AppError>
}

export const getDriveMinutes =
  (dependencies: Dependencies) =>
  (input: DriveTimeInput): ResultAsync<number, AppError> =>
    dependencies.fetchDriveMinutes(input)
