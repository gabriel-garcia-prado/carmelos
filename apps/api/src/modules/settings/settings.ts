import type { ResultAsync } from 'neverthrow'
import type { DependencyError } from '#errors'

export type Settings = Readonly<{
  ovenToTempMinutes: number
  fireBeforeLoadMinutes: number
  setupAimedMinutes: number
  setupFloorMinutes: number
  breakDownMinutes: number
  sparePizzasPerEvent: number
  cheeseBagsPerDough: number
  saucePerPizzas: number
  traySize: number
  defaultRackRatePer30Min: number
  defaultMinutesBeforeDeparture: number
  fireGroupingWindowMinutes: number
  spareFoldThresholdMinutes: number
  kitchenAddress: string | null
}>

type GetDependencies = {
  fetchSettings: () => ResultAsync<Settings, DependencyError>
}

export const getSettings = (dependencies: GetDependencies) => (): ResultAsync<Settings, DependencyError> =>
  dependencies.fetchSettings()

type UpdateDependencies = {
  saveSettings: (settings: Settings) => ResultAsync<Settings, DependencyError>
}

export const updateSettings =
  (dependencies: UpdateDependencies) =>
  (input: Settings): ResultAsync<Settings, DependencyError> =>
    dependencies.saveSettings(input)
