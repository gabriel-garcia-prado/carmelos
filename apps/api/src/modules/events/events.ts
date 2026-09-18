import { errAsync, ResultAsync } from 'neverthrow'
import type { AppError, DependencyError, ValidationError } from '#errors'
import type { ConsumablesSettings, ConsumablesSummary } from '../../lib/consumables'
import { computeConsumables } from '../../lib/consumables'
import type { RigFireResult } from '../../lib/fire-duty'
import { assignFireDuty } from '../../lib/fire-duty'
import type { MessageEventContext } from '../../lib/messaging'
import { composeEventMessage, composeFireDutyNote } from '../../lib/messaging'
import type { ComputedEvent, EventForScheduling, TurnaroundStatus } from '../../lib/scheduling'
import { computeRigDay } from '../../lib/scheduling'
import { addDays, addMinutes, diffMinutes, formatClockTime, toDateKey } from '../../lib/time'
import type { Viewer } from '../../lib/viewer'
import { isOwner } from '../../lib/viewer'
import type { Person } from '../people/people'
import type { Settings } from '../settings/settings'

export type Rig = 'small_caddy' | 'big_caddy' | 'pickup' | 'bus'

export const RIGS: readonly Rig[] = ['small_caddy', 'big_caddy', 'pickup', 'bus']

export const RIG_LABELS: Readonly<Record<Rig, string>> = {
  small_caddy: 'Small Caddy',
  big_caddy: 'Big Caddy',
  pickup: 'Pickup',
  bus: 'Bus'
}

export type RequestType =
  | 'gluten_free'
  | 'halal'
  | 'no_pork'
  | 'vegetarian'
  | 'vegan'
  | 'dairy_free'
  | 'paneer'
  | 'spicy'

export type SpecialRequest = Readonly<{ requestType: RequestType; headcount: number }>

export type AssignmentRole = 'pizzaiolo' | 'stick' | 'cutter'

/**
 * One person working one party.
 *
 * A party needs a pizzaiolo and a stick and can carry any number of cutters on
 * top, so this is a list rather than a fixed pair of columns — and it hangs off
 * the event rather than the rig's day, because people get replaced halfway
 * through it.
 */
export type Assignment = Readonly<{
  personId: string
  role: AssignmentRole
  /** They make their own way to the site rather than riding out with the rig. */
  meetsOnSite: boolean
}>

/** The two seats every party must fill. Cutters are extra hands on top. */
export const pizzaioloOf = (assignments: readonly Assignment[]): Assignment | undefined =>
  assignments.find((assignment) => assignment.role === 'pizzaiolo')

export const stickOf = (assignments: readonly Assignment[]): Assignment | undefined =>
  assignments.find((assignment) => assignment.role === 'stick')

export type EventRecord = Readonly<{
  id: string
  rig: Rig
  firstPizzaTime: Date
  headcount: number
  address: string
  clientName: string | null
  driveMinutes: number
  driveMinutesBackToShop: number | null
  serviceDurationMinutes: number
  setupMinutesOverride: number | null
  rackCount: number
  assignments: readonly Assignment[]
  fireDutyOverridePersonId: string | null
  crewArrivalOverrideMinutes: number | null
  truckId: string | null
  specialRequests: readonly SpecialRequest[]
}>

export type NewEvent = Omit<EventRecord, 'id'>
export type EventUpdate = Readonly<{ id: string } & Partial<NewEvent>>

export type DayEventView = Readonly<{
  id: string
  rig: Rig
  firstPizzaTime: Date
  headcount: number
  address: string
  clientName: string | null
  driveMinutes: number
  assignments: readonly Assignment[]
  fireDutyOverridePersonId: string | null
  crewArrivalOverrideMinutes: number | null
  truckId: string | null
  specialRequests: readonly SpecialRequest[]
  computed: ComputedEvent
}>

export type RigDayView = Readonly<{
  rig: Rig
  label: string
  events: readonly DayEventView[]
  backAtShopTime: Date | null
  missingReturnDrive: boolean
  fireDuty: RigFireResult | null
  // This rig's own slice of the night-before list — more useful for prep
  // than the day-wide total alone, since dough/cheese/trays get portioned
  // out per rig, not pooled.
  consumables: ConsumablesSummary
}>

/**
 * A fire the viewer has to light on a rig whose day they can't see.
 *
 * Dropping the rig is right — its bookings, client and crew are none of their
 * business — but the obligation is theirs and has to survive the cut, or the
 * board quietly stops telling someone they're due at the shop at half eight.
 * Carries the minimum the badge needs: which rig, when, and whose job it is.
 */
export type OutsideFireDuty = Readonly<{
  rig: Rig
  label: string
  litAt: Date
  litByPersonId: string
  truckId: string | null
}>

/** One person's day, added up. */
export type PersonShift = Readonly<{
  personId: string
  /**
   * Time on the clock: from when they're due in to when they're done, per
   * stretch of work, added across every rig they're on. The gap between two
   * rigs isn't counted; the wait between two parties on the SAME rig is,
   * because they stay with the truck.
   */
  minutes: number
  parties: number
  guests: number
  /** What gets made at their parties: guests plus each party's spares. */
  pizzas: number
  firstIn: Date
  lastOut: Date
}>

export type DaySummary = Readonly<{
  parties: number
  guests: number
  pizzas: number
  peopleWorking: number
  /** Everyone's hours added together — the day's labour, not its length. */
  crewMinutes: number
  /** When the first person is due in and the last one is done. */
  firstIn: Date | null
  lastOut: Date | null
  people: readonly PersonShift[]
}>

export type DayView = Readonly<{
  date: string
  rigs: readonly RigDayView[]
  consumables: ConsumablesSummary
  /** Always empty for the operator, who can see those rigs for themselves. */
  fireDutyElsewhere: readonly OutsideFireDuty[]
  summary: DaySummary
}>

const resolveRackRate = (people: readonly Person[], personId: string | undefined, fallback: number): number =>
  people.find((person) => person.id === personId)?.rackRateOverridePer30Min ?? fallback

const resolveMinutesBeforeDeparture = (
  people: readonly Person[],
  personId: string | undefined,
  fallback: number,
  rigOverride: number | null
): number => rigOverride ?? people.find((person) => person.id === personId)?.minutesBeforeDepartureOverride ?? fallback

