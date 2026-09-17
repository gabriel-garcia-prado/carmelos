import { boolean, pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core'

import { timestamps } from '../utils/columns'
import { events } from './events'
import { people } from './people'

export const assignmentRoleEnum = pgEnum('assignment_role', ['pizzaiolo', 'stick', 'cutter'])

/**
 * Who is working one party, and how they get there.
 *
 * Rows rather than two columns on the event, because a party is not a fixed
 * pair: a pizzaiolo and a stick are required, and any number of cutters can be
 * added on top. Per-event rather than per-rig-day, because people leave and
 * are replaced halfway through — a stick who can only do the afternoon, or one
 * who finishes here and goes to a rig that's already out.
 */
export const eventAssignments = pgTable('event_assignments', {
  id: uuid().primaryKey().defaultRandom(),
  eventId: uuid()
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  personId: uuid()
    .notNull()
    .references(() => people.id),
  role: assignmentRoleEnum().notNull(),
  /**
   * True when this person makes their own way to the party instead of riding
   * out with the rig. They're due at the site for the start of set-up, not at
   * the shop before the truck leaves — set-up is done together, so it's the
   * on-site moment and not first pizza.
   *
   * False is the ordinary day: they're at the shop, their own lead time before
   * departure, exactly as before this table existed.
   */
  meetsOnSite: boolean().notNull().default(false),
  ...timestamps
})
