import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { environment } from '#environment'
import type { AppError } from '#errors'
import { factory } from '#factory'
import { requireAuth } from '#require-auth'
import { validator } from '#validator'
import type { DriveTimeInput } from './drive-time'
import { getDriveMinutes } from './drive-time'

const schema = z.object({
  origin: z.string().trim().min(1),
  destination: z.string().trim().min(1),
  departureTime: z.union([z.literal('now'), z.number().int().positive()]).optional()
})

type DistanceMatrixResponse = Readonly<{
  status: string
  rows?: readonly Readonly<{
    elements?: readonly Readonly<{
      status: string
      duration?: Readonly<{ value: number }>
      duration_in_traffic?: Readonly<{ value: number }>
    }>[]
  }>[]
}>

const dependencies = {
  fetchDriveMinutes: (input: DriveTimeInput): ResultAsync<number, AppError> => {
    if (!environment.GOOGLE_MAPS_API_KEY) {
      return errAsync({
        type: 'ValidationError' as const,
        message: 'Set GOOGLE_MAPS_API_KEY on the API to enable drive-time calculation',
        input
      })
    }

    const apiKey = environment.GOOGLE_MAPS_API_KEY

    // Addresses go to Distance Matrix as text: it geocodes them itself, at no
    // extra call. Pre-geocoding here to bias the lookup was tried and dropped
    // — `bounds` is a soft hint that a prominent out-of-state match still
    // beats, so it tripled the Google spend on every traffic badge without
    // actually fixing an ambiguous "88 Main St, Chatham". What fixes that is a
    // complete address, which the event form's Places autocomplete already
    // stores (`formatted_address`, town and state included).
    return okAsync({ origins: input.origin, destinations: input.destination }).andThen(({ origins, destinations }) => {
      const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
      url.searchParams.set('origins', origins)
      url.searchParams.set('destinations', destinations)
      url.searchParams.set('region', 'us')
      url.searchParams.set('key', apiKey)
      // Traffic-aware duration only comes back when a departure time is given
      // (spec: driving mode, no waypoints — both already true here).
      if (input.departureTime !== undefined) {
        url.searchParams.set('departure_time', String(input.departureTime))
      }

      return ResultAsync.fromPromise(
        fetch(url).then((response) => response.json() as Promise<DistanceMatrixResponse>),
        (error): AppError => ({
          type: 'DependencyError' as const,
          message: `${error}`,
          dependency: 'google-maps',
          input
        })
      ).andThen((body) => {
        if (body.status !== 'OK') {
          return errAsync({
            type: 'DependencyError' as const,
            message: `Google Maps request failed: ${body.status}`,
            dependency: 'google-maps',
            input
          })
        }

        const element = body.rows?.[0]?.elements?.[0]

        if (element?.status !== 'OK' || !element.duration) {
          return errAsync({
            type: 'ValidationError' as const,
            message: "Couldn't find a driving route between those two addresses — check them for typos",
            input
          })
        }

        const seconds = element.duration_in_traffic?.value ?? element.duration.value
        return okAsync(Math.round(seconds / 60))
      })
    })
  }
}

export const driveTimeRoutes = factory
  .createApp()
  .post('/', requireAuth, validator('json', schema), async (c) =>
    c.var.appResponse((await getDriveMinutes(dependencies)(c.req.valid('json'))).map((minutes) => ({ minutes })))
  )
