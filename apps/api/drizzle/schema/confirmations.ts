import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { timestamps } from '../utils/columns'
import { events } from './events'
import { people } from './people'

export const confirmationRoleEnum = pgEnum('confirmation_role', ['pizzaiolo', 'crew', 'cutter', 'fire_duty'])
export const confirmationStatusEnum = pgEnum('confirmation_status', ['pending', 'sent', 'confirmed', 'declined'])

// One row per (event, person) who needs a text. Regenerated whenever the
// event is saved: unchanged messages keep their status, changed/new ones
// reset to `pending` so only the people whose own numbers moved get resent
// (spec §10/§15).
export const eventConfirmations = pgTable('event_confirmations', {
  id: uuid().primaryKey().defaultRandom(),
  eventId: uuid()
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  personId: uuid()
    .notNull()
    .references(() => people.id),
  role: confirmationRoleEnum().notNull(),
  messageBody: text().notNull(),
  status: confirmationStatusEnum().notNull().default('pending'),
  sentAt: timestamp(),
  confirmedAt: timestamp(),
  ...timestamps
})
