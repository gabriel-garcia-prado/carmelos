import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { timestamps } from '../utils/columns'
import { people } from './people'
import { trucks } from './trucks'

export const rigEnum = pgEnum('rig', ['small_caddy', 'big_caddy', 'pickup', 'bus'])

export const specialRequestTypeEnum = pgEnum('special_request_type', [
  'gluten_free',
  'halal',
  'no_pork',
  'vegetarian',
  'vegan',
  'dairy_free',
  'paneer',
  'spicy'
])

// A party. The calendar day and ordering-within-a-rig are always derived from
// firstPizzaTime, never stored separately, so there's one source of truth for
// "which day/rig is this on".
export const events = pgTable('events', {
  id: uuid().primaryKey().defaultRandom(),
  rig: rigEnum().notNull(),
  firstPizzaTime: timestamp().notNull(),
  headcount: integer().notNull(),
  address: text().notNull(),
  // Who the party is for — optional, shown on the board so an event reads
  // as "the Garcia party" rather than just an address.
  clientName: text(),

  // Drive time for the leg that reaches this event (from the shop, if it's
  // the rig's first event of the day, otherwise from the previous event's
  // address). Typed in by Billy — no Maps integration in phase one.
  driveMinutes: integer().notNull(),
  // Only meaningful on whichever event turns out to be this rig's last of the
  // day — the UI surfaces it there. Null elsewhere.
  driveMinutesBackToShop: integer(),

  serviceDurationMinutes: integer().notNull().default(120),
  // Null means "use settings.setupAimedMinutes / floor", same override
  // convention as the person-level rack rate.
  setupMinutesOverride: integer(),
  rackCount: integer().notNull().default(0),

  pizzaioloId: uuid()
    .notNull()
    .references(() => people.id),
  crewMemberId: uuid()
    .notNull()
    .references(() => people.id),
  // Escape hatch for the fire-duty optimizer (spec §8: every derived time
  // must remain overridable). Set to pin who lights this rig's fire instead
  // of trusting the auto-assignment.
  fireDutyOverridePersonId: uuid().references(() => people.id),
  // How long before the truck leaves this rig's crew is due in, when today
  // differs from their usual lead time. Same shape as the fire-duty override:
  // read off whichever event is first for the rig that day, null = use the
  // person's own override, or the shop default.
  crewArrivalOverrideMinutes: integer(),
  // Which truck this rig runs today. Read off the day's first event for the
  // rig, same as the fire-duty and crew-arrival overrides; null means the
  // rig's usual truck.
  truckId: text().references(() => trucks.id),

  ...timestamps
})

export const eventSpecialRequests = pgTable('event_special_requests', {
  id: uuid().primaryKey().defaultRandom(),
  eventId: uuid()
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  requestType: specialRequestTypeEnum().notNull(),
  headcount: integer().notNull(),
  ...timestamps
})
