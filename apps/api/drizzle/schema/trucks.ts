import { integer, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'

import { timestamps } from '../utils/columns'

/**
 * Where the oven lives. A trailer is towed — which is why it needs a driver
 * cleared to tow — while a built-in one rides in the vehicle itself.
 */
export const ovenMountEnum = pgEnum('oven_mount', ['trailer', 'built_in'])

/**
 * The vehicles themselves, separate from the four scheduling lanes. A rig
 * picks a truck for the day, so a truck in the shop doesn't take its lane out
 * of service with it.
 */
export const trucks = pgTable('trucks', {
  id: text().primaryKey(),
  name: text().notNull(),
  // What the board shows when a lane is squeezed to a sliver — "S·CAD" for
  // Small Caddy. Nullable so a truck added in a hurry still works; the board
  // falls back to the first word of the name.
  shortName: text(),
  ovenMount: ovenMountEnum().notNull(),
  // How far it can reasonably go out and still get home — Billy's own number,
  // not something the app measures.
  rangeMiles: integer().notNull(),
  // 1–5, how pleasant a long haul in it actually is. Subjective on purpose:
  // it's the thing that decides who gets the four-hour drive.
  comfort: integer().notNull().default(3),
  notes: text(),

  ...timestamps
})
