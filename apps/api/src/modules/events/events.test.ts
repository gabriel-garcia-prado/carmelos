import { describe, expect, mock, test } from 'bun:test'
import { okAsync } from 'neverthrow'
import { diffMinutes, formatClockTime } from '../../lib/time'
import type { Person } from '../people/people'
import type { Settings } from '../settings/settings'
import type { EventRecord, PreviewDependencies, WriteDependencies } from './events'
import {
  buildDayView,
  computeDesiredConfirmations,
  createEvent,
  previewTurnaround,
  scopeDayView,
  updateRigCrew
} from './events'

const time = (hours: number, minutes = 0) => new Date(2026, 7, 8, hours, minutes)

const SETTINGS: Settings = {
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
  kitchenAddress: null
}

const person = (overrides: Partial<Person> & { id: string; name: string; phone: string }): Person => ({
  isPizzaiolo: false,
  canStick: true,
  canDrive: true,
  canDriveTrailer: false,
  rackRateOverridePer30Min: null,
  minutesBeforeDepartureOverride: null,
  homeBaseAddress: null,
  ...overrides
})

const PEOPLE: Person[] = [
  // Both of these run rigs in the fixtures below, so they have to be marked as
  // pizzaiolos — the seat is validated now, where before nothing checked it.
  person({ id: 'kurt', name: 'Kurt', phone: '973 525-7887', isPizzaiolo: true }),
  person({ id: 'leo', name: 'Leonardo', phone: '917 434-9619' }),
  person({ id: 'gabriel', name: 'Gabriel', phone: '551 401-7502', isPizzaiolo: true }),
  person({ id: 'matt', name: 'Matt', phone: '732 673-8754' }),
  // Cuts and nothing else, so the stick seat has to refuse her.
  person({ id: 'ana', name: 'Ana', phone: '862 555-0148', canStick: false }),
  person({ id: 'nick', name: 'Nick', phone: '973 248-2950' })
]

/** The same crew on every named party — what the form sends on an ordinary day. */
const onParties = (eventIds: readonly string[], assignments: EventRecord['assignments']) =>
  eventIds.map((eventId) => ({ eventId, assignments }))

/** A party's crew: pizzaiolo, stick, then any cutters. */
const crew = (pizzaiolo: string, stick: string, ...cutters: readonly string[]): EventRecord['assignments'] => [
  { personId: pizzaiolo, role: 'pizzaiolo', meetsOnSite: false },
  { personId: stick, role: 'stick', meetsOnSite: false },
  ...cutters.map((personId) => ({ personId, role: 'cutter' as const, meetsOnSite: true }))
]

const baseEvent = (overrides: Partial<EventRecord> & Pick<EventRecord, 'id' | 'rig'>): EventRecord => ({
  firstPizzaTime: time(13),
  headcount: 50,
  address: '20 Beechwood Rd',
  clientName: null,
  driveMinutes: 30,
  driveMinutesBackToShop: null,
  serviceDurationMinutes: 120,
  setupMinutesOverride: null,
  rackCount: 0,
  assignments: crew('kurt', 'leo'),
  fireDutyOverridePersonId: null,
  crewArrivalOverrideMinutes: null,
  truckId: null,
  specialRequests: [],
  ...overrides
})

