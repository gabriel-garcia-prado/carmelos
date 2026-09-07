import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import type { AppError } from '#errors'

/**
 * The viewport every address lookup is biased towards — roughly northern and
 * central New Jersey plus the New York and eastern Pennsylvania edges the
 * trucks actually reach.
 *
 * Without it Google resolves a bare "88 Main St, Chatham" to whichever Chatham
 * scores best worldwide, which is how a 45-minute run to Chatham NJ came back
 * as a 286-minute haul out of state. `bounds` is a BIAS, not a filter: an
 * address genuinely outside the box still resolves normally, it just stops a
 * local town losing to an out-of-state namesake when the state is left off.
 *
 * Format is `south,west|north,east`.
 */
const SERVICE_AREA_BOUNDS = '40.30,-75.40|41.30,-73.70'

type GeocodeResponse = Readonly<{
  status: string
  error_message?: string
  results?: readonly Readonly<{
    formatted_address?: string
    geometry?: Readonly<{ location?: Readonly<{ lat: number; lng: number }> }>
  }>[]
}>

export type GeocodedAddress = Readonly<{
  lat: number
  lng: number
  formattedAddress: string
  /** `lat,lng` — what to hand to APIs that take no bias of their own. */
  point: string
}>

/**
 * One address to one point, biased to the service area. Both the drive-time
 * and weather lookups go through this rather than passing raw text on to
 * Google, so they can never silently disagree about which town was meant.
 */
export const geocodeAddress = (apiKey: string, address: string): ResultAsync<GeocodedAddress, AppError> => {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('bounds', SERVICE_AREA_BOUNDS)
  url.searchParams.set('region', 'us')
  url.searchParams.set('key', apiKey)

  return ResultAsync.fromPromise(
    fetch(url).then((response) => response.json() as Promise<GeocodeResponse>),
    (error): AppError => ({
      type: 'DependencyError' as const,
      message: `${error}`,
      dependency: 'google-geocoding',
      input: address
    })
  ).andThen((body) => {
    const first = body.results?.[0]
    const location = first?.geometry?.location
    if (body.status !== 'OK' || !location) {
      // ZERO_RESULTS really is a bad address; REQUEST_DENIED and friends are a
      // key/billing problem and have nothing to do with what was typed, so the
      // two can't share a message or you spend an hour re-checking a road name.
      return errAsync(
        body.status === 'ZERO_RESULTS'
          ? {
              type: 'ValidationError' as const,
              message: `Couldn't locate "${address}" — check it for typos, and add the town and state if it's ambiguous`,
              input: address
            }
          : {
              type: 'DependencyError' as const,
              message: `Google Geocoding failed: ${body.status}${body.error_message ? ` — ${body.error_message}` : ''}`,
              dependency: 'google-geocoding',
              input: address
            }
      )
    }
    return okAsync({
      lat: location.lat,
      lng: location.lng,
      formattedAddress: first?.formatted_address ?? address,
      point: `${location.lat.toFixed(4)},${location.lng.toFixed(4)}`
    })
  })
}
