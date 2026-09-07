import { addMinutes, diffMinutes } from './time'

export type SchedulingSettings = Readonly<{
  ovenToTempMinutes: number
  fireBeforeLoadMinutes: number
  setupAimedMinutes: number
  setupFloorMinutes: number
  breakDownMinutes: number
}>

export type EventForScheduling = Readonly<{
  id: string
  firstPizzaTime: Date
  serviceDurationMinutes: number
  // Drive time for the leg that reaches this event (from the shop if this is
  // the rig's first event of the day, otherwise from the previous event).
  driveMinutes: number
  // Only used on whichever event turns out to be the rig's last of the day.
  driveMinutesBackToShop: number | null
  rackCount: number
  rackRatePer30Min: number
  setupMinutesOverride: number | null
}>

export type TurnaroundStatus = 'fine' | 'tight' | 'bad'

export type ComputedEvent = Readonly<{
  id: string
  rackMinutes: number
  setupMinutes: number
  onSiteTime: Date
  leaveTime: Date
  // When breakdown starts (spec's "break down HH:MM" reference point).
  serviceEndTime: Date
  // When breakdown finishes, 30 min (configurable) after serviceEndTime —
  // the anchor spare time and the return drive are measured from.
  breakDownFinishTime: Date
  isFirstOfDay: boolean
  // Only set for the first event of the rig's day — later events on the same
  // rig share the fire already lit, so there's nothing to compute.
  naturalFireLitTime: Date | null
  // Null for the first event of a rig's day: there's nothing before it to
  // measure a turnaround against.
  spareMinutes: number | null
  turnaround: TurnaroundStatus | null
  // Set only when turnaround is 'bad': the earliest first-pizza time this
  // rig could honestly promise, for the UI's two recovery actions.
  earliestFirstPizzaTime: Date | null
}>

export type RigDayComputed = Readonly<{
  events: readonly ComputedEvent[]
  backAtShopTime: Date | null
  // True when the day has a last event but it has no driveMinutesBackToShop
  // set yet — the UI should prompt for it rather than silently omit it.
  missingReturnDrive: boolean
}>

const computeRackMinutes = (rackCount: number, rackRatePer30Min: number): number =>
  rackCount > 0 ? Math.round((rackCount / rackRatePer30Min) * 30) : 0

export const computeRigDay = (events: readonly EventForScheduling[], settings: SchedulingSettings): RigDayComputed => {
  const sorted = [...events].sort((a, b) => a.firstPizzaTime.getTime() - b.firstPizzaTime.getTime())
  const computed: ComputedEvent[] = []
  let previousServiceEnd: Date | null = null

  for (const [index, event] of sorted.entries()) {
    const isFirstOfDay = index === 0
    const rackMinutes = computeRackMinutes(event.rackCount, event.rackRatePer30Min)
    const serviceEndTime = addMinutes(event.firstPizzaTime, event.serviceDurationMinutes)
    const breakDownFinishTime = addMinutes(serviceEndTime, settings.breakDownMinutes)

    let setupMinutes: number
    let spareMinutes: number | null = null
    let turnaround: TurnaroundStatus | null = null
    let earliestFirstPizzaTime: Date | null = null

    if (previousServiceEnd === null) {
      setupMinutes = event.setupMinutesOverride ?? settings.setupAimedMinutes
    } else {
      const gapMinutes = diffMinutes(event.firstPizzaTime, previousServiceEnd)
      const requiredFine = settings.breakDownMinutes + event.driveMinutes + settings.setupAimedMinutes + rackMinutes
      const requiredFloor = settings.breakDownMinutes + event.driveMinutes + settings.setupFloorMinutes + rackMinutes

      if (gapMinutes >= requiredFine) {
        turnaround = 'fine'
        setupMinutes = event.setupMinutesOverride ?? settings.setupAimedMinutes
        spareMinutes = gapMinutes - requiredFine
      } else if (gapMinutes >= requiredFloor) {
        turnaround = 'tight'
        const compressed = gapMinutes - settings.breakDownMinutes - event.driveMinutes - rackMinutes
        setupMinutes =
          event.setupMinutesOverride ??
          Math.max(settings.setupFloorMinutes, Math.min(settings.setupAimedMinutes, compressed))
        spareMinutes = 0
      } else {
        turnaround = 'bad'
        setupMinutes = event.setupMinutesOverride ?? settings.setupFloorMinutes
        earliestFirstPizzaTime = addMinutes(
          previousServiceEnd,
          settings.breakDownMinutes + event.driveMinutes + settings.setupFloorMinutes + rackMinutes
        )
        spareMinutes = 0
      }
    }

    const onSiteTime = addMinutes(event.firstPizzaTime, -(setupMinutes + rackMinutes))
    const leaveTime = addMinutes(onSiteTime, -event.driveMinutes)

    const naturalFireLitTime = isFirstOfDay
      ? addMinutes(event.firstPizzaTime, -settings.ovenToTempMinutes).getTime() <=
        addMinutes(leaveTime, -settings.fireBeforeLoadMinutes).getTime()
        ? addMinutes(event.firstPizzaTime, -settings.ovenToTempMinutes)
        : addMinutes(leaveTime, -settings.fireBeforeLoadMinutes)
      : null

    computed.push({
      id: event.id,
      rackMinutes,
      setupMinutes,
      onSiteTime,
      leaveTime,
      serviceEndTime,
      breakDownFinishTime,
      isFirstOfDay,
      naturalFireLitTime,
      spareMinutes,
      turnaround,
      earliestFirstPizzaTime
    })

    previousServiceEnd = serviceEndTime
  }

  const lastEvent = sorted.at(-1)
  const lastComputed = computed.at(-1)
  let backAtShopTime: Date | null = null
  let missingReturnDrive = false

  if (lastEvent && lastComputed) {
    if (lastEvent.driveMinutesBackToShop === null) {
      missingReturnDrive = true
    } else {
      backAtShopTime = addMinutes(lastComputed.breakDownFinishTime, lastEvent.driveMinutesBackToShop)
    }
  }

  return { events: computed, backAtShopTime, missingReturnDrive }
}