describe('buildDayView', () => {
  const smallCaddy = baseEvent({
    id: 'sc1',
    rig: 'small_caddy',
    firstPizzaTime: time(13),
    driveMinutes: 60,
    driveMinutesBackToShop: 25,
    assignments: crew('kurt', 'leo')
  })
  const bigCaddy = baseEvent({
    id: 'bc1',
    rig: 'big_caddy',
    firstPizzaTime: time(12, 30),
    headcount: 30,
    address: '412 Prospect St',
    driveMinutes: 30,
    driveMinutesBackToShop: 20,
    assignments: crew('gabriel', 'matt'),
    specialRequests: [{ requestType: 'gluten_free', headcount: 2 }]
  })

  test('the earlier-arriving rig covers the later one', () => {
    const dayView = buildDayView('2026-08-08', [smallCaddy, bigCaddy], SETTINGS, PEOPLE)

    const bigCaddyView = dayView.rigs.find((rig) => rig.rig === 'big_caddy')
    const smallCaddyView = dayView.rigs.find((rig) => rig.rig === 'small_caddy')

    expect(bigCaddyView?.fireDuty).toMatchObject({ litByPersonId: 'gabriel', isCovered: false, litAt: time(8, 30) })
    expect(smallCaddyView?.fireDuty).toMatchObject({ litByPersonId: 'gabriel', isCovered: true, litAt: time(8, 30) })
  })

  test('consumables sum headcounts across rigs and keep gluten-free additive', () => {
    const dayView = buildDayView('2026-08-08', [smallCaddy, bigCaddy], SETTINGS, PEOPLE)

    expect(dayView.consumables.totalPizzas).toBe(50 + 25 + (30 + 25))
    expect(dayView.consumables.glutenFreeDoughExtra).toBe(2)
  })

  test('the covered rig gets no fire line, and the coverer gets a separate fire-duty note', () => {
    const dayView = buildDayView('2026-08-08', [smallCaddy, bigCaddy], SETTINGS, PEOPLE)
    const desired = computeDesiredConfirmations(dayView, PEOPLE, SETTINGS)

    const kurtOwnMessage = desired.find((entry) => entry.eventId === 'sc1' && entry.role === 'pizzaiolo')
    expect(kurtOwnMessage?.messageBody).not.toContain('light the fire')

    const gabrielOwnMessage = desired.find((entry) => entry.eventId === 'bc1' && entry.role === 'pizzaiolo')
    expect(gabrielOwnMessage?.messageBody).toContain('light the fire')

    const fireDutyNote = desired.find((entry) => entry.eventId === 'sc1' && entry.role === 'fire_duty')
    expect(fireDutyNote?.personId).toBe('gabriel')
    expect(fireDutyNote?.messageBody).toContain("Small Caddy's fire")
  })

  test('the crew member can hold fire duty, and then they swap arrival times', () => {
    const crewLights = { ...smallCaddy, fireDutyOverridePersonId: 'leo' }
    const dayView = buildDayView('2026-08-08', [crewLights], SETTINGS, PEOPLE)
    const desired = computeDesiredConfirmations(dayView, PEOPLE, SETTINGS)

    const smallCaddyView = dayView.rigs.find((rig) => rig.rig === 'small_caddy')
    expect(smallCaddyView?.fireDuty).toMatchObject({ litByPersonId: 'leo' })

    // Leo comes in for the fire and carries the instruction himself...
    const leoMessage = desired.find((entry) => entry.eventId === 'sc1' && entry.role === 'crew')
    expect(leoMessage?.personId).toBe('leo')
    expect(leoMessage?.messageBody).toContain('light the fire')

    // ...and Kurt, who would normally be in at the fire, now turns up at
    // his own lead time before the truck leaves instead.
    const kurtMessage = desired.find((entry) => entry.eventId === 'sc1' && entry.role === 'pizzaiolo')
    expect(kurtMessage?.messageBody).not.toContain('light the fire')

    // No second "go light X" note — it's this rig's own crew, not cover.
    expect(desired.some((entry) => entry.eventId === 'sc1' && entry.role === 'fire_duty')).toBe(false)
  })
})

describe('createEvent', () => {
  const solo = baseEvent({ id: 'new-event', rig: 'bus', firstPizzaTime: time(13), driveMinutes: 30, rackCount: 0 })

  test('refuses to persist when the turnaround is bad', async () => {
    const priorOnSameRig = baseEvent({
      id: 'prior',
      rig: 'bus',
      firstPizzaTime: time(12),
      serviceDurationMinutes: 120,
      driveMinutes: 0,
      rackCount: 0
    })
    const tooTight = baseEvent({
      id: 'new-event',
      rig: 'bus',
      firstPizzaTime: time(14, 50),
      driveMinutes: 30,
      rackCount: 0
    })

    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const applyConfirmations = mock(() => okAsync(undefined))
    const dependencies: WriteDependencies = {
      generateId: () => 'new-event',
      fetchEventsForDate: () => okAsync([priorOnSameRig]),
      fetchSettings: () => okAsync(SETTINGS),
      fetchPeople: () => okAsync(PEOPLE),
      persistEvent,
      applyConfirmations
    }

    const result = await createEvent(dependencies)(tooTight)

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ValidationError' })
    expect(persistEvent).not.toHaveBeenCalled()
    expect(applyConfirmations).not.toHaveBeenCalled()
  })

  test('persists and syncs confirmations for a bookable event', async () => {
    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const applyConfirmations = mock(() => okAsync(undefined))
    const dependencies: WriteDependencies = {
      generateId: () => 'new-event',
      fetchEventsForDate: () => okAsync([]),
      fetchSettings: () => okAsync(SETTINGS),
      fetchPeople: () => okAsync(PEOPLE),
      persistEvent,
      applyConfirmations
    }

    const result = await createEvent(dependencies)(solo)

    expect(result.isOk()).toBe(true)
    expect(persistEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-event' }))
    expect(applyConfirmations).toHaveBeenCalledTimes(1)
    const [, desired] = applyConfirmations.mock.calls[0] as unknown as [string, readonly { role: string }[]]
    expect(desired.map((entry) => entry.role).sort()).toEqual(['crew', 'pizzaiolo'])
  })

  test('refuses a pizzaiolo/crew already booked on a different rig that day, even at the exact same time', async () => {
    // The bug this guards against: each rig's own turnaround math looked
    // fine in isolation, so Kurt could end up "in two places at once" —
    // pizzaiolo on Small Caddy and ALSO pizzaiolo on Bus at 1pm the same day.
    const busyElsewhere = baseEvent({
      id: 'small-caddy-1pm',
      rig: 'small_caddy',
      firstPizzaTime: time(13),
      assignments: crew('kurt', 'leo')
    })
    const doubleBooked = baseEvent({
      id: 'new-event',
      rig: 'bus',
      firstPizzaTime: time(13),
      assignments: crew('kurt', 'gabriel')
    })

    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const applyConfirmations = mock(() => okAsync(undefined))
    const dependencies: WriteDependencies = {
      generateId: () => 'new-event',
      fetchEventsForDate: () => okAsync([busyElsewhere]),
      fetchSettings: () => okAsync(SETTINGS),
      fetchPeople: () => okAsync(PEOPLE),
      persistEvent,
      applyConfirmations
    }

    const result = await createEvent(dependencies)(doubleBooked)

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'ValidationError',
      message: expect.stringContaining('Kurt')
    })
    expect(persistEvent).not.toHaveBeenCalled()
  })
})

