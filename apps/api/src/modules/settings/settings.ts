import type { ResultAsync } from 'neverthrow'
import type { DependencyError } from '#errors'
import type { Viewer } from '../../lib/viewer'
import { isOwner } from '../../lib/viewer'

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

/**
 * The ops constants a non-owner may see.
 *
 * Most of them are harmless timings the client needs to render a day — how
 * long setup takes, how early to arrive. The rack rate is pay, so it goes.
 * Nothing is lost by hiding it: rack minutes are computed server-side and
 * arrive already worked out.
 */
export type VisibleSettings = Omit<Settings, 'defaultRackRatePer30Min'> &
  Readonly<{ defaultRackRatePer30Min: number | null }>

export const redactSettings = (settings: Settings, viewer: Viewer): VisibleSettings =>
  isOwner(viewer) ? settings : { ...settings, defaultRackRatePer30Min: null }

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