// Takes the stored record or the built view — both carry the two fields the
// night-before arithmetic needs, and scoping a day recounts it from whatever
// events survived.
const consumablesInputFor = (rigEvents: readonly Pick<EventRecord, 'headcount' | 'specialRequests'>[]) =>
  rigEvents.map((event) => ({
    headcount: event.headcount,
    glutenFreeHeadcount: event.specialRequests
      .filter((request) => request.requestType === 'gluten_free')
      .reduce((sum, request) => sum + request.headcount, 0)
  }))

// Rack minutes come off the PIZZAIOLO's rate — it measures how fast they turn
// out pizzas, which is what the rack has to keep up with. This read the stick's
// rate until the seats were pulled apart, which only ever agreed with the truth
// when both had the shop default.
const toSchedulingEvent = (event: EventRecord, people: readonly Person[], settings: Settings): EventForScheduling => ({
  id: event.id,
  firstPizzaTime: event.firstPizzaTime,
  serviceDurationMinutes: event.serviceDurationMinutes,
  driveMinutes: event.driveMinutes,
  driveMinutesBackToShop: event.driveMinutesBackToShop,
  rackCount: event.rackCount,
  rackRatePer30Min: resolveRackRate(people, pizzaioloOf(event.assignments)?.personId, settings.defaultRackRatePer30Min),
  setupMinutesOverride: event.setupMinutesOverride
})

/** Everything derivable for one day, across all four rigs — the day view's read model and the source of truth create/update validates and re-texts against. */
export const buildDayView = (
  date: string,
  events: readonly EventRecord[],
  settings: Settings,
  people: readonly Person[]
): DayView => {
  const rigsView: RigDayView[] = RIGS.map((rig) => {
    const rigEvents = events.filter((event) => event.rig === rig)
    if (rigEvents.length === 0) {
      return {
        rig,
        label: RIG_LABELS[rig],
        events: [],
        backAtShopTime: null,
        missingReturnDrive: false,
        fireDuty: null,
        consumables: computeConsumables([], settings)
      }
    }

    const schedulingResult = computeRigDay(
      rigEvents.map((event) => toSchedulingEvent(event, people, settings)),
      settings
    )

    const eventsView: DayEventView[] = schedulingResult.events.map((computed) => {
      const source = rigEvents.find((event) => event.id === computed.id) as EventRecord
      return {
        id: source.id,
        rig,
        firstPizzaTime: source.firstPizzaTime,
        headcount: source.headcount,
        address: source.address,
        clientName: source.clientName,
        driveMinutes: source.driveMinutes,
        assignments: source.assignments,
        fireDutyOverridePersonId: source.fireDutyOverridePersonId,
        crewArrivalOverrideMinutes: source.crewArrivalOverrideMinutes,
        truckId: source.truckId,
        specialRequests: source.specialRequests,
        computed
      }
    })

    return {
      rig,
      label: RIG_LABELS[rig],
      events: eventsView,
      backAtShopTime: schedulingResult.backAtShopTime,
      missingReturnDrive: schedulingResult.missingReturnDrive,
      fireDuty: null,
      consumables: computeConsumables(consumablesInputFor(rigEvents), settings)
    }
  })

  const fireInputs = rigsView
    .filter((rigView) => rigView.events.length > 0)
    .map((rigView) => {
      const first = rigView.events[0] as DayEventView
      return {
        rigId: rigView.rig,
        naturalFireLitTime: first.computed.naturalFireLitTime as Date,
        leaveTime: first.computed.leaveTime,
        minutesBeforeDeparture: resolveMinutesBeforeDeparture(
          people,
          stickOf(first.assignments)?.personId,
          settings.defaultMinutesBeforeDeparture,
          first.crewArrivalOverrideMinutes
        ),
        // Only these two seats can hold a match — a cutter turns up for set-up,
        // hours after the fire needed lighting.
        defaultOpenerPersonId: pizzaioloOf(first.assignments)?.personId ?? '',
        crewMemberId: stickOf(first.assignments)?.personId ?? '',
        overridePersonId: events.find((event) => event.id === first.id)?.fireDutyOverridePersonId ?? null
      }
    })
  const fireByRig = new Map(
    assignFireDuty(fireInputs, settings.fireGroupingWindowMinutes).map((result) => [result.rigId, result])
  )

  const rigsWithFire = rigsView.map((rigView) =>
    rigView.events.length > 0 ? { ...rigView, fireDuty: fireByRig.get(rigView.rig) ?? null } : rigView
  )

  const consumables = computeConsumables(consumablesInputFor(events), settings)

  return {
    date,
    rigs: rigsWithFire,
    consumables,
    fireDutyElsewhere: [],
    summary: summariseDay(rigsWithFire, people, settings)
  }
}

/**
 * The same day, cut down to what this viewer is entitled to see.
 *
 * Applied to the fully built view on purpose, never by filtering events before
 * scheduling them: turnaround, fire duty and "first of day" are properties of
 * the whole rig day. A crew member looking at their 6pm shift still needs it
 * computed against the 1pm party they can't see, or the setup window they're
 * shown is one that doesn't exist.
 *
 * Rigs the viewer has nothing to do with are dropped rather than emptied —
 * an empty rig means "nothing booked", which would be a lie.
 */