describe('updateRigCrew', () => {
  test('changes every event on the rig that day to the new pizzaiolo/crew', async () => {
    const first = baseEvent({ id: 'e1', rig: 'small_caddy', firstPizzaTime: time(11) })
    const second = baseEvent({ id: 'e2', rig: 'small_caddy', firstPizzaTime: time(18) })
    const otherRig = baseEvent({ id: 'e3', rig: 'bus', firstPizzaTime: time(13) })

    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const applyConfirmations = mock(() => okAsync(undefined))
    const dependencies: WriteDependencies = {
      generateId: () => 'unused',
      fetchEventsForDate: () => okAsync([first, second, otherRig]),
      fetchSettings: () => okAsync(SETTINGS),
      fetchPeople: () => okAsync(PEOPLE),
      persistEvent,
      applyConfirmations
    }

    const result = await updateRigCrew(dependencies)({
      date: '2026-08-08',
      rig: 'small_caddy',
      parties: onParties(['e1', 'e2'], crew('gabriel', 'matt')),
      fireDutyOverridePersonId: null,
      crewArrivalOverrideMinutes: null,
      truckId: null
    })

    expect(result.isOk()).toBe(true)
    expect(persistEvent).toHaveBeenCalledTimes(2)
    expect(persistEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', assignments: crew('gabriel', 'matt') })
    )
    expect(persistEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2', assignments: crew('gabriel', 'matt') })
    )
  })

  test('refuses when the new crew is already booked on another rig that day', async () => {
    const target = baseEvent({ id: 'e1', rig: 'small_caddy', firstPizzaTime: time(13) })
    const busyElsewhere = baseEvent({
      id: 'e2',
      rig: 'bus',
      firstPizzaTime: time(13),
      assignments: crew('gabriel', 'matt')
    })

    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const dependencies: WriteDependencies = {
      generateId: () => 'unused',
      fetchEventsForDate: () => okAsync([target, busyElsewhere]),
      fetchSettings: () => okAsync(SETTINGS),
      fetchPeople: () => okAsync(PEOPLE),
      persistEvent,
      applyConfirmations: mock(() => okAsync(undefined))
    }

    const result = await updateRigCrew(dependencies)({
      date: '2026-08-08',
      rig: 'small_caddy',
      parties: onParties(['e1'], crew('gabriel', 'kurt')),
      fireDutyOverridePersonId: null,
      crewArrivalOverrideMinutes: null,
      truckId: null
    })

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ValidationError' })
    expect(persistEvent).not.toHaveBeenCalled()
  })

  test('refuses when the rig has no events that day', async () => {
    const dependencies: WriteDependencies = {
      generateId: () => 'unused',
      fetchEventsForDate: () => okAsync([]),
      fetchSettings: () => okAsync(SETTINGS),
      fetchPeople: () => okAsync(PEOPLE),
      persistEvent: mock((event: EventRecord) => okAsync(event)),
      applyConfirmations: mock(() => okAsync(undefined))
    }

    const result = await updateRigCrew(dependencies)({
      date: '2026-08-08',
      rig: 'bus',
      parties: onParties(['e1'], crew('gabriel', 'matt')),
      fireDutyOverridePersonId: null,
      crewArrivalOverrideMinutes: null,
      truckId: null
    })

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ValidationError' })
  })
})

