/**
 * Seeds development data: a known dev user so you can sign in immediately.
 *
 * Runs as a one-shot step after migrations in `bun dev` (it is not part of the
 * production container CMD). Idempotent — safe to run repeatedly. The user is
 * created through Better Auth's own API so the password hash matches exactly
 * what sign-in expects.
 */
import { eq } from 'drizzle-orm'
import {
  database,
  eventAssignments,
  eventConfirmations,
  eventSpecialRequests,
  events,
  people,
  settings,
  trucks,
  user
} from '#database'
import { auth } from '../../src/modules/auth/auth'
import type { EventRecord } from '../../src/modules/events/events'
import { buildDayView, computeDesiredConfirmations } from '../../src/modules/events/events'

export const DEV_USER = {
  name: 'Dev User',
  email: 'manager@example.com',
  password: 'password1234'
}

/**
 * Logins whose address said who the person was before it said what they do.
 *
 * Renamed in place rather than left behind, so an existing dev database ends
 * up with the three role-shaped logins and not six. Better Auth keys the
 * credential row by user id, not by address, so the password still works.
 */
const RENAMED_LOGINS = [
  { from: 'dev@example.com', to: DEV_USER.email },
  { from: 'kurt@example.com', to: 'pizzaiolo@example.com' },
  { from: 'leonardo@example.com', to: 'crew@example.com' }
]

// Constants from the ops spec (§3), the defaults every event is computed
// against until Billy changes them.
const DEFAULT_SETTINGS = {
  id: 'global',
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
  kitchenAddress: '412 NJ-23, Pompton Plains, NJ 07444'
}

// The casual crew pool from the ops spec (§1). Everyone is crew-capable;
// isPizzaiolo marks who can also run a rig — the people actually assigned
// as pizzaiolo across the seeded reference events below.
const CREW = [
  { name: 'Gabriel', phone: '551 401-7502', isPizzaiolo: true, canStick: true, canDrive: true, canDriveTrailer: true },
  { name: 'Kurt', phone: '973 525-7887', isPizzaiolo: true, canStick: true, canDrive: true, canDriveTrailer: true },
  {
    name: 'Leonardo',
    phone: '917 434-9619',
    isPizzaiolo: false,
    canStick: true,
    canDrive: true,
    canDriveTrailer: false
  },
  { name: 'EJ', phone: '201 575-2176', isPizzaiolo: true, canStick: true, canDrive: true, canDriveTrailer: false },
  { name: 'Nick', phone: '973 248-2950', isPizzaiolo: false, canStick: true, canDrive: false, canDriveTrailer: false },
  { name: 'Sam', phone: '929 316-7237', isPizzaiolo: true, canStick: true, canDrive: true, canDriveTrailer: false },
  { name: 'Matt', phone: '732 673-8754', isPizzaiolo: false, canStick: true, canDrive: true, canDriveTrailer: false },
  { name: 'John', phone: '973 800-7415', isPizzaiolo: false, canStick: true, canDrive: false, canDriveTrailer: false },
  // Cuts and nothing else — the one person the stick seat has to refuse.
  { name: 'Ana', phone: '862 555-0148', isPizzaiolo: false, canStick: false, canDrive: true, canDriveTrailer: false }
]

if (process.env.NODE_ENV === 'production') {
  console.error('[SEED] refusing to seed in production')
  process.exit(1)
}

for (const { from, to } of RENAMED_LOGINS) {
  const [stale] = await database.select().from(user).where(eq(user.email, from))
  if (!stale) {
    continue
  }
  // Email is unique. If a run already created the new address, the old row is
  // a duplicate rather than something to rename, so leave it alone and say so.
  const [taken] = await database.select().from(user).where(eq(user.email, to))
  if (taken) {
    console.log(`[SEED] ${from} is superseded by ${to} — delete it by hand if you want it gone`)
    continue
  }
  await database.update(user).set({ email: to }).where(eq(user.email, from))
  console.log(`[SEED] renamed ${from} to ${to}`)
}

const existingUser = await database.select().from(user).where(eq(user.email, DEV_USER.email))

if (existingUser.length > 0) {
  console.log(`[SEED] dev user already exists — email: ${DEV_USER.email}, password: ${DEV_USER.password}`)
} else {
  await auth.api.signUpEmail({ body: DEV_USER })
  console.log(`[SEED] created dev user — email: ${DEV_USER.email}, password: ${DEV_USER.password}`)
}

