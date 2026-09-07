import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { environment } from '#environment'
import type { AppError } from '#errors'
import { factory } from '#factory'
import { requireAuth } from '#require-auth'
import { validator } from '#validator'
import { geocodeAddress } from '../../lib/geocoding'
import type { WeatherCondition, WeatherSummary } from './weather'
import { getWeather } from './weather'

const querySchema = z.object({ address: z.string().trim().min(1) })

// NWS asks every client to identify itself in the User-Agent (no API key —
// this is what stands in for one). https://www.weather.gov/documentation/services-web-api
const NWS_USER_AGENT = "Carmelo's Ops App (internal scheduling tool)"

type PointsResponse = Readonly<{ properties?: Readonly<{ forecast?: string }> }>

type ForecastResponse = Readonly<{
  properties?: Readonly<{
    periods?: readonly Readonly<{ temperature?: number; temperatureUnit?: string; shortForecast?: string }>[]
  }>
}>

type AlertsResponse = Readonly<{ features?: readonly Readonly<{ properties?: Readonly<{ event?: string }> }>[] }>

const classifyCondition = (shortForecast: string): WeatherCondition => {
  const text = shortForecast.toLowerCase()
  if (text.includes('thunderstorm')) return 'thunderstorm'
  if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return 'rain'
  if (text.includes('snow') || text.includes('sleet') || text.includes('ice')) return 'snow'
  if (text.includes('cloud')) return 'clouds'
  return 'clear'
}

const dependencyError = (dependency: string, error: unknown, input: unknown): AppError => ({
  type: 'DependencyError' as const,
  message: `${error}`,
  dependency,
  input
})

const nwsFetch = <T>(url: string, address: string): ResultAsync<T, AppError> =>
  ResultAsync.fromPromise(
    fetch(url, { headers: { 'User-Agent': NWS_USER_AGENT } }).then((response) => response.json() as Promise<T>),
    (error) => dependencyError('nws', error, address)
  )

const dependencies = {
  fetchWeather: (address: string): ResultAsync<WeatherSummary, AppError> => {
    if (!environment.GOOGLE_MAPS_API_KEY) {
      return errAsync({
        type: 'ValidationError' as const,
        message: 'Set GOOGLE_MAPS_API_KEY on the API to enable weather (also enable the Geocoding API for that key)',
        input: address
      })
    }

    // Same service-area-biased lookup the drive-time route uses, so the two
    // can never end up describing different towns for one address.
    return geocodeAddress(environment.GOOGLE_MAPS_API_KEY, address).andThen(({ point }) => {
      return nwsFetch<PointsResponse>(`https://api.weather.gov/points/${point}`, address).andThen((points) => {
        const forecastUrl = points.properties?.forecast
        if (!forecastUrl) {
          return errAsync(dependencyError('nws', 'no forecast office for this location', address))
        }

        return ResultAsync.combine([
          nwsFetch<ForecastResponse>(forecastUrl, address),
          nwsFetch<AlertsResponse>(`https://api.weather.gov/alerts/active?point=${point}`, address)
        ]).andThen(([forecast, alerts]) => {
          const period = forecast.properties?.periods?.[0]
          const tempF = period?.temperatureUnit === 'F' ? (period?.temperature ?? null) : null
          const shortForecast = period?.shortForecast ?? null
          const condition = shortForecast ? classifyCondition(shortForecast) : null

          const alertEvents = (alerts.features ?? []).map((feature) => feature.properties?.event?.toLowerCase() ?? '')
          const hasTornadoWarning = alertEvents.some((event) => event.includes('tornado'))
          const hasHeatAlert = alertEvents.some((event) => event.includes('heat'))
          const hasThunderstormAlert = alertEvents.some((event) => event.includes('thunderstorm'))

          return okAsync({
            tempF,
            condition,
            shortForecast,
            isExtremeHeat: hasHeatAlert || (tempF !== null && tempF >= 95),
            hasTornadoWarning,
            hasThunderstormWarning: hasThunderstormAlert || condition === 'thunderstorm'
          })
        })
      })
    })
  }
}

/**
 * Stand-in forecasts for local development. Real weather needs a Google key
 * with the Geocoding API enabled AND a live NWS lookup — neither of which
 * can be seeded into the database, since nothing about weather is stored
 * there. This keeps the badges exercisable offline by deriving a stable
 * pretend forecast from the address, so a given party always looks the same.
 */
const mockWeather = (address: string): WeatherSummary => {
  const bucket = [...address].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5
  const forecasts: readonly WeatherSummary[] = [
    {
      tempF: 72,
      condition: 'clear',
      shortForecast: 'Sunny',
      isExtremeHeat: false,
      hasTornadoWarning: false,
      hasThunderstormWarning: false
    },
    {
      tempF: 61,
      condition: 'rain',
      shortForecast: 'Rain likely',
      isExtremeHeat: false,
      hasTornadoWarning: false,
      hasThunderstormWarning: false
    },
    {
      tempF: 99,
      condition: 'clear',
      shortForecast: 'Hot and sunny',
      isExtremeHeat: true,
      hasTornadoWarning: false,
      hasThunderstormWarning: false
    },
    {
      tempF: 68,
      condition: 'thunderstorm',
      shortForecast: 'Scattered thunderstorms',
      isExtremeHeat: false,
      hasTornadoWarning: false,
      hasThunderstormWarning: true
    },
    {
      tempF: 65,
      condition: 'clouds',
      shortForecast: 'Partly cloudy',
      isExtremeHeat: false,
      hasTornadoWarning: false,
      hasThunderstormWarning: false
    }
  ]
  return forecasts[bucket] as WeatherSummary
}

const mockDependencies = { fetchWeather: (address: string) => okAsync(mockWeather(address)) }

export const weatherRoutes = factory
  .createApp()
  .get('/', requireAuth, validator('query', querySchema), async (c) =>
    c.var.appResponse(
      await getWeather(environment.MOCK_WEATHER ? mockDependencies : dependencies)(c.req.valid('query').address)
    )
  )