describe('previewTurnaround', () => {
  const previewDependencies = (existing: readonly EventRecord[]): PreviewDependencies => ({
    fetchEventsForDate: () => okAsync(existing),
    fetchSettings: () => okAsync(SETTINGS),
    fetchPeople: () => okAsync(PEOPLE)
  })

  test('is null (no prior event) for the first draft on an empty rig', async () => {
    const result = await previewTurnaround(previewDependencies([]))({
      rig: 'bus',
      firstPizzaTime: time(13),
      driveMinutes: 30,
      driveMinutesBackToShop: null,
      serviceDurationMinutes: 120,
      setupMinutesOverride: null,
      rackCount: 0
    })

    expect(result._unsafeUnwrap()).toMatchObject({ turnaround: null, earliestFirstPizzaTime: null })
  })

  test('is fine with a comfortable gap after a prior event on the same rig', async () => {
    const prior = baseEvent({ id: 'prior', rig: 'bus', firstPizzaTime: time(11), serviceDurationMinutes: 60 })
    const result = await previewTurnaround(previewDependencies([prior]))({
      rig: 'bus',
      firstPizzaTime: time(15),
      driveMinutes: 30,
      driveMinutesBackToShop: null,
      serviceDurationMinutes: 120,
      setupMinutesOverride: null,
      rackCount: 0
    })

    expect(result._unsafeUnwrap().turnaround).toBe('fine')
  })

  test('is bad when the draft cannot honestly follow the prior event', async () => {
    const prior = baseEvent({ id: 'prior', rig: 'bus', firstPizzaTime: time(12), serviceDurationMinutes: 120 })
    const result = await previewTurnaround(previewDependencies([prior]))({
      rig: 'bus',
      firstPizzaTime: time(14, 50),
      driveMinutes: 30,
      driveMinutesBackToShop: null,
      serviceDurationMinutes: 120,
      setupMinutesOverride: null,
      rackCount: 0
    })

    expect(result._unsafeUnwrap().turnaround).toBe('bad')
    expect(result._unsafeUnwrap().earliestFirstPizzaTime).not.toBeNull()
  })

  test('excludes the draft itself by id, so re-previewing an existing event does not double it up', async () => {
    const ownPriorSave = baseEvent({ id: 'editing-me', rig: 'bus', firstPizzaTime: time(13) })
    const result = await previewTurnaround(previewDependencies([ownPriorSave]))({
      id: 'editing-me',
      rig: 'bus',
      firstPizzaTime: time(13),
      driveMinutes: 30,
      driveMinutesBackToShop: null,
      serviceDurationMinutes: 120,
      setupMinutesOverride: null,
      rackCount: 0
    })

    expect(result._unsafeUnwrap()).toMatchObject({ turnaround: null, earliestFirstPizzaTime: null })
  })

  test('the earliest it reports is one that actually works for the whole day', async () => {
    // Two parties already booked. A draft dropped in front of the first one
    // breaks it; the advice used to be that FIRST party's own earliest time,
    // which just moved the collision onto the second party and produced a new
    // number - following them walked the booking down the day forever.
    const morning = baseEvent({ id: 'morning', rig: 'bus', firstPizzaTime: time(13), serviceDurationMinutes: 120 })
    const evening = baseEvent({ id: 'evening', rig: 'bus', firstPizzaTime: time(18, 45), serviceDurationMinutes: 120 })
    const draft = {
      rig: 'bus' as const,
      driveMinutes: 30,
      driveMinutesBackToShop: null,
      serviceDurationMinutes: 120,
      setupMinutesOverride: null,
      rackCount: 0
    }

    const clash = (
      await previewTurnaround(previewDependencies([morning, evening]))({ ...draft, firstPizzaTime: time(12) })
    )._unsafeUnwrap()
    expect(clash.turnaround).toBe('bad')

    const advised = clash.earliestFirstPizzaTime
    expect(advised).not.toBeNull()

    // The whole point: taking the advice has to settle it in one move.
    const followed = (
      await previewTurnaround(previewDependencies([morning, evening]))({
        ...draft,
        firstPizzaTime: advised as Date
      })
    )._unsafeUnwrap()
    expect(followed.turnaround).not.toBe('bad')
    expect(followed.rigDay?.events.every((event) => event.computed.turnaround !== 'bad')).toBe(true)
  })

  test("names the existing party a draft would break, rather than passing off its time as the draft's", async () => {
    // The draft itself sits comfortably; it's the party AFTER it that can no
    // longer be reached. That's a different problem with a different fix, so
    // it must not be reported as the draft's own earliest.
    const later = baseEvent({
      id: 'later',
      rig: 'bus',
      firstPizzaTime: time(16),
      serviceDurationMinutes: 120,
      clientName: 'Kaplan Bar Mitzvah'
    })
    const result = (
      await previewTurnaround(previewDependencies([later]))({
        rig: 'bus',
        firstPizzaTime: time(14),
        driveMinutes: 30,
        driveMinutesBackToShop: null,
        serviceDurationMinutes: 120,
        setupMinutesOverride: null,
        rackCount: 0
      })
    )._unsafeUnwrap()

    expect(result.turnaround).toBe('bad')
    expect(result.blockedBy?.clientName).toBe('Kaplan Bar Mitzvah')
    expect(result.blockedBy?.firstPizzaTime).toEqual(time(16))
  })

  test("returns the rig's whole day with the draft scheduled into it", async () => {
    const result = await previewTurnaround(previewDependencies([]))({
      rig: 'bus',
      firstPizzaTime: time(13),
      driveMinutes: 30,
      driveMinutesBackToShop: null,
      serviceDurationMinutes: 120,
      setupMinutesOverride: null,
      rackCount: 0
    })

    const preview = result._unsafeUnwrap()
    // The form draws this, so it needs the draft present AND already run
    // through the scheduler — an unscheduled event has nothing to lay out.
    const draft = preview.rigDay?.events.find((event) => event.id === preview.draftEventId)
    expect(preview.rigDay?.rig).toBe('bus')
    expect(draft?.computed.leaveTime).toBeInstanceOf(Date)
    expect(draft?.firstPizzaTime).toEqual(time(13))
  })
})