// Roles arrived after this user did, and the column defaults to the least it
// could be. Promoting on every run rather than only at creation is what keeps
// an existing dev database from quietly locking Billy out of his own app.
await database.update(user).set({ role: 'owner', personId: null }).where(eq(user.email, DEV_USER.email))

const existingSettings = await database.select().from(settings).where(eq(settings.id, 'global'))

if (existingSettings.length > 0) {
  console.log('[SEED] settings already seeded')
  // Backfill fields added after the row already existed, so an evolving
  // schema still shows up in an existing dev database.
  if (existingSettings[0]?.kitchenAddress === null) {
    await database
      .update(settings)
      .set({ kitchenAddress: DEFAULT_SETTINGS.kitchenAddress })
      .where(eq(settings.id, 'global'))
    console.log('[SEED] backfilled kitchen address')
  }
} else {
  await database.insert(settings).values(DEFAULT_SETTINGS)
  console.log('[SEED] created default settings')
}

const existingPeople = await database.select().from(people)
const existingNames = new Set(existingPeople.map((person) => person.name))
const newCrew = CREW.filter((person) => !existingNames.has(person.name))

if (newCrew.length === 0) {
  console.log('[SEED] crew already seeded')
} else {
  await database.insert(people).values(
    newCrew.map((person) => ({
      name: person.name,
      phone: person.phone,
      isPizzaiolo: person.isPizzaiolo,
      canStick: person.canStick,
      canDrive: person.canDrive,
      canDriveTrailer: person.canDriveTrailer,
      rackRateOverridePer30Min: null,
      minutesBeforeDepartureOverride: null,
      homeBaseAddress: null
    }))
  )
  console.log(`[SEED] created ${newCrew.length} crew member(s)`)
}

// Sync isPizzaiolo even for people that already existed from an earlier
// seed run, so schema changes like this one still take effect.
for (const person of CREW) {
  await database
    .update(people)
    .set({
      isPizzaiolo: person.isPizzaiolo,
      canStick: person.canStick,
      canDrive: person.canDrive,
      canDriveTrailer: person.canDriveTrailer
    })
    .where(eq(people.name, person.name))
}

/**
 * Logins for the crew pool, so the restricted views are something you can
 * actually sign into and look at.
 *
 * The link to a people row is the whole point: without it "their own shifts"
 * has nothing to resolve against, and the app shows them nothing. Kurt runs a
 * rig and Leonardo doesn't, which is also the pair that demonstrates fire duty
 * — Leonardo covers other rigs' fires on the seeded days.
 */
const CREW_LOGINS = [
  { name: 'Kurt', email: 'pizzaiolo@example.com', password: 'password1234', role: 'pizzaiolo' },
  { name: 'Leonardo', email: 'crew@example.com', password: 'password1234', role: 'crew' }
]

const pool = await database.select().from(people)

for (const login of CREW_LOGINS) {
  const person = pool.find((candidate) => candidate.name === login.name)
  if (!person) {
    console.warn(`[SEED] no crew member named ${login.name} — skipping their login`)
    continue
  }

  const existingLogin = await database.select().from(user).where(eq(user.email, login.email))
  if (existingLogin.length === 0) {
    await auth.api.signUpEmail({ body: { name: login.name, email: login.email, password: login.password } })
  }

  // role and personId are `input: false` in auth.config.ts — deliberately not
  // settable through sign-up, since a self-assigned role is not a role. They
  // get written straight to the row instead.
  await database.update(user).set({ role: login.role, personId: person.id }).where(eq(user.email, login.email))
  console.log(`[SEED] ${login.role} login — email: ${login.email}, password: ${login.password}`)
}