export const scopeDayView = (view: DayView, viewer: Viewer, settings: ConsumablesSettings): DayView => {
  if (isOwner(viewer)) {
    return view
  }

  const { personId } = viewer
  if (personId === null) {
    return {
      ...view,
      rigs: [],
      consumables: computeConsumables([], settings),
      fireDutyElsewhere: [],
      summary: summaryOf([], NO_PARTIES)
    }
  }

  // Being sent to light another rig's fire is not a reason to see that rig's
  // day. The obligation travels with the person, and the board already carries
  // it as a badge on their own lane — the other rig's bookings, client and
  // crew are somebody else's business.
  const rigs = view.rigs.flatMap((rigView) => {
    // Any seat counts, cutters included — it's their shift too.
    const isOn = (event: DayEventView) => event.assignments.some((assignment) => assignment.personId === personId)
    if (!rigView.events.some(isOn)) {
      return []
    }

    // A pizzaiolo runs the rig, so they get its whole day: the turnaround
    // between two parties is the pressure they personally absorb, and it's
    // invisible if you only ever see one of them. Crew get the shifts they're
    // on and nothing else.
    const events = viewer.role === 'pizzaiolo' ? rigView.events : rigView.events.filter(isOn)

    return [{ ...rigView, events, consumables: computeConsumables(consumablesInputFor(events), settings) }]
  })

  // Fires owed on rigs that just got dropped. Read off the unscoped view, so
  // it sees the rigs this viewer can't.
  const fireDutyElsewhere = view.rigs.flatMap((rigView) =>
    rigView.fireDuty?.litByPersonId === personId && !rigs.some((kept) => kept.rig === rigView.rig)
      ? [
          {
            rig: rigView.rig,
            label: rigView.label,
            litAt: rigView.fireDuty.litAt,
            litByPersonId: rigView.fireDuty.litByPersonId,
            // Only for naming the truck on the badge; the rest of that rig's
            // day stays out of the response.
            truckId:
              [...rigView.events].sort(
                (first, second) => first.firstPizzaTime.getTime() - second.firstPizzaTime.getTime()
              )[0]?.truckId ?? null
          }
        ]
      : []
  )

  return {
    ...view,
    rigs,
    consumables: computeConsumables(consumablesInputFor(rigs.flatMap((rigView) => rigView.events)), settings),
    fireDutyElsewhere,
    // Their own row only, taken from the summary of the FULL day — the same
    // reason the day is built whole before it's cut: their hours depend on
    // parties they can't see. Everyone else's hours are pay-adjacent and none
    // of their business, so the totals are rebuilt from this one row rather
    // than carrying the whole operation's.
    summary: (() => {
      const own = view.summary.people.filter((shift) => shift.personId === personId)
      const mine = own[0]
      return summaryOf(own, mine ? { parties: mine.parties, guests: mine.guests, pizzas: mine.pizzas } : NO_PARTIES)
    })()
  }
}

type PartyTotals = Pick<DaySummary, 'parties' | 'guests' | 'pizzas'>

const NO_PARTIES: PartyTotals = { parties: 0, guests: 0, pizzas: 0 }

/**
 * A summary from a set of people's shifts. The party counts come in separately
 * because they can't be derived from the rows: a party worked by three people
 * appears on all three, so summing them triple-counts it.
 */
const summaryOf = (people: readonly PersonShift[], totals: PartyTotals): DaySummary => {
  const earliest = people.map((shift) => shift.firstIn.getTime())
  const latest = people.map((shift) => shift.lastOut.getTime())
  return {
    ...totals,
    peopleWorking: people.length,
    crewMinutes: people.reduce((sum, shift) => sum + shift.minutes, 0),
    firstIn: earliest.length > 0 ? new Date(Math.min(...earliest)) : null,
    lastOut: latest.length > 0 ? new Date(Math.max(...latest)) : null,
    people
  }
}

/**
 * Hours, parties and pizzas for everyone working the day.
 *
 * A person's time is built in runs: consecutive parties they work on the same
 * rig join into one, because they don't leave the truck in between — the
 * spare time between two parties is still on the clock. A run starts when
 * they're due in (the same rule as their texts, so the two can't disagree)
 * and ends at pack-down, or back at the shop if they rode out with the truck
 * and the run takes them to its last party. Someone who made their own way
 * drives themselves home, and that isn't counted.
 *
 * Lighting another rig's fire counts too: it's why they came in early.
 */
export const summariseDay = (
  rigs: readonly RigDayView[],
  people: readonly Person[],
  settings: Settings
): DaySummary => {
  type Run = { start: Date; end: Date; rodeOut: boolean }
  type Tally = { runs: Run[]; parties: number; guests: number; pizzas: number }
  const tallies = new Map<string, Tally>()
  const tallyFor = (personId: string): Tally => {
    const existing = tallies.get(personId)
    if (existing) return existing
    const created: Tally = { runs: [], parties: 0, guests: 0, pizzas: 0 }
    tallies.set(personId, created)
    return created
  }

  // Day-level counts are per party, never per person, or a party worked by
  // three people would be counted three times.
  let parties = 0
  let guests = 0
  let pizzas = 0

  for (const rigView of rigs) {
    const open = new Map<string, Run>()

    for (const [index, eventView] of rigView.events.entries()) {
      const previous = rigView.events[index - 1]
      const fireDuty = eventView.computed.isFirstOfDay ? rigView.fireDuty : null
      const partyPizzas = eventView.headcount + settings.sparePizzasPerEvent
      parties += 1
      guests += eventView.headcount
      pizzas += partyPizzas

      // Anyone whose run was open but isn't on this party left after the
      // last one's pack-down.
      const onThisParty = new Set(eventView.assignments.map((seat) => seat.personId))
      for (const [personId, run] of open) {
        if (onThisParty.has(personId)) continue
        tallyFor(personId).runs.push(run)
        open.delete(personId)
      }

      for (const assignment of eventView.assignments) {
        const tally = tallyFor(assignment.personId)
        tally.parties += 1
        tally.guests += eventView.headcount
        tally.pizzas += partyPizzas

        const run = open.get(assignment.personId)
        if (run) {
          run.end = eventView.computed.breakDownFinishTime
          continue
        }
        open.set(assignment.personId, {
          start: arrivalTimeFor(eventView, previous, fireDuty, assignment, people, settings),
          end: eventView.computed.breakDownFinishTime,
          rodeOut: !arrivesOnSite(eventView, previous, assignment)
        })
      }
    }

    // Still open means they worked the rig's last party. On the truck, they
    // ride it home and are done when it's back; in their own car, they're
    // done at pack-down.
    for (const [personId, run] of open) {
      tallyFor(personId).runs.push(
        run.rodeOut && rigView.backAtShopTime ? { ...run, end: rigView.backAtShopTime } : run
      )
    }
  }

  // A fire lit for another rig brings someone in before their own work starts.
  for (const rigView of rigs) {
    const fire = rigView.fireDuty
    const tally = fire ? tallies.get(fire.litByPersonId) : undefined
    if (!fire || !tally) continue
    const first = [...tally.runs].sort((a, b) => a.start.getTime() - b.start.getTime())[0]
    if (first && fire.litAt.getTime() < first.start.getTime()) first.start = fire.litAt
  }

  const shifts: PersonShift[] = [...tallies.entries()].map(([personId, tally]) => ({
    personId,
    minutes: tally.runs.reduce((sum, run) => sum + diffMinutes(run.end, run.start), 0),
    parties: tally.parties,
    guests: tally.guests,
    pizzas: tally.pizzas,
    firstIn: new Date(Math.min(...tally.runs.map((run) => run.start.getTime()))),
    lastOut: new Date(Math.max(...tally.runs.map((run) => run.end.getTime())))
  }))

  return summaryOf(shifts, { parties, guests, pizzas })
}

