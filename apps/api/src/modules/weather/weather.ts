import type { ResultAsync } from 'neverthrow'
import type { AppError } from '#errors'

export type WeatherCondition = 'clear' | 'clouds' | 'rain' | 'snow' | 'thunderstorm'

export type WeatherSummary = Readonly<{
  tempF: number | null
  condition: WeatherCondition | null
  shortForecast: string | null
  isExtremeHeat: boolean
  hasTornadoWarning: boolean
  hasThunderstormWarning: boolean
}>

type Dependencies = {
  fetchWeather: (address: string) => ResultAsync<WeatherSummary, AppError>
}

export const getWeather =
  (dependencies: Dependencies) =>
  (address: string): ResultAsync<WeatherSummary, AppError> =>
    dependencies.fetchWeather(address)