describe('a person working more than one party', () => {
  const writeDependencies = (
    dayEvents: readonly EventRecord[],
    persistEvent = mock((e: EventRecord) => okAsync(e))
  ) => ({
    generateId: () => 'new-event',
    fetchEventsForDate: () => okAsync(dayEvents),
    fetchSettings: () => okAsync(SETTINGS),
    fetchPeople: () => okAsync(PEOPLE),
    persistEvent,
    applyConfirmations: mock(() => okAsync(undefined))
  })

  test('finishing one rig and going out with another that leaves later is allowed', async () => {
    // Leonardo sticks the lunchtime Small Caddy, which packs down at 3:30,
    // then goes out on the Bus that evening. The old rule refused this flat:
    // "already assigned to Small Caddy today".
    const morning = baseEvent({
      id: 'morning',
      rig: 'small_caddy',
      firstPizzaTime: time(13),
      assignments: crew('kurt', 'leo')
    })
    const evening = baseEvent({
      id: 'evening',
      rig: 'bus',
      firstPizzaTime: time(19),
      assignments: crew('gabriel', 'leo')
    })

    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const result = await createEvent(writeDependencies([morning], persistEvent))(evening)

    expect(result.isOk()).toBe(true)
    expect(persistEvent).toHaveBeenCalled()
  })

  test('being in two places at once is refused, and the message says which two', async () => {
    const morning = baseEvent({
      id: 'morning',
      rig: 'small_caddy',
      firstPizzaTime: time(13),
      assignments: crew('kurt', 'leo')
    })
    // Same afternoon, overlapping the first party's pack-down.
    const clashing = baseEvent({
      id: 'clashing',
      rig: 'bus',
      firstPizzaTime: time(14),
      assignments: crew('gabriel', 'leo')
    })

    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const result = await createEvent(writeDependencies([morning], persistEvent))(clashing)

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain('Leonardo')
    expect(result._unsafeUnwrapErr().message).toContain('Small Caddy')
    expect(persistEvent).not.toHaveBeenCalled()
  })

  test('someone meeting the rig on site is due for set-up, not at the shop', () => {
    const party = baseEvent({
      id: 'party',
      rig: 'small_caddy',
      firstPizzaTime: time(13),
      assignments: [
        { personId: 'kurt', role: 'pizzaiolo', meetsOnSite: false },
        { personId: 'leo', role: 'stick', meetsOnSite: false },
        { personId: 'matt', role: 'cutter', meetsOnSite: true }
      ]
    })
    const dayView = buildDayView('2026-08-08', [party], SETTINGS, PEOPLE)
    const desired = computeDesiredConfirmations(dayView, PEOPLE, SETTINGS)
    const onSite = dayView.rigs.find((rig) => rig.rig === 'small_caddy')?.events[0]?.computed.onSiteTime

    const cutterMessage = desired.find((entry) => entry.personId === 'matt')
    expect(cutterMessage?.role).toBe('cutter')
    // Set-up is done together, so it's the on-site moment rather than first
    // pizza — and they're told where, not when the truck leaves the shop.
    expect(cutterMessage?.messageBody).toContain(`meet us at ${party.address}`)
    expect(cutterMessage?.messageBody).toContain(formatClockTime(onSite as Date))
    expect(cutterMessage?.messageBody).not.toContain('Leave')
  })

  test('a stick who joins the later party is due for set-up, not at a departure they cannot reach', () => {
    // Nick takes over the stick for the evening only. The rig is not at the
    // shop when it leaves for that party - it is at the afternoon one, where
    // Nick never was. Riding out with it isn't unusual here, it's impossible,
    // so the on-site arrival is derived rather than left to the flag.
    const afternoon = baseEvent({
      id: 'afternoon',
      rig: 'small_caddy',
      firstPizzaTime: time(13),
      assignments: crew('kurt', 'leo')
    })
    const evening = baseEvent({
      id: 'evening',
      rig: 'small_caddy',
      firstPizzaTime: time(19),
      assignments: crew('kurt', 'nick')
    })

    const dayView = buildDayView('2026-08-08', [afternoon, evening], SETTINGS, PEOPLE)
    const rigDay = dayView.rigs.find((rig) => rig.rig === 'small_caddy')
    const second = rigDay?.events.find((event) => event.id === 'evening')
    const desired = computeDesiredConfirmations(dayView, PEOPLE, SETTINGS)

    const toNick = desired.find((entry) => entry.personId === 'nick' && entry.eventId === 'evening')
    expect(toNick?.messageBody).toContain(`meet us at ${evening.address}`)
    expect(toNick?.messageBody).toContain(formatClockTime(second?.computed.onSiteTime as Date))
    // Not the departure from the previous party's site.
    expect(toNick?.messageBody).not.toContain('Leave')

    // Kurt worked the afternoon and carries straight on, so he IS on the truck
    // and his moment is the one it pulls away.
    const toKurt = desired.find((entry) => entry.personId === 'kurt' && entry.eventId === 'evening')
    expect(toKurt?.messageBody).toContain(formatClockTime(second?.computed.leaveTime as Date))
    expect(toKurt?.messageBody).toContain('Leave')
  })

  test('everyone on the party is listed to everyone else', () => {
    const party = baseEvent({
      id: 'party',
      rig: 'small_caddy',
      assignments: [
        { personId: 'kurt', role: 'pizzaiolo', meetsOnSite: false },
        { personId: 'leo', role: 'stick', meetsOnSite: false },
        { personId: 'matt', role: 'cutter', meetsOnSite: true }
      ]
    })
    const desired = computeDesiredConfirmations(buildDayView('2026-08-08', [party], SETTINGS, PEOPLE), PEOPLE, SETTINGS)

    const toKurt = desired.find((entry) => entry.personId === 'kurt')
    expect(toKurt?.messageBody).toContain('Leonardo')
    expect(toKurt?.messageBody).toContain('Matt')
  })
})