/**
 * When one person is personally due at one party — which is not always when
 * the rig moves. Three ways in, in order of precedence:
 *
 * - they make their own way, so they're due on site for the start of set-up.
 *   It's done together, which is why it's the on-site moment and not first
 *   pizza;
 * - they're lighting the fire, so they're due at it;
 * - otherwise they ride out with the rig: from the shop on its first run of
 *   the day, their own lead time before it leaves, or straight from the last
 *   party on any run after that.
 *
 * Shared by the texts and the overlap check on purpose. If they disagreed, the
 * app would tell someone to be somewhere it had already decided they couldn't
 * be.
 */
export const arrivesOnSite = (
  eventView: DayEventView,
  previous: DayEventView | undefined,
  assignment: Assignment
): boolean => {
  if (assignment.meetsOnSite) return true
  if (eventView.computed.isFirstOfDay) return false
  // Joining a party partway through the rig's day, having not worked the one
  // before it: there was no truck to ride out on. It was at the last party,
  // where this person wasn't. So they make their own way, and this is derived
  // rather than left to the flag — a stale record or a forgotten checkbox
  // would otherwise tell someone to be at a departure they cannot reach.
  return !previous?.assignments.some((seat) => seat.personId === assignment.personId)
}

export const arrivalTimeFor = (
  eventView: DayEventView,
  previous: DayEventView | undefined,
  fireDuty: RigFireResult | null,
  assignment: Assignment,
  people: readonly Person[],
  settings: Settings
): Date => {
  // Set-up is done together, so it's the on-site moment and not first pizza.
  if (arrivesOnSite(eventView, previous, assignment)) return eventView.computed.onSiteTime

  const isFirstOfDay = eventView.computed.isFirstOfDay
  if (isFirstOfDay && fireDuty !== null && fireDuty.litByPersonId === assignment.personId) return fireDuty.litAt
  // Carrying on from the last party: the rig is already loaded and moving, so
  // the moment it leaves is the moment.
  if (!isFirstOfDay) return eventView.computed.leaveTime

  return assignment.role === 'pizzaiolo'
    ? (fireDuty?.ownArrivalTime ?? eventView.computed.leaveTime)
    : addMinutes(
        eventView.computed.leaveTime,
        -resolveMinutesBeforeDeparture(
          people,
          assignment.personId,
          settings.defaultMinutesBeforeDeparture,
          eventView.crewArrivalOverrideMinutes
        )
      )
}

/**
 * The stretch of the day one person owes to one party: from when they're due
 * until the pack-down is finished. Leaving halfway through the day still means
 * staying to break down, so the end is never earlier than that.
 */
type PersonWindow = Readonly<{ personId: string; rig: Rig; from: Date; to: Date }>

const personWindows = (dayView: DayView, people: readonly Person[], settings: Settings): readonly PersonWindow[] =>
  dayView.rigs.flatMap((rigView) =>
    rigView.events.flatMap((eventView, index) =>
      eventView.assignments.map((assignment) => ({
        personId: assignment.personId,
        rig: rigView.rig,
        from: arrivalTimeFor(
          eventView,
          rigView.events[index - 1],
          eventView.computed.isFirstOfDay ? rigView.fireDuty : null,
          assignment,
          people,
          settings
        ),
        to: eventView.computed.breakDownFinishTime
      }))
    )
  )

/**
 * Nobody can be in two places at once.
 *
 * This replaces a flat "already on another rig today" refusal, which ruled out
 * the thing it was meant to allow: finishing with one rig and going out with
 * another that leaves later is an ordinary day, and so is handing a party over
 * to a stick who could only do the afternoon.
 *
 * It deliberately does NOT measure how long it takes to drive between two
 * sites — only that the commitments don't overlap. A five-minute gap between
 * two towns will be allowed; whoever is building the day knows the roads.
 */
const findPersonOverlap = (dayView: DayView, people: readonly Person[], settings: Settings): ValidationError | null => {
  const byPerson = new Map<string, PersonWindow[]>()
  for (const window of personWindows(dayView, people, settings)) {
    byPerson.set(window.personId, [...(byPerson.get(window.personId) ?? []), window])
  }

  for (const [personId, windows] of byPerson) {
    const sorted = [...windows].sort((first, second) => first.from.getTime() - second.from.getTime())
    for (const [index, window] of sorted.entries()) {
      const next = sorted[index + 1]
      if (!next || next.from.getTime() >= window.to.getTime()) continue

      const personName = people.find((person) => person.id === personId)?.name ?? 'That person'
      return {
        type: 'ValidationError',
        message: `${personName} is on ${RIG_LABELS[window.rig]} until ${formatClockTime(window.to)} and due on ${RIG_LABELS[next.rig]} at ${formatClockTime(next.from)}. One of those has to move.`,
        input: { personId, rigs: [window.rig, next.rig] }
      }
    }
  }

  return null
}

export type DesiredConfirmation = Readonly<{
  eventId: string
  personId: string
  role: 'pizzaiolo' | 'crew' | 'cutter' | 'fire_duty'
  messageBody: string
}>

