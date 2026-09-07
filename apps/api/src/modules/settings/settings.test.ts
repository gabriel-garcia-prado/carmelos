import { describe, expect, mock, test } from 'bun:test'
import { errAsync, okAsync } from 'neverthrow'
import type { MockDependencies } from '#test'
import type { Settings } from './settings'
import { getSettings, updateSettings } from './settings'

const SETTINGS: Settings = {
  ovenToTempMinutes: 240,
  fireBeforeLoadMinutes: 120,
  setupAimedMinutes: 60,
  setupFloorMinutes: 30,
  breakDownMinutes: 30,
  sparePizzasPerEvent: 25,
  cheeseBagsPerDough: 25,
  saucePerPizzas: 35,
  traySize: 25,
  defaultRackRatePer30Min: 20,
  defaultMinutesBeforeDeparture: 15,
  fireGroupingWindowMinutes: 30,
  spareFoldThresholdMinutes: 10,
  kitchenAddress: null
}

describe('getSettings', () => {
  test('returns whatever the store has', async () => {
    const fetchSettings: MockDependencies<typeof getSettings> = (overrides) => ({
      fetchSettings: mock(() => okAsync(SETTINGS)),
      ...overrides
    })

    const result = await getSettings(fetchSettings())()

    expect(result._unsafeUnwrap()).toEqual(SETTINGS)
  })

  test('propagates a dependency error', async () => {
    const error = { type: 'DependencyError' as const, message: 'db down', dependency: 'db', input: undefined }
    const dependencies: MockDependencies<typeof getSettings> = (overrides) => ({
      fetchSettings: mock(() => errAsync(error)),
      ...overrides
    })

    const result = await getSettings(dependencies())()

    expect(result._unsafeUnwrapErr()).toEqual(error)
  })
})

describe('updateSettings', () => {
  test('saves the given settings and returns what was saved', async () => {
    const dependencies: MockDependencies<typeof updateSettings> = (overrides) => ({
      saveSettings: mock((settings: typeof SETTINGS) => okAsync(settings)),
      ...overrides
    })
    const deps = dependencies()

    const result = await updateSettings(deps)(SETTINGS)

    expect(deps.saveSettings).toHaveBeenCalledWith(SETTINGS)
    expect(result._unsafeUnwrap()).toEqual(SETTINGS)
  })
})