describe('seat rules', () => {
  const dependenciesFor = (persistEvent = mock((e: EventRecord) => okAsync(e))) => ({
    generateId: () => 'new-event',
    fetchEventsForDate: () => okAsync([]),
    fetchSettings: () => okAsync(SETTINGS),
    fetchPeople: () => okAsync(PEOPLE),
    persistEvent,
    applyConfirmations: mock(() => okAsync(undefined))
  })

  test.each([
    ['no stick', [{ personId: 'kurt', role: 'pizzaiolo' as const, meetsOnSite: false }], 'no stick'],
    [
      'two sticks',
      [
        { personId: 'kurt', role: 'pizzaiolo' as const, meetsOnSite: false },
        { personId: 'leo', role: 'stick' as const, meetsOnSite: false },
        { personId: 'matt', role: 'stick' as const, meetsOnSite: false }
      ],
      'more than one stick'
    ],
    [
      'the same person twice',
      [
        { personId: 'kurt', role: 'pizzaiolo' as const, meetsOnSite: false },
        { personId: 'leo', role: 'stick' as const, meetsOnSite: false },
        { personId: 'leo', role: 'cutter' as const, meetsOnSite: false }
      ],
      'twice'
    ],
    [
      'someone who only cuts on the stick',
      [
        { personId: 'kurt', role: 'pizzaiolo' as const, meetsOnSite: false },
        { personId: 'ana', role: 'stick' as const, meetsOnSite: false }
      ],
      'only cuts'
    ]
  ])('refuses %s', async (_case, assignments, expected) => {
    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const result = await createEvent(dependenciesFor(persistEvent))(
      baseEvent({ id: 'new-event', rig: 'bus', assignments })
    )

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().message).toContain(expected)
    expect(persistEvent).not.toHaveBeenCalled()
  })

  test('a cutter on top of the two required seats is fine', async () => {
    const persistEvent = mock((event: EventRecord) => okAsync(event))
    const result = await createEvent(dependenciesFor(persistEvent))(
      baseEvent({ id: 'new-event', rig: 'bus', assignments: crew('kurt', 'leo', 'matt') })
    )

    expect(result.isOk()).toBe(true)
    expect(persistEvent).toHaveBeenCalled()
  })
})

describe('rack timing', () => {
  test("follows the pizzaiolo's pace, not the stick's", () => {
    // Rack minutes measure how fast the pizzaiolo turns pizzas out, so they
    // have to move when the pizzaiolo changes and stay put when the stick does.
    // This read the stick's rate until the seats were pulled apart.
    const people = [
      person({ id: 'quick', name: 'Quick', phone: '1', isPizzaiolo: true, rackRateOverridePer30Min: 40 }),
      person({ id: 'slow', name: 'Slow', phone: '2', isPizzaiolo: true, rackRateOverridePer30Min: 10 }),
      person({ id: 'stick-a', name: 'Stick A', phone: '3', rackRateOverridePer30Min: 40 }),
      person({ id: 'stick-b', name: 'Stick B', phone: '4', rackRateOverridePer30Min: 10 })
    ]
    const rackMinutesFor = (pizzaiolo: string, stick: string) =>
      buildDayView(
        '2026-08-08',
        [baseEvent({ id: 'e', rig: 'bus', rackCount: 40, assignments: crew(pizzaiolo, stick) })],
        SETTINGS,
        people
      ).rigs.find((rig) => rig.rig === 'bus')?.events[0]?.computed.rackMinutes

    expect(rackMinutesFor('quick', 'stick-a')).toBe(30)
    expect(rackMinutesFor('slow', 'stick-a')).toBe(120)
    // Swapping only the stick leaves the rack exactly where it was.
    expect(rackMinutesFor('quick', 'stick-b')).toBe(30)
  })
})

