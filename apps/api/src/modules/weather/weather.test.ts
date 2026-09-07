import { describe, expect, mock, test } from 'bun:test'
import { errAsync, okAsync } from 'neverthrow'
import type { MockDependencies, MockInput } from '#test'
import { getWeather } from './weather'

const address: MockInput<typeof getWeather> = () => '20 Beechwood Rd, Millburn, NJ'

describe('getWeather', () => {
  test('returns whatever the dependency resolves', async () => {
    const summary = {
      tempF: 72,
      condition: 'clear' as const,
      shortForecast: 'Sunny',
      isExtremeHeat: false,
      hasTornadoWarning: false,
      hasThunderstormWarning: false
    }
    const dependencies: MockDependencies<typeof getWeather> = (overrides) => ({
      fetchWeather: mock(() => okAsync(summary)),
      ...overrides
    })

    const result = await getWeather(dependencies())(address())

    expect(result._unsafeUnwrap()).toEqual(summary)
  })

  test('propagates an error from the dependency', async () => {
    const error = { type: 'ValidationError' as const, message: "Couldn't locate that address", input: undefined }
    const dependencies: MockDependencies<typeof getWeather> = (overrides) => ({
      fetchWeather: mock(() => errAsync(error)),
      ...overrides
    })

    const result = await getWeather(dependencies())(address())

    expect(result._unsafeUnwrapErr()).toEqual(error)
  })
})