/** Which (event, person, role) confirmations should exist for a day, and what they should say — diffed against storage by the caller so only changed messages reset to `pending` (spec §10/§15). */
export const computeDesiredConfirmations = (
  dayView: DayView,
  people: readonly Person[],
  settings: Settings
): readonly DesiredConfirmation[] => {
  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? 'Unknown'
  const phoneOf = (id: string) => people.find((person) => person.id === id)?.phone ?? ''
  const _minutesBeforeDepartureOf = (id: string, rigOverride: number | null) =>
    resolveMinutesBeforeDeparture(people, id, settings.defaultMinutesBeforeDeparture, rigOverride)

  const desired: DesiredConfirmation[] = []

  for (const rigView of dayView.rigs) {
    for (const [eventIndex, eventView] of rigView.events.entries()) {
      const previousOnRig = rigView.events[eventIndex - 1]
      const isFirstOfDay = eventView.computed.isFirstOfDay
      const fireDuty = isFirstOfDay ? rigView.fireDuty : null
      const isCoveredByOther = fireDuty?.isCovered

      const eventContext: MessageEventContext = {
        rigLabel: rigView.label,
        firstPizzaTime: eventView.firstPizzaTime,
        headcount: eventView.headcount,
        address: eventView.address,
        leaveTime: eventView.computed.leaveTime,
        driveMinutes: eventView.driveMinutes,
        specialRequests: eventView.specialRequests
      }

      // Who actually strikes the match decides who comes in early — it's the
      // pizzaiolo most days, but the match can be handed to the stick just as
      // well, and then the two of them swap arrival times.
      const lightsFire = (personId: string) => isFirstOfDay && fireDuty !== null && fireDuty.litByPersonId === personId
      const fireReadyTime = fireDuty ? addMinutes(fireDuty.litAt, settings.ovenToTempMinutes) : null

      const arrivalFor = (assignment: Assignment): Date =>
        arrivalTimeFor(eventView, previousOnRig, fireDuty, assignment, people, settings)

      // 'stick' is written as 'crew' on a confirmation — the stored enum
      // predates the seat names and renaming it would cost a data migration
      // for no gain.
      const confirmationRole = (role: AssignmentRole) => (role === 'stick' ? ('crew' as const) : role)

      for (const assignment of eventView.assignments) {
        const coworkers = eventView.assignments.filter((other) => other.personId !== assignment.personId)
        desired.push({
          eventId: eventView.id,
          personId: assignment.personId,
          role: confirmationRole(assignment.role),
          messageBody: composeEventMessage({
            role: confirmationRole(assignment.role),
            arrivalTime: arrivalFor(assignment),
            isLightingFire: lightsFire(assignment.personId),
            fireReadyTime: lightsFire(assignment.personId) ? fireReadyTime : null,
            meetsOnSite: arrivesOnSite(eventView, previousOnRig, assignment),
            coworkers: coworkers.map((other) => ({
              name: nameOf(other.personId),
              phone: phoneOf(other.personId)
            })),
            event: eventContext
          })
        })
      }

      const pizzaioloLighting = lightsFire(pizzaioloOf(eventView.assignments)?.personId ?? '')
      const crewLighting = lightsFire(stickOf(eventView.assignments)?.personId ?? '')

      // The separate "also go light X" note is for someone coming from
      // ANOTHER rig. This rig's own crew member lighting its own fire already
      // has the instruction in their own message — a second note would just
      // tell them twice.
      const litByOwnCrew = pizzaioloLighting || crewLighting
      if (isFirstOfDay && isCoveredByOther && fireDuty && !litByOwnCrew) {
        desired.push({
          eventId: eventView.id,
          personId: fireDuty.litByPersonId,
          role: 'fire_duty',
          messageBody: composeFireDutyNote({
            coveredRigLabel: rigView.label,
            litAt: fireDuty.litAt,
            handoverTime: fireDuty.ownArrivalTime
          })
        })
      }
    }
  }

  return desired
}

export type PreviewInput = Readonly<{
  // Present when editing an existing event, so it's excluded from "existing
  // events on this rig/day" rather than colliding with itself.
  id?: string
  rig: Rig
  firstPizzaTime: Date
  driveMinutes: number
  driveMinutesBackToShop: number | null
  serviceDurationMinutes: number
  setupMinutesOverride: number | null
  rackCount: number
}>

export type TurnaroundPreview = Readonly<{
  turnaround: TurnaroundStatus | null
  /**
   * The earliest first pizza that leaves the WHOLE rig day workable, not just
   * the draft's own slot. A per-event earliest is no use as advice: moving the
   * draft to it can push the NEXT party over, which produces a fresh number,
   * and following those in turn walks the booking down the day without ever
   * landing. Every value returned here has been scheduled and checked.
   *
   * Null when no slot on this rig works at all.
   */
  earliestFirstPizzaTime: Date | null
  /**
   * The existing party this draft would break. Set only when the draft itself
   * fits and something else gives way because of it - a different problem
   * with a different fix, so it can't be reported as the draft's own time.
   */
  blockedBy: Readonly<{ clientName: string | null; firstPizzaTime: Date }> | null
  /** The chosen rig's whole day with the draft folded into it, already
   * scheduled. The merge happens here anyway to work out the turnaround, so
   * handing it back lets the form DRAW the placement with the same block
   * builder the board uses, instead of only describing it in a sentence. */
  rigDay: RigDayView | null
  /** Which event in `rigDay` is the draft — the form outlines that one. */
  draftEventId: string
}>

export type PreviewDependencies = Readonly<{
  fetchEventsForDate: (date: string) => ResultAsync<readonly EventRecord[], DependencyError>
  fetchSettings: () => ResultAsync<Settings, DependencyError>
  fetchPeople: () => ResultAsync<readonly Person[], DependencyError>
}>

const DRAFT_ID = '__draft__'

