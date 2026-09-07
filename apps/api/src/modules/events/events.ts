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
import { addDays, addMinutes, toDateKey } from '../../lib/time'
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
  pizzaioloId: string
  crewMemberId: string
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
  pizzaioloId: string
  crewMemberId: string
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

export type DayView = Readonly<{
  date: string
  rigs: readonly RigDayView[]
  consumables: ConsumablesSummary
  /** Always empty for the operator, who can see those rigs for themselves. */
  fireDutyElsewhere: readonly OutsideFireDuty[]
}>

const resolveRackRate = (people: readonly Person[], personId: string, fallback: number): number =>
  people.find((person) => person.id === personId)?.rackRateOverridePer30Min ?? fallback

const resolveMinutesBeforeDeparture = (
  people: readonly Person[],
  personId: string,
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

const toSchedulingEvent = (event: EventRecord, people: readonly Person[], settings: Settings): EventForScheduling => ({
  id: event.id,
  firstPizzaTime: event.firstPizzaTime,
  serviceDurationMinutes: event.serviceDurationMinutes,
  driveMinutes: event.driveMinutes,
  driveMinutesBackToShop: event.driveMinutesBackToShop,
  rackCount: event.rackCount,
  rackRatePer30Min: resolveRackRate(people, event.crewMemberId, settings.defaultRackRatePer30Min),
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
        pizzaioloId: source.pizzaioloId,
        crewMemberId: source.crewMemberId,
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
          first.crewMemberId,
          settings.defaultMinutesBeforeDeparture,
          first.crewArrivalOverrideMinutes
        ),
        defaultOpenerPersonId: first.pizzaioloId,
        crewMemberId: first.crewMemberId,
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

  return { date, rigs: rigsWithFire, consumables, fireDutyElsewhere: [] }
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
    return { ...view, rigs: [], consumables: computeConsumables([], settings), fireDutyElsewhere: [] }
  }

  // Being sent to light another rig's fire is not a reason to see that rig's
  // day. The obligation travels with the person, and the board already carries
  // it as a badge on their own lane — the other rig's bookings, client and
  // crew are somebody else's business.
  const rigs = view.rigs.flatMap((rigView) => {
    const isOn = (event: DayEventView) => event.pizzaioloId === personId || event.crewMemberId === personId
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
    fireDutyElsewhere
  }
}

export type DesiredConfirmation = Readonly<{
  eventId: string
  personId: string
  role: 'pizzaiolo' | 'crew' | 'fire_duty'
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
  const minutesBeforeDepartureOf = (id: string, rigOverride: number | null) =>
    resolveMinutesBeforeDeparture(people, id, settings.defaultMinutesBeforeDeparture, rigOverride)

  const desired: DesiredConfirmation[] = []

  for (const rigView of dayView.rigs) {
    for (const eventView of rigView.events) {
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
      // pizzaiolo most days, but the match can be handed to the crew member
      // just as well, and then the two of them swap arrival times.
      const pizzaioloLighting = isFirstOfDay && fireDuty !== null && fireDuty.litByPersonId === eventView.pizzaioloId
      const crewLighting = isFirstOfDay && fireDuty !== null && fireDuty.litByPersonId === eventView.crewMemberId
      const pizzaioloArrival = isFirstOfDay
        ? (fireDuty?.ownArrivalTime ?? eventView.computed.leaveTime)
        : eventView.computed.leaveTime
      const fireReadyTime = fireDuty ? addMinutes(fireDuty.litAt, settings.ovenToTempMinutes) : null

      desired.push({
        eventId: eventView.id,
        personId: eventView.pizzaioloId,
        role: 'pizzaiolo',
        messageBody: composeEventMessage({
          role: 'pizzaiolo',
          arrivalTime: pizzaioloArrival,
          isLightingFire: pizzaioloLighting,
          fireReadyTime: pizzaioloLighting ? fireReadyTime : null,
          coworkerName: nameOf(eventView.crewMemberId),
          coworkerPhone: phoneOf(eventView.crewMemberId),
          event: eventContext
        })
      })

      const crewArrival =
        crewLighting && fireDuty
          ? fireDuty.litAt
          : isFirstOfDay
            ? addMinutes(
                eventView.computed.leaveTime,
                -minutesBeforeDepartureOf(eventView.crewMemberId, eventView.crewArrivalOverrideMinutes)
              )
            : eventView.computed.leaveTime

      desired.push({
        eventId: eventView.id,
        personId: eventView.crewMemberId,
        role: 'crew',
        messageBody: composeEventMessage({
          role: 'crew',
          arrivalTime: crewArrival,
          isLightingFire: crewLighting,
          fireReadyTime: crewLighting ? fireReadyTime : null,
          coworkerName: nameOf(eventView.pizzaioloId),
          coworkerPhone: phoneOf(eventView.pizzaioloId),
          event: eventContext
        })
      })

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
        pizzaioloId: '',
        crewMemberId: '',
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
const findPersonConflict = (
  dayEvents: readonly EventRecord[],
  rig: Rig,
  excludeEventIds: ReadonlySet<string>,
  personIds: readonly string[],
  people: readonly Person[]
): ValidationError | null => {
  const conflict = dayEvents.find(
    (candidate) =>
      candidate.rig !== rig &&
      !excludeEventIds.has(candidate.id) &&
      (personIds.includes(candidate.pizzaioloId) || personIds.includes(candidate.crewMemberId))
  )
  if (!conflict) return null

  const conflictingPersonId = personIds.includes(conflict.pizzaioloId) ? conflict.pizzaioloId : conflict.crewMemberId
  const personName = people.find((person) => person.id === conflictingPersonId)?.name ?? 'This person'
  return {
    type: 'ValidationError',
    message: `${personName} is already assigned to ${RIG_LABELS[conflict.rig]} today. Pick someone else, or change ${RIG_LABELS[conflict.rig]}'s crew first.`,
    input: { conflictingEventId: conflict.id, personId: conflictingPersonId }
  }
}

const saveAndSync = (dependencies: WriteDependencies, event: EventRecord): ResultAsync<EventRecord, AppError> => {
  const date = toDateKey(event.firstPizzaTime)

  return ResultAsync.combine([
    dependencies.fetchEventsForDate(date),
    dependencies.fetchSettings(),
    dependencies.fetchPeople()
  ]).andThen(([existingEvents, settings, people]) => {
    const dayEvents = [...existingEvents.filter((existing) => existing.id !== event.id), event]

    const personConflict = findPersonConflict(
      dayEvents,
      event.rig,
      new Set([event.id]),
      [event.pizzaioloId, event.crewMemberId],
      people
    )
    if (personConflict) return errAsync(personConflict)

    const dayView = buildDayView(date, dayEvents, settings, people)
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
): Readonly<{ pizzaioloId: string; crewMemberId: string }> | null => {
  const existing = dayEvents.find((event) => event.rig === rig)
  if (existing) return { pizzaioloId: existing.pizzaioloId, crewMemberId: existing.crewMemberId }

  const committed = new Set(dayEvents.flatMap((event) => [event.pizzaioloId, event.crewMemberId]))
  const pizzaiolo = people.find((person) => person.isPizzaiolo && !committed.has(person.id))
  const crewMember = people.find((person) => !committed.has(person.id) && person.id !== pizzaiolo?.id)
  return pizzaiolo && crewMember ? { pizzaioloId: pizzaiolo.id, crewMemberId: crewMember.id } : null
}

/** A create payload with the rig-owned fields left out — the caller states
 * what the party is, the rig says who runs it. */
export type NewEventInput = Omit<NewEvent, 'pizzaioloId' | 'crewMemberId'> &
  Readonly<{ pizzaioloId?: string; crewMemberId?: string }>

export const createEvent =
  (dependencies: WriteDependencies) =>
  (input: NewEventInput): ResultAsync<EventRecord, AppError> => {
    // An explicit assignment stands on its own — only reach for the rig's
    // crew when the caller didn't name one, so "nobody is free" can never
    // pre-empt the real conflict checks in `saveAndSync`.
    if (input.pizzaioloId && input.crewMemberId) {
      const { pizzaioloId, crewMemberId } = input
      return saveAndSync(dependencies, { id: dependencies.generateId(), ...input, pizzaioloId, crewMemberId })
    }

    const date = toDateKey(input.firstPizzaTime)
    return ResultAsync.combine([dependencies.fetchEventsForDate(date), dependencies.fetchPeople()]).andThen(
      ([dayEvents, people]) => {
        const crew = resolveRigCrew(dayEvents, input.rig, people)
        if (!crew) {
          const validationError: ValidationError = {
            type: 'ValidationError',
            message: `Nobody is free to run ${RIG_LABELS[input.rig]} — everyone is already on another rig today.`,
            input
          }
          return errAsync(validationError)
        }
        return saveAndSync(dependencies, {
          id: dependencies.generateId(),
          ...input,
          pizzaioloId: input.pizzaioloId ?? crew.pizzaioloId,
          crewMemberId: input.crewMemberId ?? crew.crewMemberId
        })
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

export type RigCrewInput = Readonly<{
  date: string
  rig: Rig
  pizzaioloId: string
  crewMemberId: string
  fireDutyOverridePersonId: string | null
  crewArrivalOverrideMinutes: number | null
  truckId: string | null
}>

/** Changes the pizzaiolo/crew for every event on one rig's day at once — the
 * only way to change crew once a rig has more than one event, so the whole
 * day stays one consistent answer to "who's on this rig" instead of an
 * event-by-event form quietly forking it (spec: edit the column, not one cell). */
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

      // Bringing in someone already on another rig today isn't a conflict to
      // refuse — it's a swap. Whoever they displace here takes their seat over
      // there, so both rigs stay staffed and nobody is on two rigs at once.
      const current = rigEvents[0] as EventRecord
      const swapIn = new Map<string, string>()
      if (input.pizzaioloId !== current.pizzaioloId) swapIn.set(input.pizzaioloId, current.pizzaioloId)
      if (input.crewMemberId !== current.crewMemberId) swapIn.set(input.crewMemberId, current.crewMemberId)

      const otherRigEvents = events.filter((event) => event.rig !== input.rig)

      // A truck is a physical thing — two rigs can't take the same one out.
      // So picking a truck another rig is already on trades vehicles with it
      // rather than double-booking it. A truck defaults to its namesake rig,
      // so the rig id stands in when nothing is set.
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

      const swappedEvents = otherRigEvents
        .filter(
          (event) => swapIn.has(event.pizzaioloId) || swapIn.has(event.crewMemberId) || event.rig === displacedRig
        )
        .map((event) => ({
          ...event,
          pizzaioloId: swapIn.get(event.pizzaioloId) ?? event.pizzaioloId,
          crewMemberId: swapIn.get(event.crewMemberId) ?? event.crewMemberId,
          // Only the displaced rig's own first event carries the traded
          // truck; its later events stay null, same rule as this rig's.
          truckId: event.id === displacedFirstId ? givingUp : event.rig === displacedRig ? null : event.truckId
        }))

      // A swap can only go ahead if it leaves the other rig valid: a real
      // pizzaiolo in the pizzaiolo seat, and two different people on it.
      const nameOf = (id: string) => people.find((person) => person.id === id)?.name ?? 'That person'
      const brokenSwap = swappedEvents.find(
        (event) =>
          event.pizzaioloId === event.crewMemberId ||
          !people.find((person) => person.id === event.pizzaioloId)?.isPizzaiolo
      )
      if (brokenSwap) {
        const validationError: ValidationError = {
          type: 'ValidationError',
          message:
            brokenSwap.pizzaioloId === brokenSwap.crewMemberId
              ? `That swap would put the same person on both seats of ${RIG_LABELS[brokenSwap.rig]}. Move one of them somewhere else first.`
              : `That swap would leave ${RIG_LABELS[brokenSwap.rig]} with ${nameOf(brokenSwap.pizzaioloId)} as pizzaiolo, and they aren't one. Pick a different swap.`,
          input
        }
        return errAsync(validationError)
      }

      // The override is only ever read off the day's first event for the rig
      // (see fireInputs above) — set it there and clear it elsewhere so a
      // stale value can't linger on an event that used to be first.
      const earliestEventId = [...rigEvents].sort((a, b) => a.firstPizzaTime.getTime() - b.firstPizzaTime.getTime())[0]
        ?.id
      const updatedEvents = rigEvents.map((event) => ({
        ...event,
        pizzaioloId: input.pizzaioloId,
        crewMemberId: input.crewMemberId,
        fireDutyOverridePersonId: event.id === earliestEventId ? input.fireDutyOverridePersonId : null,
        crewArrivalOverrideMinutes: event.id === earliestEventId ? input.crewArrivalOverrideMinutes : null,
        truckId: event.id === earliestEventId ? input.truckId : null
      }))

      // Both sides of a swap have to land together, or the day is left with
      // the same person on two rigs.
      const allWrites = [...updatedEvents, ...swappedEvents]
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
