import { eq } from 'drizzle-orm'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { database, settings as settingsTable } from '#database'
import type { DependencyError } from '#errors'
import { factory } from '#factory'
import { requireAuth } from '#require-auth'
import { validator } from '#validator'
import type { Settings } from './settings'
import { getSettings, updateSettings } from './settings'

const SETTINGS_ID = 'global'

const schema = z.object({
  ovenToTempMinutes: z.number().int().positive(),
  fireBeforeLoadMinutes: z.number().int().positive(),
  setupAimedMinutes: z.number().int().positive(),
  setupFloorMinutes: z.number().int().positive(),
  breakDownMinutes: z.number().int().nonnegative(),
  sparePizzasPerEvent: z.number().int().nonnegative(),
  cheeseBagsPerDough: z.number().int().positive(),
  saucePerPizzas: z.number().int().positive(),
  traySize: z.number().int().positive(),
  defaultRackRatePer30Min: z.number().int().positive(),
  defaultMinutesBeforeDeparture: z.number().int().nonnegative(),
  fireGroupingWindowMinutes: z.number().int().nonnegative(),
  spareFoldThresholdMinutes: z.number().int().nonnegative(),
  kitchenAddress: z.string().trim().min(1).nullable()
})

const dependencyError = (error: unknown, input: unknown): DependencyError => ({
  type: 'DependencyError' as const,
  message: `${error}`,
  dependency: 'db',
  input
})

const dependencies = {
  fetchSettings: (): ResultAsync<Settings, DependencyError> =>
    ResultAsync.fromPromise(database.select().from(settingsTable).where(eq(settingsTable.id, SETTINGS_ID)), (error) =>
      dependencyError(error, undefined)
    ).andThen(([row]) =>
      row ? okAsync(row as Settings) : errAsync(dependencyError('settings row is missing', undefined))
    ),
  saveSettings: (settings: Settings): ResultAsync<Settings, DependencyError> =>
    ResultAsync.fromPromise(
      database.update(settingsTable).set(settings).where(eq(settingsTable.id, SETTINGS_ID)).returning(),
      (error) => dependencyError(error, settings)
    ).map(([row]) => row as Settings)
}

export const settingsRoutes = factory
  .createApp()
  .get('/', requireAuth, async (c) => c.var.appResponse(await getSettings(dependencies)()))
  .put('/', requireAuth, validator('json', schema), async (c) =>
    c.var.appResponse(await updateSettings(dependencies)(c.req.valid('json')))
  )