/** Whether a draft event (not yet saved, maybe not even fully filled in) would fit on its rig's day — for a live green/yellow/red hint on the form, not persisted anywhere. */
export const previewTurnaround =
  (dependencies: PreviewDependencies) =>
  (input: PreviewInput): ResultAsync<TurnaroundPreview, DependencyError> => {
    const date = toDateKey(input.firstPizzaTime)
    const draftId = input.id ?? DRAFT_ID

    return ResultAsync.combine([
      dependencies.fetchEventsForDate(date),
      dependencies.fetchSettings(),
      dependencies.fetchPeople()
    ]).map(([existingEvents, settings, people]) => {
      const draft: EventRecord = {
        id: draftId,
        rig: input.rig,
        firstPizzaTime: input.firstPizzaTime,
        headcount: 0,
        address: '',
        clientName: null,
        driveMinutes: input.driveMinutes,
        driveMinutesBackToShop: input.driveMinutesBackToShop,
        serviceDurationMinutes: input.serviceDurationMinutes,
        setupMinutesOverride: input.setupMinutesOverride,
        rackCount: input.rackCount,
        // The draft is only ever scheduled, never saved or texted, so it needs
        // no-one in its seats — the rack rate falls back to the shop default,
        // which is the honest answer before anyone is picked.
        assignments: [],
        fireDutyOverridePersonId: null,
        crewArrivalOverrideMinutes: null,
        truckId: null,
        specialRequests: []
      }
      const others = existingEvents.filter((event) => event.id !== draftId)

      /** This rig's day with the draft moved to `firstPizzaTime`. */
      const rigViewAt = (firstPizzaTime: Date): RigDayView | null =>
        buildDayView(date, [...others, { ...draft, firstPizzaTime }], settings, people).rigs.find(
          (rigView) => rigView.rig === input.rig
        ) ?? null

      const scheduleAt = (firstPizzaTime: Date): readonly DayEventView[] => rigViewAt(firstPizzaTime)?.events ?? []

      const brokenIn = (events: readonly DayEventView[]) => events.find((event) => event.computed.turnaround === 'bad')

      const rigDayEvents = scheduleAt(input.firstPizzaTime)
      const draftComputed = rigDayEvents.find((event) => event.id === draftId)?.computed
      // Same reflow concern as the real save: the draft can look fine on its
      // own while quietly making an EXISTING event on the rig impossible —
      // that must show as red too, not just the draft's own slot.
      const brokenEvent = brokenIn(rigDayEvents)
      const rigDay = rigViewAt(input.firstPizzaTime)

      if (!brokenEvent) {
        return {
          turnaround: draftComputed?.turnaround ?? null,
          earliestFirstPizzaTime: null,
          blockedBy: null,
          rigDay,
          draftEventId: draftId
        }
      }

      /**
       * The earliest first pizza that leaves nothing on the rig broken.
       *
       * One candidate per gap after an existing party. Landing the draft on
       * that party's service end is deliberately far too early, which makes the
       * scheduler hand back the exact lower bound for that gap; there is no
       * point trying anything later within the same gap, because moving the
       * draft later only squeezes whatever follows it. Each candidate is then
       * scheduled for real and kept only if the whole day comes back clean.
       */
      const earliestWorkable = (): Date | null => {
        const candidates = others
          .filter((event) => event.rig === input.rig)
          .flatMap((event) => {
            const probe = scheduleAt(addMinutes(event.firstPizzaTime, event.serviceDurationMinutes))
            const lower = probe.find((candidate) => candidate.id === draftId)?.computed.earliestFirstPizzaTime
            return lower ? [lower] : []
          })
          .sort((first, second) => first.getTime() - second.getTime())

        return candidates.find((candidate) => !brokenIn(scheduleAt(candidate))) ?? null
      }

      return {
        turnaround: 'bad',
        earliestFirstPizzaTime: earliestWorkable(),
        // Naming the casualty only makes sense while the draft itself is fine;
        // otherwise the draft is its own problem and the earliest time says so.
        blockedBy:
          brokenEvent.id === draftId
            ? null
            : { clientName: brokenEvent.clientName, firstPizzaTime: brokenEvent.firstPizzaTime },
        rigDay,
        draftEventId: draftId
      }
    })
  }

export type GetDayViewDependencies = Readonly<{
  fetchEventsForDate: (date: string) => ResultAsync<readonly EventRecord[], DependencyError>
  fetchSettings: () => ResultAsync<Settings, DependencyError>
  fetchPeople: () => ResultAsync<readonly Person[], DependencyError>
}>

// Scoping happens here rather than in the handler so it can't be forgotten:
// there is no way to get a day view out of this module without saying who
// it's for.
export const getDayView =
  (dependencies: GetDayViewDependencies) =>
  (date: string, viewer: Viewer): ResultAsync<DayView, DependencyError> =>
    ResultAsync.combine([
      dependencies.fetchEventsForDate(date),
      dependencies.fetchSettings(),
      dependencies.fetchPeople()
    ]).map(([events, settings, people]) => scopeDayView(buildDayView(date, events, settings, people), viewer, settings))

export type GetWeekViewDependencies = Readonly<{
  fetchEventsForRange: (
    startDate: string,
    endDateExclusive: string
  ) => ResultAsync<readonly EventRecord[], DependencyError>
  fetchSettings: () => ResultAsync<Settings, DependencyError>
  fetchPeople: () => ResultAsync<readonly Person[], DependencyError>
}>

export type GetEventDependencies = Readonly<{
  fetchEventById: (id: string) => ResultAsync<EventRecord, DependencyError>
}>

export const getEvent =
  (dependencies: GetEventDependencies) =>
  (id: string): ResultAsync<EventRecord, DependencyError> =>
    dependencies.fetchEventById(id)

export const getWeekView =
  (dependencies: GetWeekViewDependencies) =>
  (startDate: string, viewer: Viewer): ResultAsync<readonly DayView[], DependencyError> =>
    ResultAsync.combine([
      dependencies.fetchEventsForRange(startDate, addDays(startDate, 7)),
      dependencies.fetchSettings(),
      dependencies.fetchPeople()
    ]).map(([events, settings, people]) =>
      Array.from({ length: 7 }, (_, offset) => {
        const date = addDays(startDate, offset)
        const eventsThatDay = events.filter((event) => toDateKey(event.firstPizzaTime) === date)
        return scopeDayView(buildDayView(date, eventsThatDay, settings, people), viewer, settings)
      })
    )

export type WriteDependencies = Readonly<{
  generateId: () => string
  fetchEventsForDate: (date: string) => ResultAsync<readonly EventRecord[], DependencyError>
  fetchSettings: () => ResultAsync<Settings, DependencyError>
  fetchPeople: () => ResultAsync<readonly Person[], DependencyError>
  persistEvent: (event: EventRecord) => ResultAsync<EventRecord, DependencyError>
  applyConfirmations: (date: string, desired: readonly DesiredConfirmation[]) => ResultAsync<void, DependencyError>
}>

// A rig's crew is exclusive for the whole day (spec: one truck, one route —
// nobody splits a day across two rigs), so a person already booked on a
// DIFFERENT rig that date can't also be assigned here, regardless of
// whether the two rigs' own times happen to overlap. This is the
// server-side half of the rule the event form already enforces by hiding
// those people from the pizzaiolo/crew pickers — that hiding is UX only, so
// this is the actual gate a direct save (or a bulk crew change) can't skip.
/**
 * Every party runs with exactly one pizzaiolo and exactly one stick, plus any
 * number of cutters. Nobody works two seats on the same party, the pizzaiolo
 * seat needs someone who can run a rig, and the stick seat needs someone who
 * isn't cutters-only.
 */
const findSeatProblem = (event: EventRecord, people: readonly Person[]): ValidationError | null => {
  const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? 'That person'
  const problem = (message: string): ValidationError => ({
    type: 'ValidationError',
    message,
    input: { eventId: event.id }
  })

  const pizzaiolos = event.assignments.filter((assignment) => assignment.role === 'pizzaiolo')
  const sticks = event.assignments.filter((assignment) => assignment.role === 'stick')

  if (pizzaiolos.length !== 1) {
    return problem(
      pizzaiolos.length === 0
        ? 'This party has no pizzaiolo. Every party needs one.'
        : 'This party has more than one pizzaiolo. Only one runs the oven.'
    )
  }
  if (sticks.length !== 1) {
    return problem(
      sticks.length === 0
        ? 'This party has no stick. Every party needs one.'
        : 'This party has more than one stick. Add the extra hands as cutters instead.'
    )
  }

  const personIds = event.assignments.map((assignment) => assignment.personId)
  const duplicate = personIds.find((personId, index) => personIds.indexOf(personId) !== index)
  if (duplicate) {
    return problem(`${nameOf(duplicate)} is on this party twice. One job each.`)
  }

  const pizzaioloId = (pizzaiolos[0] as Assignment).personId
  if (!people.find((person) => person.id === pizzaioloId)?.isPizzaiolo) {
    return problem(`${nameOf(pizzaioloId)} isn't a pizzaiolo. Pick someone who can run a rig.`)
  }

  const stickId = (sticks[0] as Assignment).personId
  if (!people.find((person) => person.id === stickId)?.canStick) {
    return problem(`${nameOf(stickId)} only cuts. Put them on as a cutter and pick someone else for the stick.`)
  }

  return null
}

