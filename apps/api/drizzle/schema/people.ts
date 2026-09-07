import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { timestamps } from '../utils/columns'

// Casual crew pool. Overrides are nullable — null means "use the settings
// default"; a per-person value is Billy typing a number he knows to be true,
// never something the app measured (see spec §8). Everyone in the pool is
// crew-capable by default; isPizzaiolo marks who can also run a rig.
export const people = pgTable('people', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  phone: text().notNull(),
  isPizzaiolo: boolean().notNull().default(false),
  // Who can move a truck at all, and who's cleared to tow a trailer oven.
  // Both default false: driving is a specific thing Billy signs off on, not
  // something to assume of a new casual hire.
  canDrive: boolean().notNull().default(false),
  canDriveTrailer: boolean().notNull().default(false),
  rackRateOverridePer30Min: integer(),
  minutesBeforeDepartureOverride: integer(),
  homeBaseAddress: text(),
  ...timestamps
})
