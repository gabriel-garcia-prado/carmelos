import { describe, expect, test } from 'bun:test'
import type { EventForScheduling, SchedulingSettings } from './scheduling'
import { computeRigDay } from './scheduling'

// Reference Saturday (spec §14): all constants as shipped in the seeded
// settings row.
const settings: SchedulingSettings = {
  ovenToTempMinutes: 240,
  fireBeforeLoadMinutes: 120,
  setupAimedMinutes: 60,
  setupFloorMinutes: 30,
  breakDownMinutes: 30
}

const time = (hours: number, minutes = 0) => new Date(2026, 7, 8, hours, minutes)

const baseEvent = (overrides: Partial<EventForScheduling>): EventForScheduling => ({
  id: 'event',
  firstPizzaTime: time(13),
  serviceDurationMinutes: 120,
  driveMinutes: 0,
  driveMinutesBackToShop: null,
  rackCount: 0,
  rackRatePer30Min: 20,
  setupMinutesOverride: null,
  ...overrides
})

describe('computeRigDay — reference Saturday, Small Caddy (Kurt + Leonardo)', () => {
  test('first event of the day: fire, on-site, leave, first pizza', () => {
    const { events } = computeRigDay(
      [baseEvent({ id: 'millburn', firstPizzaTime: time(13), driveMinutes: 30, rackCount: 0 })],
      settings
    )

    const computed = events[0]
    if (!computed) throw new Error('expected a computed event')
    expect(computed.onSiteTime).toEqual(time(12))
    expect(computed.leaveTime).toEqual(time(11, 30))
    expect(computed.naturalFireLitTime).toEqual(time(9))
    expect(computed.turnaround).toBeNull()
    expect(computed.spareMinutes).toBeNull()
  })

  test('second event of the day: rack, spare before the drive, fine turnaround', () => {
    const { events } = computeRigDay(
      [
        baseEvent({ id: 'millburn', firstPizzaTime: time(13), driveMinutes: 30, rackCount: 0 }),
        baseEvent({ id: 'westfield', firstPizzaTime: time(18, 45), driveMinutes: 20, rackCount: 20 })
      ],
      settings
    )

    const westfield = events.find((event) => event.id === 'westfield')
    expect(westfield?.rackMinutes).toBe(30)
    expect(westfield?.turnaround).toBe('fine')
    expect(westfield?.spareMinutes).toBe(85)
    expect(westfield?.onSiteTime).toEqual(time(17, 15))
    expect(westfield?.leaveTime).toEqual(time(16, 55))
  })

  test('back at shop is the last event’s breakdown finish plus the return drive', () => {
    const { backAtShopTime, missingReturnDrive } = computeRigDay(
      [
        baseEvent({ id: 'millburn', firstPizzaTime: time(13), driveMinutes: 30, rackCount: 0 }),
        baseEvent({
          id: 'westfield',
          firstPizzaTime: time(18, 45),
          driveMinutes: 20,
          rackCount: 20,
          driveMinutesBackToShop: 25
        })
      ],
      settings
    )

    expect(missingReturnDrive).toBe(false)
    expect(backAtShopTime).toEqual(time(21, 40))
  })

  test('flags a missing return drive on the day’s last event', () => {
    const { missingReturnDrive } = computeRigDay([baseEvent({ id: 'millburn', firstPizzaTime: time(13) })], settings)

    expect(missingReturnDrive).toBe(true)
  })
})

describe('computeRigDay — turnaround thresholds', () => {
  test('tight: setup compresses toward the floor, no spare, still bookable', () => {
    const { events } = computeRigDay(
      [
        baseEvent({ id: 'first', firstPizzaTime: time(16), driveMinutes: 0, rackCount: 0 }),
        baseEvent({ id: 'second', firstPizzaTime: time(19, 30), driveMinutes: 25, rackCount: 0 })
      ],
      settings
    )

    const second = events.find((event) => event.id === 'second')
    expect(second?.turnaround).toBe('tight')
    expect(second?.setupMinutes).toBe(35)
    expect(second?.spareMinutes).toBe(0)
    expect(second?.onSiteTime).toEqual(time(18, 55))
    expect(second?.leaveTime).toEqual(time(18, 30))
  })

  test('bad: refuses with the earliest honest first-pizza time', () => {
    const { events } = computeRigDay(
      [
        baseEvent({ id: 'first', firstPizzaTime: time(12), driveMinutes: 0, rackCount: 0 }),
        baseEvent({ id: 'second', firstPizzaTime: time(14, 50), driveMinutes: 30, rackCount: 0 })
      ],
      settings
    )

    const second = events.find((event) => event.id === 'second')
    expect(second?.turnaround).toBe('bad')
    expect(second?.earliestFirstPizzaTime).toEqual(time(15, 30))
  })
})

describe('computeRigDay — fire lit time picks the earlier candidate', () => {
  test('oven head start dominates on a short drive', () => {
    const { events } = computeRigDay(
      [baseEvent({ id: 'only', firstPizzaTime: time(13), driveMinutes: 30, rackCount: 0 })],
      settings
    )

    expect(events[0]?.naturalFireLitTime).toEqual(time(9))
  })

  test('fire-before-load dominates on a very long drive', () => {
    const { events } = computeRigDay(
      [baseEvent({ id: 'only', firstPizzaTime: time(13), driveMinutes: 300, rackCount: 0 })],
      settings
    )

    // onSite = 12:00, leave = 12:00 - 300m = 07:00, leave - 2h = 05:00 < firstPizza - 4h (09:00)
    expect(events[0]?.naturalFireLitTime).toEqual(time(5))
  })
})

describe('computeRigDay — ordering', () => {
  test('sorts unordered input by first-pizza time before computing the chain', () => {
    const { events } = computeRigDay(
      [baseEvent({ id: 'later', firstPizzaTime: time(18) }), baseEvent({ id: 'earlier', firstPizzaTime: time(13) })],
      settings
    )

    expect(events.map((event) => event.id)).toEqual(['earlier', 'later'])
    expect(events[0]?.isFirstOfDay).toBe(true)
    expect(events[1]?.isFirstOfDay).toBe(false)
  })
})