const saveAndSync = (dependencies: WriteDependencies, event: EventRecord): ResultAsync<EventRecord, AppError> => {
  const date = toDateKey(event.firstPizzaTime)

  return ResultAsync.combine([
    dependencies.fetchEventsForDate(date),
    dependencies.fetchSettings(),
    dependencies.fetchPeople()
  ]).andThen(([existingEvents, settings, people]) => {
    const dayEvents = [...existingEvents.filter((existing) => existing.id !== event.id), event]

    const seatProblem = findSeatProblem(event, people)
    if (seatProblem) return errAsync(seatProblem)

    const dayView = buildDayView(date, dayEvents, settings, people)

    // Checked against the built day, not the raw rows: a person's window
    // depends on the times the scheduler works out, and half of them only
    // exist once the rig's chain has been computed.
    const overlap = findPersonOverlap(dayView, people, settings)
    if (overlap) return errAsync(overlap)

    const rigDayEvents = dayView.rigs.find((rig) => rig.rig === event.rig)?.events ?? []
    // Inserting this event earlier in the rig's day reflows every event that
    // comes after it — checking only this event's own turnaround missed the
    // case where it makes an EXISTING event's gap impossible instead (e.g.
    // saving an event at the same time as, or shortly before, one already on
    // the rig let both through, since each looked fine from its own side).
    const brokenEvent = rigDayEvents.find((eventView) => eventView.computed.turnaround === 'bad')

    if (brokenEvent?.computed.earliestFirstPizzaTime) {
      const clockTime = (at: Date) =>
        at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      const earliest = clockTime(brokenEvent.computed.earliestFirstPizzaTime)
      const message =
        brokenEvent.id === event.id
          ? `This turnaround can't be reached — earliest honest first pizza is ${earliest}. Put it on a free rig or move the time.`
          : `This would make ${RIG_LABELS[event.rig]}'s ${clockTime(brokenEvent.firstPizzaTime)} party impossible to reach — earliest honest first pizza for it would be ${earliest}. Pick a different time or rig.`
      const validationError: ValidationError = {
        type: 'ValidationError',
        message,
        input: { earliestFirstPizzaTime: brokenEvent.computed.earliestFirstPizzaTime }
      }
      return errAsync(validationError)
    }

    return dependencies.persistEvent(event).andThen((saved) => {
      const savedDayEvents = dayEvents.map((dayEvent) => (dayEvent.id === saved.id ? saved : dayEvent))
      const savedDayView = buildDayView(date, savedDayEvents, settings, people)
      const desired = computeDesiredConfirmations(savedDayView, people, settings)
      return dependencies.applyConfirmations(date, desired).map(() => saved)
    })
  })
}

/** Who's on this rig today. The rig owns its crew, so a new event inherits
 * whatever the rig already runs that day rather than asking again; only the
 * first event of a rig's day has nobody to inherit from, and that falls back
 * to whoever isn't already committed elsewhere for Billy to adjust from the
 * rig's own "Edit crew". */
const resolveRigCrew = (
  dayEvents: readonly EventRecord[],
  rig: Rig,
  people: readonly Person[]
): readonly Assignment[] | null => {
  // Inherit the rig's LATEST party, not its first: if the crew changed partway
  // through the day, a new party follows whoever is on it now rather than
  // whoever started the morning.
  const existing = [...dayEvents]
    .filter((event) => event.rig === rig)
    .sort((first, second) => second.firstPizzaTime.getTime() - first.firstPizzaTime.getTime())[0]
  if (existing) return existing.assignments

  const committed = new Set(dayEvents.flatMap((event) => event.assignments.map((seat) => seat.personId)))
  const pizzaiolo = people.find((person) => person.isPizzaiolo && !committed.has(person.id))
  const stick = people.find((person) => person.canStick && !committed.has(person.id) && person.id !== pizzaiolo?.id)
  return pizzaiolo && stick
    ? [
        { personId: pizzaiolo.id, role: 'pizzaiolo' as const, meetsOnSite: false },
        { personId: stick.id, role: 'stick' as const, meetsOnSite: false }
      ]
    : null
}

/** A create payload with the rig-owned fields left out — the caller states
 * what the party is, the rig says who runs it. */
export type NewEventInput = Omit<NewEvent, 'assignments'> & Readonly<{ assignments?: readonly Assignment[] }>

export const createEvent =
  (dependencies: WriteDependencies) =>
  (input: NewEventInput): ResultAsync<EventRecord, AppError> => {
    // A named crew stands on its own — only reach for the rig's when the caller
    // didn't give one, so "nobody is free" can never pre-empt the real checks
    // in `saveAndSync`.
    const named = input.assignments
    if (named && named.length > 0) {
      return saveAndSync(dependencies, { id: dependencies.generateId(), ...input, assignments: named })
    }

    const date = toDateKey(input.firstPizzaTime)
    return ResultAsync.combine([dependencies.fetchEventsForDate(date), dependencies.fetchPeople()]).andThen(
      ([dayEvents, people]) => {
        const assignments = resolveRigCrew(dayEvents, input.rig, people)
        if (!assignments) {
          const validationError: ValidationError = {
            type: 'ValidationError',
            message: `Nobody is free to run ${RIG_LABELS[input.rig]} — everyone else is already on a party.`,
            input
          }
          return errAsync(validationError)
        }
        return saveAndSync(dependencies, { id: dependencies.generateId(), ...input, assignments })
      }
    )
  }

export type UpdateDependencies = WriteDependencies &
  Readonly<{
    fetchEventById: (id: string) => ResultAsync<EventRecord, DependencyError>
  }>

