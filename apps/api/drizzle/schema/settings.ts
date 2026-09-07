import { integer, pgTable, text } from 'drizzle-orm/pg-core'

import { timestamps } from '../utils/columns'

/**
 * Every configurable constant from the ops spec, kept in one row. Rigs
 * currently share one set of numbers (spec: "all four rigs currently share
 * one set"), so there's no per-rig scope yet — just kitchen/rig/crew/global
 * defaults collapsed into a single settings row, upserted by id.
 */
export const settings = pgTable('settings', {
  id: text().primaryKey().default('global'),

  ovenToTempMinutes: integer().notNull().default(240),
  fireBeforeLoadMinutes: integer().notNull().default(120),
  setupAimedMinutes: integer().notNull().default(60),
  setupFloorMinutes: integer().notNull().default(30),
  breakDownMinutes: integer().notNull().default(30),

  sparePizzasPerEvent: integer().notNull().default(25),
  cheeseBagsPerDough: integer().notNull().default(25),
  saucePerPizzas: integer().notNull().default(35),
  traySize: integer().notNull().default(25),

  defaultRackRatePer30Min: integer().notNull().default(20),
  defaultMinutesBeforeDeparture: integer().notNull().default(15),

  // How close two rigs' fire-lit times need to be before the same early
  // arrival lights them together at the earliest moment instead of walking
  // back over at each rig's own time (spec §4: "twenty or thirty minutes
  // apart is not a gap worth a second trip").
  fireGroupingWindowMinutes: integer().notNull().default(30),

  // A spare gap this short isn't worth its own block on the day board — it
  // reads as clutter, not slack — so it's folded into the drive block
  // instead of shown separately.
  spareFoldThresholdMinutes: integer().notNull().default(10),

  // Where drive-time auto-calculation measures "leave" and "back at shop"
  // from. Null until Billy sets it — the drive-time endpoint refuses to run
  // without it.
  kitchenAddress: text(),

  ...timestamps
})