// The vehicles themselves. Ids are stable slugs so an event can name one
// without a lookup, and so re-running the seed converges rather than
// duplicating. Each rig's usual truck shares its name.
const TRUCKS = [
  {
    id: 'small_caddy',
    shortName: 'S·CAD',
    name: 'Small Caddy',
    ovenMount: 'trailer' as const,
    rangeMiles: 90,
    comfort: 3,
    notes: 'Tows the small oven. Nimble, fine for tight suburban driveways.'
  },
  {
    id: 'big_caddy',
    shortName: 'B·CAD',
    name: 'Big Caddy',
    ovenMount: 'trailer' as const,
    rangeMiles: 120,
    comfort: 3,
    notes: 'Bigger trailer, bigger oven. Needs room to turn around.'
  },
  {
    id: 'pickup',
    shortName: 'PU',
    name: 'Pickup',
    ovenMount: 'built_in' as const,
    rangeMiles: 200,
    comfort: 4,
    notes: 'Oven sits in the bed — no towing, so anyone cleared to drive can take it.'
  },
  {
    id: 'bus',
    shortName: 'BUS',
    name: 'Bus',
    ovenMount: 'built_in' as const,
    rangeMiles: 260,
    comfort: 5,
    notes: 'The long-haul option. Most comfortable cab of the four.'
  }
]

for (const truck of TRUCKS) {
  await database.insert(trucks).values(truck).onConflictDoUpdate({ target: trucks.id, set: truck })
}
console.log(`[SEED] ${TRUCKS.length} trucks`)

// Reference events are re-derived from scratch every run rather than
// inserted once — deleting cascades to eventSpecialRequests and
// eventConfirmations, so this stays a clean converge-to-canonical-set
// instead of accumulating duplicates, and editing the list below always
// shows up on the next `bun dev` without a manual reset.
await database.delete(events)