describe('summariseDay', () => {
  const shiftOf = (day: ReturnType<typeof buildDayView>, personId: string) =>
    day.summary.people.find((shift) => shift.personId === personId)
  const rigOf = (day: ReturnType<typeof buildDayView>, rig: string) => day.rigs.find((view) => view.rig === rig)

  test('someone riding out is on the clock until the truck is back at the shop', () => {
    const day = buildDayView(
      '2026-08-08',
      [baseEvent({ id: 'p', rig: 'bus', firstPizzaTime: time(13), driveMinutesBackToShop: 20 })],
      SETTINGS,
      PEOPLE
    )
    const leo = shiftOf(day, 'leo')
    const back = rigOf(day, 'bus')?.backAtShopTime as Date

    expect(leo?.lastOut).toEqual(back)
    expect(leo?.minutes).toBe(diffMinutes(back, leo?.firstIn as Date))
  })

  test('the wait between two parties on the same rig is still on the clock', () => {
    // Leonardo works lunch and dinner on the Bus and never leaves the truck,
    // so it's one stretch from first thing to back at the shop.
    const day = buildDayView(
      '2026-08-08',
      [
        baseEvent({ id: 'lunch', rig: 'bus', firstPizzaTime: time(13) }),
        baseEvent({ id: 'dinner', rig: 'bus', firstPizzaTime: time(19), driveMinutesBackToShop: 20 })
      ],
      SETTINGS,
      PEOPLE
    )
    const leo = shiftOf(day, 'leo')

    expect(leo?.parties).toBe(2)
    expect(leo?.minutes).toBe(diffMinutes(leo?.lastOut as Date, leo?.firstIn as Date))
  })

  test('the gap between two different rigs is not', () => {
    // Leonardo sticks a lunchtime Small Caddy, then goes out on the evening
    // Bus. The hours in between are his own.
    const day = buildDayView(
      '2026-08-08',
      [
        baseEvent({ id: 'morning', rig: 'small_caddy', firstPizzaTime: time(13), driveMinutesBackToShop: 20 }),
        baseEvent({
          id: 'evening',
          rig: 'bus',
          firstPizzaTime: time(19),
          driveMinutesBackToShop: 20,
          assignments: crew('gabriel', 'leo')
        })
      ],
      SETTINGS,
      PEOPLE
    )
    const leo = shiftOf(day, 'leo')
    const span = diffMinutes(leo?.lastOut as Date, leo?.firstIn as Date)

    expect(leo?.parties).toBe(2)
    expect(leo?.minutes).toBeLessThan(span)
  })

  test('someone making their own way is counted from set-up to pack-down, not the drive home', () => {
    const day = buildDayView(
      '2026-08-08',
      [
        baseEvent({
          id: 'p',
          rig: 'bus',
          firstPizzaTime: time(13),
          driveMinutesBackToShop: 20,
          assignments: crew('kurt', 'leo', 'matt')
        })
      ],
      SETTINGS,
      PEOPLE
    )
    const party = rigOf(day, 'bus')?.events[0]
    const matt = shiftOf(day, 'matt')

    expect(matt?.firstIn).toEqual(party?.computed.onSiteTime as Date)
    expect(matt?.lastOut).toEqual(party?.computed.breakDownFinishTime as Date)
  })

  test('a party worked by three people is still one party', () => {
    const day = buildDayView(
      '2026-08-08',
      [baseEvent({ id: 'p', rig: 'bus', headcount: 50, assignments: crew('kurt', 'leo', 'matt') })],
      SETTINGS,
      PEOPLE
    )

    expect(day.summary.parties).toBe(1)
    expect(day.summary.guests).toBe(50)
    expect(day.summary.pizzas).toBe(50 + SETTINGS.sparePizzasPerEvent)
    expect(day.summary.peopleWorking).toBe(3)
  })

  test("a crew login is shown their own day and nobody else's hours", () => {
    const day = buildDayView(
      '2026-08-08',
      [
        baseEvent({ id: 'mine', rig: 'small_caddy', firstPizzaTime: time(13), headcount: 40 }),
        baseEvent({
          id: 'theirs',
          rig: 'bus',
          firstPizzaTime: time(13),
          headcount: 90,
          assignments: crew('gabriel', 'matt')
        })
      ],
      SETTINGS,
      PEOPLE
    )
    const scoped = scopeDayView(day, { role: 'crew', personId: 'leo' }, SETTINGS)

    expect(scoped.summary.people.map((shift) => shift.personId)).toEqual(['leo'])
    // The totals are Leonardo's, not the operation's — the Bus's 90 guests
    // are none of his business.
    expect(scoped.summary.parties).toBe(1)
    expect(scoped.summary.guests).toBe(40)
    expect(scoped.summary.peopleWorking).toBe(1)
  })
})