export const updateEvent =
  (dependencies: UpdateDependencies) =>
  (input: EventUpdate): ResultAsync<EventRecord, AppError> =>
    dependencies.fetchEventById(input.id).andThen((existing) => saveAndSync(dependencies, { ...existing, ...input }))

export type PartyCrew = Readonly<{ eventId: string; assignments: readonly Assignment[] }>

export type RigCrewInput = Readonly<{
  date: string
  rig: Rig
  /**
   * Who works each party on this rig, one entry per party being changed.
   *
   * A list rather than one crew plus an optional "just this one" flag: most
   * days every entry is identical and it reads as a single change, but the day
   * a stick only does the afternoon the two answers arrive together and land
   * together. Splitting that into a call per party would let the day sit
   * halfway between two valid states, with the overlap check passing judgement
   * on a moment that never really existed.
   */
  parties: readonly PartyCrew[]
  fireDutyOverridePersonId: string | null
  crewArrivalOverrideMinutes: number | null
  truckId: string | null
}>

/** Sets who works a rig: every party on it by default, or one named party. */
export const updateRigCrew =
  (dependencies: WriteDependencies) =>
  (input: RigCrewInput): ResultAsync<readonly EventRecord[], AppError> =>
    ResultAsync.combine([
      dependencies.fetchEventsForDate(input.date),
      dependencies.fetchSettings(),
      dependencies.fetchPeople()
    ]).andThen(([events, settings, people]) => {
      const rigEvents = events.filter((event) => event.rig === input.rig)
      if (rigEvents.length === 0) {
        return errAsync({
          type: 'ValidationError' as const,
          message: `${RIG_LABELS[input.rig]} has no events today to update.`,
          input
        })
      }
      const stray = input.parties.find((party) => !rigEvents.some((event) => event.id === party.eventId))
      if (stray) {
        return errAsync({
          type: 'ValidationError' as const,
          message: `That party isn't on ${RIG_LABELS[input.rig]} today.`,
          input
        })
      }

      // A truck is a physical thing — two rigs can't take the same one out. So
      // picking a truck another rig is already on trades vehicles with it
      // rather than double-booking it. People are no longer swapped this way:
      // somebody can work two rigs in a day now, so bringing them in doesn't
      // have to push anyone out. The overlap check decides whether it's
      // possible, not a shuffle of seats.
      const earliestFor = (rig: Rig): EventRecord | undefined =>
        events
          .filter((event) => event.rig === rig)
          .sort((a, b) => a.firstPizzaTime.getTime() - b.firstPizzaTime.getTime())[0]
      const truckOf = (rig: Rig): string => earliestFor(rig)?.truckId ?? rig
      const givingUp = truckOf(input.rig)
      const displacedRig =
        input.truckId && input.truckId !== givingUp
          ? RIGS.find((rig) => rig !== input.rig && truckOf(rig) === input.truckId && earliestFor(rig))
          : undefined
      const displacedFirstId = displacedRig ? earliestFor(displacedRig)?.id : undefined

      const displacedEvents = events
        .filter((event) => event.rig === displacedRig)
        .map((event) => ({
          ...event,
          // Only the displaced rig's own first event carries the traded truck;
          // its later events stay null, same rule as this rig's.
          truckId: event.id === displacedFirstId ? givingUp : null
        }))

      // The overrides are only ever read off the day's first event for the rig
      // (see fireInputs above) — set them there and clear them elsewhere so a
      // stale value can't linger on an event that used to be first.
      const earliestEventId = [...rigEvents].sort((a, b) => a.firstPizzaTime.getTime() - b.firstPizzaTime.getTime())[0]
        ?.id
      const updatedEvents = rigEvents.map((event) => ({
        ...event,
        assignments: input.parties.find((party) => party.eventId === event.id)?.assignments ?? event.assignments,
        fireDutyOverridePersonId: event.id === earliestEventId ? input.fireDutyOverridePersonId : null,
        crewArrivalOverrideMinutes: event.id === earliestEventId ? input.crewArrivalOverrideMinutes : null,
        truckId: event.id === earliestEventId ? input.truckId : null
      }))

      const seatProblem = updatedEvents.map((event) => findSeatProblem(event, people)).find(Boolean)
      if (seatProblem) return errAsync(seatProblem)

      const dayAhead = events.map(
        (event) =>
          updatedEvents.find((updated) => updated.id === event.id) ??
          displacedEvents.find((displaced) => displaced.id === event.id) ??
          event
      )
      const overlap = findPersonOverlap(buildDayView(input.date, dayAhead, settings, people), people, settings)
      if (overlap) return errAsync(overlap)

      const allWrites = [...updatedEvents, ...displacedEvents]
      return ResultAsync.combine(allWrites.map((event) => dependencies.persistEvent(event))).andThen((saved) => {
        const savedById = new Map(saved.map((event) => [event.id, event]))
        const dayAfter = events.map((event) => savedById.get(event.id) ?? event)
        const savedDayView = buildDayView(input.date, dayAfter, settings, people)
        const desired = computeDesiredConfirmations(savedDayView, people, settings)
        return dependencies
          .applyConfirmations(input.date, desired)
          .map(() => saved.filter((event) => event.rig === input.rig))
      })
    })

export type DeleteDependencies = Readonly<{
  fetchEventById: (id: string) => ResultAsync<EventRecord, DependencyError>
  fetchEventsForDate: (date: string) => ResultAsync<readonly EventRecord[], DependencyError>
  fetchSettings: () => ResultAsync<Settings, DependencyError>
  fetchPeople: () => ResultAsync<readonly Person[], DependencyError>
  removeEvent: (id: string) => ResultAsync<void, DependencyError>
  applyConfirmations: (date: string, desired: readonly DesiredConfirmation[]) => ResultAsync<void, DependencyError>
}>

export const deleteEvent =
  (dependencies: DeleteDependencies) =>
  (id: string): ResultAsync<void, DependencyError> =>
    dependencies.fetchEventById(id).andThen((existing) => {
      const date = toDateKey(existing.firstPizzaTime)
      return dependencies.removeEvent(id).andThen(() =>
        ResultAsync.combine([
          dependencies.fetchEventsForDate(date),
          dependencies.fetchSettings(),
          dependencies.fetchPeople()
        ]).andThen(([remaining, settings, people]) => {
          const dayView = buildDayView(date, remaining, settings, people)
          const desired = computeDesiredConfirmations(dayView, people, settings)
          return dependencies.applyConfirmations(date, desired)
        })
      )
    })