{
  const allPeople = await database.select().from(people)
  const idOf = (name: string): string => {
    const found = allPeople.find((person) => person.name === name)
    if (!found) throw new Error(`[SEED] expected crew member "${name}" to exist`)
    return found.id
  }

  /**
   * The crew for one party: a pizzaiolo, a stick, and any cutters after them.
   *
   * Cutters default to making their own way — they're due on site for set-up
   * rather than at the shop, which is how the extra pair of hands usually
   * turns up.
   */
  const crew = (pizzaiolo: string, stick: string, ...cutters: readonly string[]): EventRecord['assignments'] => [
    { personId: idOf(pizzaiolo), role: 'pizzaiolo', meetsOnSite: false },
    { personId: idOf(stick), role: 'stick', meetsOnSite: false },
    ...cutters.map((name) => ({ personId: idOf(name), role: 'cutter' as const, meetsOnSite: true }))
  ]

  // Seeded on today (+ the rest of this week), not the reference spec's own
  // Saturday — the whole point of dev seed data is that it's what you see
  // when the app opens, not something you have to know to click forward to
  // find. Each day is a different edge case, so the week strip actually has
  // shapes worth looking at instead of one busy day and six empty ones.
  const today = new Date()
  const dateKeyOf = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const at = (dayOffset: number, hours: number, minutes = 0) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hours, minutes)

  type ReferenceEvent = {
    event: Omit<EventRecord, 'id' | 'specialRequests'>
    specialRequests: EventRecord['specialRequests']
  }

  const referenceEvents: ReferenceEvent[] = [
    // Today — the ops spec's own reference Saturday (§14): Small Caddy and
    // Pickup each run two events; Big Caddy's fire is covered by Kurt (45
    // minutes apart, too far to bundle); the Bus sits free.
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(0, 13, 0),
        headcount: 50,
        address: '20 Beechwood Rd, Millburn, NJ',
        clientName: 'Kaplan Bar Mitzvah',
        driveMinutes: 30,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: [
        { requestType: 'gluten_free', headcount: 2 },
        { requestType: 'no_pork', headcount: 4 }
      ]
    },
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(0, 18, 45),
        headcount: 60,
        address: '412 Prospect St, Westfield, NJ',
        clientName: 'Westfield PTA Fall Fundraiser',
        driveMinutes: 20,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 20,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(0, 14, 30),
        headcount: 30,
        address: '88 Main St, Chatham, NJ',
        clientName: 'Delgado Family',
        driveMinutes: 45,
        driveMinutesBackToShop: 45,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 40,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(0, 16, 0),
        headcount: 50,
        address: '9 Elm St, Summit, NJ',
        clientName: 'Summit Medical Group',
        driveMinutes: 30,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(0, 19, 30),
        headcount: 50,
        address: '77 Oak Ave, Cranford, NJ',
        clientName: 'Nguyen 40th Anniversary',
        driveMinutes: 25,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },

    // +1 day — four rigs, fires clustered close together. Small Caddy is
    // early enough and free enough to cover Big Caddy and Pickup (all three
    // bundle into one 9:00 lighting, spec §4's "one person lights three
    // ovens"), but its own departure is 10 minutes too early to also reach
    // the Bus's handover — so the Bus lights its own, a near-miss on purpose.
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(1, 13, 0),
        headcount: 40,
        address: '14 Ridge Rd, Maplewood, NJ',
        clientName: null,
        driveMinutes: 25,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(1, 13, 15),
        headcount: 35,
        address: '201 Springfield Ave, Berkeley Heights, NJ',
        clientName: null,
        driveMinutes: 35,
        driveMinutesBackToShop: 30,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: [
        { requestType: 'vegan', headcount: 3 },
        { requestType: 'dairy_free', headcount: 2 }
      ]
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(1, 13, 30),
        headcount: 45,
        address: '55 South Ave, New Providence, NJ',
        clientName: null,
        driveMinutes: 40,
        driveMinutesBackToShop: 35,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'bus',
        firstPizzaTime: at(1, 13, 45),
        headcount: 25,
        address: '8 Highland Ave, Short Hills, NJ',
        clientName: null,
        driveMinutes: 45,
        driveMinutesBackToShop: 40,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Nick', 'Sam'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },

    // +2 days — three parties on the Pickup in one day (spec's "three
    // events" mockup): legal turnarounds throughout, but ~15 hours fire to
    // back-at-shop. A quiet Small Caddy single event runs alongside it.
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(2, 11, 30),
        headcount: 30,
        address: '120 Broad St, Summit, NJ',
        clientName: null,
        driveMinutes: 25,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(2, 15, 30),
        headcount: 40,
        address: '10 Chatham Rd, Short Hills, NJ',
        clientName: null,
        driveMinutes: 15,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(2, 20, 0),
        headcount: 50,
        address: '300 Morris Ave, Springfield, NJ',
        clientName: null,
        driveMinutes: 20,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 20,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(2, 17, 0),
        headcount: 20,
        address: '19 Lackawanna Pl, Millburn, NJ',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 30,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },

    // +3 days — late events. Small Caddy self-lights early on a short
    // window; Big Caddy's fire (11:15) is needed 45 minutes after Small
    // Caddy's crew leaves (10:35), too far to cover — the spec's own
    // "when the cover doesn't reach" reference. Pickup runs a genuinely
    // late single party, first pizza after 10pm.
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(3, 12, 0),
        headcount: 25,
        address: '6 Hobart Ave, Summit, NJ',
        clientName: null,
        driveMinutes: 25,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 90,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(3, 15, 30),
        headcount: 35,
        address: '77 Kings Rd, Madison, NJ',
        clientName: null,
        driveMinutes: 45,
        driveMinutesBackToShop: 45,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 20,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(3, 22, 30),
        headcount: 35,
        address: '450 North Ave, Garwood',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 90,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Sam', 'Nick'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },

    // +4 days — a tight turnaround on the Big Caddy: the gap between
    // parties compresses set up to 40 minutes (above the 30-minute floor,
    // below the 60-minute aim), so it's bookable but the cushion is gone.
    // Pickup runs an ordinary evening alongside it.
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(4, 12, 0),
        headcount: 30,
        address: '33 Elmer St, Westfield, NJ',
        clientName: null,
        driveMinutes: 20,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(4, 15, 35),
        headcount: 35,
        address: '210 East Broad St, Westfield, NJ',
        clientName: null,
        driveMinutes: 25,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(4, 18, 0),
        headcount: 30,
        address: '5 Colonial Ave, Cranford, NJ',
        clientName: null,
        driveMinutes: 25,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },

    // +5 days — a long spare: Small Caddy's two parties are over four hours
    // apart, so the crew waits it out at the first address rather than
    // making a pointless trip home and back. The Bus runs a normal event.
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(5, 11, 0),
        headcount: 25,
        address: '61 Church Mall, Montclair',
        clientName: null,
        driveMinutes: 20,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(5, 19, 0),
        headcount: 45,
        address: '90 Bloomfield Ave, Verona',
        clientName: null,
        driveMinutes: 15,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'bus',
        firstPizzaTime: at(5, 17, 0),
        headcount: 20,
        address: '12 Valley St, South Orange',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 30,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Nick', 'Sam'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },

    // +6 days — fully booked (0 rigs free), the rest of the special-request
    // vocabulary in use, and a fire-duty override: the Bus is pinned to
    // Matt lighting it himself regardless of what the optimizer would pick.
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(6, 12, 0),
        headcount: 30,
        address: '25 Wyoming Ave, Maplewood, NJ',
        clientName: null,
        driveMinutes: 20,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: [{ requestType: 'halal', headcount: 3 }]
    },
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(6, 13, 0),
        headcount: 25,
        address: '40 Millburn Ave, Millburn, NJ',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: [{ requestType: 'vegetarian', headcount: 5 }]
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(6, 14, 0),
        headcount: 35,
        address: '70 Central Ave, Summit, NJ',
        clientName: null,
        driveMinutes: 25,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: [{ requestType: 'paneer', headcount: 2 }]
    },
    {
      event: {
        rig: 'bus',
        firstPizzaTime: at(6, 15, 0),
        headcount: 20,
        address: '15 South St, New Providence, NJ',
        clientName: null,
        driveMinutes: 35,
        driveMinutesBackToShop: 30,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Nick', 'Sam'),
        fireDutyOverridePersonId: idOf('Matt'),
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: [{ requestType: 'spicy', headcount: 4 }]
    },

    // +7 days — extreme hours and durations: Small Caddy's fire lights at
    // 7:30am (the earliest of the week) for a short 1h30 party; Big Caddy
    // runs a genuinely long 4-hour service; Pickup serves 10:30pm-12:30am,
    // crossing midnight. All three fire independently — far enough apart
    // that none of them bundle.
    {
      event: {
        rig: 'small_caddy',
        firstPizzaTime: at(7, 11, 30),
        headcount: 25,
        address: '3 Undercliff Rd, Millburn, NJ',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 90,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Kurt', 'Leonardo'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'big_caddy',
        firstPizzaTime: at(7, 13, 0),
        headcount: 80,
        address: '250 Hobart Ave, Summit, NJ',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 25,
        serviceDurationMinutes: 240,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('Gabriel', 'Matt'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    },
    {
      event: {
        rig: 'pickup',
        firstPizzaTime: at(7, 22, 30),
        headcount: 35,
        address: '18 Elmwood Ave, Maplewood, NJ',
        clientName: null,
        driveMinutes: 30,
        driveMinutesBackToShop: 20,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0,
        assignments: crew('EJ', 'John'),
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null
      },
      specialRequests: []
    }
  ]

  const insertedEvents: EventRecord[] = []

  for (const { event, specialRequests } of referenceEvents) {
    const { assignments, ...row } = event
    const [inserted] = await database.insert(events).values(row).returning({ id: events.id })
    if (!inserted) throw new Error('[SEED] insert did not return an id')
    await database.insert(eventAssignments).values(assignments.map((seat) => ({ ...seat, eventId: inserted.id })))
    if (specialRequests.length > 0) {
      await database
        .insert(eventSpecialRequests)
        .values(specialRequests.map((request) => ({ ...request, eventId: inserted.id })))
    }
    insertedEvents.push({ id: inserted.id, ...event, specialRequests })
  }

  // Compose confirmations the same way the API does on every save, so the
  // seeded days come with real texts to look at, not just empty blocks —
  // one DayView (and one confirmations pass) per distinct date.
  const settingsRow = await database.select().from(settings).where(eq(settings.id, 'global'))
  const [settingsForView] = settingsRow
  if (!settingsForView) throw new Error('[SEED] settings row is missing')

  const dates = [...new Set(insertedEvents.map((event) => dateKeyOf(event.firstPizzaTime)))]
  const desired = dates.flatMap((dateKey) => {
    const eventsThatDay = insertedEvents.filter((event) => dateKeyOf(event.firstPizzaTime) === dateKey)
    const dayView = buildDayView(dateKey, eventsThatDay, settingsForView, allPeople)
    return computeDesiredConfirmations(dayView, allPeople, settingsForView)
  })
  await database.insert(eventConfirmations).values([...desired])

  console.log(
    `[SEED] created ${referenceEvents.length} events across ${dates.length} days and ${desired.length} confirmations`
  )
}

await database.$client.end()
process.exit(0)