describe('scopeDayView', () => {
  const OWNER = { role: 'owner' as const, personId: null }
  const CREW = { role: 'crew' as const, personId: 'leo' }
  const PIZZAIOLO = { role: 'pizzaiolo' as const, personId: 'kurt' }

  // Two rigs, and two parties on the one Kurt and Leonardo are working.
  const DAY = () =>
    buildDayView(
      '2026-08-08',
      [
        baseEvent({ id: 'lunch', rig: 'small_caddy', firstPizzaTime: time(13), clientName: 'Kaplan' }),
        baseEvent({ id: 'dinner', rig: 'small_caddy', firstPizzaTime: time(19), clientName: 'Westfield' }),
        baseEvent({
          id: 'elsewhere',
          rig: 'bus',
          firstPizzaTime: time(15),
          assignments: crew('gabriel', 'matt'),
          clientName: 'Someone else'
        })
      ],
      SETTINGS,
      PEOPLE
    )

  const rigsOf = (view: ReturnType<typeof DAY>) => view.rigs.map((rig) => rig.rig)

  test('the owner sees the day untouched', () => {
    const day = DAY()
    expect(scopeDayView(day, OWNER, SETTINGS)).toBe(day)
  })

  test('a rig the viewer has nothing to do with is dropped, not emptied', () => {
    // Emptied would read as "nothing booked on the Bus today", which is a
    // different and false statement.
    expect(rigsOf(scopeDayView(DAY(), CREW, SETTINGS))).toEqual(['small_caddy'])
    expect(rigsOf(scopeDayView(DAY(), PIZZAIOLO, SETTINGS))).toEqual(['small_caddy'])
  })

  test('a pizzaiolo gets their whole rig day, so the turnaround is visible', () => {
    const scoped = scopeDayView(DAY(), PIZZAIOLO, SETTINGS)
    expect(scoped.rigs[0]?.events.map((event) => event.id)).toEqual(['lunch', 'dinner'])
  })

  test('the schedule survives scoping: a kept event is still computed against the ones removed', () => {
    // Leonardo is crew on both parties here, so take the second one and check
    // it still knows it is not the first of the day.
    const full = DAY()
    const before = full.rigs.find((rig) => rig.rig === 'small_caddy')?.events.find((event) => event.id === 'dinner')
    const after = scopeDayView(full, CREW, SETTINGS).rigs[0]?.events.find((event) => event.id === 'dinner')

    expect(after?.computed.isFirstOfDay).toBe(false)
    expect(after?.computed.turnaround).toBe(before?.computed.turnaround)
    expect(after?.computed.leaveTime).toEqual(before?.computed.leaveTime as Date)
  })

  test('crew get only the shift they are on, not the rest of the rig day', () => {
    const day = buildDayView(
      '2026-08-08',
      [
        baseEvent({ id: 'lunch', rig: 'small_caddy', firstPizzaTime: time(13), clientName: 'Kaplan' }),
        // Same rig, same day, someone else's shift.
        baseEvent({
          id: 'dinner',
          rig: 'small_caddy',
          firstPizzaTime: time(19),
          assignments: crew('kurt', 'matt'),
          clientName: 'Westfield'
        })
      ],
      SETTINGS,
      PEOPLE
    )

    const scoped = scopeDayView(day, CREW, SETTINGS)
    expect(scoped.rigs[0]?.events.map((event) => event.id)).toEqual(['lunch'])
    // And the client they were never told about doesn't leak through.
    expect(JSON.stringify(scoped)).not.toContain('Westfield')
  })

  test("lighting another rig's fire does not open that rig's day", () => {
    const day = buildDayView(
      '2026-08-08',
      [
        baseEvent({ id: 'own', rig: 'small_caddy', firstPizzaTime: time(13) }),
        baseEvent({
          id: 'covered',
          rig: 'bus',
          firstPizzaTime: time(15),
          assignments: crew('gabriel', 'matt'),
          fireDutyOverridePersonId: 'leo',
          clientName: 'Bus party'
        }),
        baseEvent({
          id: 'later-on-bus',
          rig: 'bus',
          firstPizzaTime: time(20),
          assignments: crew('gabriel', 'matt'),
          clientName: 'Later bus party'
        })
      ],
      SETTINGS,
      PEOPLE
    )

    // Leonardo lights the Bus's fire but works the Small Caddy. The early
    // start is his; the Bus's bookings are not. His own lane carries the
    // fire badge, so nothing is lost by dropping the rig entirely.
    expect(day.rigs.find((rig) => rig.rig === 'bus')?.fireDuty?.litByPersonId).toBe('leo')

    const scoped = scopeDayView(day, CREW, SETTINGS)
    expect(scoped.rigs.map((rig) => rig.rig)).toEqual(['small_caddy'])
    expect(JSON.stringify(scoped)).not.toContain('Bus party')

    // The rig goes; the obligation doesn't. Without this the board would stop
    // telling him he's due at the shop for a fire he still has to light.
    expect(scoped.fireDutyElsewhere).toHaveLength(1)
    expect(scoped.fireDutyElsewhere[0]).toMatchObject({ rig: 'bus', label: 'Bus', litByPersonId: 'leo' })
    expect(scoped.fireDutyElsewhere[0]?.litAt).toEqual(
      day.rigs.find((rig) => rig.rig === 'bus')?.fireDuty?.litAt as Date
    )

    // Same for a pizzaiolo sent to cover a fire.
    const asPizzaiolo = scopeDayView(day, { role: 'pizzaiolo', personId: 'leo' }, SETTINGS)
    expect(asPizzaiolo.rigs.map((rig) => rig.rig)).toEqual(['small_caddy'])
  })

  test('consumables are recounted from what is left, not carried over', () => {
    const scoped = scopeDayView(DAY(), PIZZAIOLO, SETTINGS)
    const full = DAY()
    expect(scoped.consumables.totalPizzas).toBeLessThan(full.consumables.totalPizzas)
    expect(scoped.consumables.totalPizzas).toBe(scoped.rigs[0]?.consumables.totalPizzas as number)
  })

  test('a crew login with no person attached sees nothing at all', () => {
    // Failing open here would hand the whole book to a half-configured login.
    const scoped = scopeDayView(DAY(), { role: 'crew', personId: null }, SETTINGS)
    expect(scoped.rigs).toEqual([])
    expect(scoped.consumables.totalPizzas).toBe(0)
  })
})
