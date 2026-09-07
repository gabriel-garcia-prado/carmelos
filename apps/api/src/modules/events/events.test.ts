import { describe, expect, mock, test } from 'bun:test'
import { okAsync } from 'neverthrow'
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
  canDrive: true,
  canDriveTrailer: false,
  rackRateOverridePer30Min: null,
  minutesBeforeDepartureOverride: null,
  homeBaseAddress: null,
  ...overrides
})

const PEOPLE: Person[] = [
  person({ id: 'kurt', name: 'Kurt', phone: '973 525-7887' }),
  person({ id: 'leo', name: 'Leonardo', phone: '917 434-9619' }),
  person({ id: 'gabriel', name: 'Gabriel', phone: '551 401-7502' }),
  person({ id: 'matt', name: 'Matt', phone: '732 673-8754' })
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
  pizzaioloId: 'kurt',
  crewMemberId: 'leo',
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
    pizzaioloId: 'kurt',
    crewMemberId: 'leo'
  })
  const bigCaddy = baseEvent({
    id: 'bc1',
    rig: 'big_caddy',
    firstPizzaTime: time(12, 30),
    headcount: 30,
    address: '412 Prospect St',
    driveMinutes: 30,
    driveMinutesBackToShop: 20,
    pizzaioloId: 'gabriel',
    crewMemberId: 'matt',
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
      pizzaioloId: 'kurt',
      crewMemberId: 'leo'
    })
    const doubleBooked = baseEvent({
      id: 'new-event',
      rig: 'bus',
      firstPizzaTime: time(13),
      pizzaioloId: 'kurt',
      crewMemberId: 'gabriel'
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
      pizzaioloId: 'gabriel',
      crewMemberId: 'matt',
      fireDutyOverridePersonId: null,
      crewArrivalOverrideMinutes: null,
      truckId: null
    })

    expect(result.isOk()).toBe(true)
    expect(persistEvent).toHaveBeenCalledTimes(2)
    expect(persistEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', pizzaioloId: 'gabriel', crewMemberId: 'matt' })
    )
    expect(persistEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2', pizzaioloId: 'gabriel', crewMemberId: 'matt' })
    )
  })

  test('refuses when the new crew is already booked on another rig that day', async () => {
    const target = baseEvent({ id: 'e1', rig: 'small_caddy', firstPizzaTime: time(13) })
    const busyElsewhere = baseEvent({
      id: 'e2',
      rig: 'bus',
      firstPizzaTime: time(13),
      pizzaioloId: 'gabriel',
      crewMemberId: 'matt'
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
      pizzaioloId: 'gabriel',
      crewMemberId: 'kurt',
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
      pizzaioloId: 'gabriel',
      crewMemberId: 'matt',
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
          pizzaioloId: 'gabriel',
          crewMemberId: 'matt',
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
          crewMemberId: 'matt',
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
          pizzaioloId: 'gabriel',
          crewMemberId: 'matt',
          fireDutyOverridePersonId: 'leo',
          clientName: 'Bus party'
        }),
        baseEvent({
          id: 'later-on-bus',
          rig: 'bus',
          firstPizzaTime: time(20),
          pizzaioloId: 'gabriel',
          crewMemberId: 'matt',
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
