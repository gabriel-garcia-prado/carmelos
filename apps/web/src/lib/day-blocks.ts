import { addMinutesToIso, diffMinutes, roundDownToHalfHour, roundUpToHalfHour } from '@/lib/board-time'
import { formatClockTime, formatDuration } from '@/lib/format'
import type { Rig } from '@/lib/rigs'
import { REQUEST_LABELS, type RequestType } from '@/lib/rigs'

export type Turnaround = 'fine' | 'tight' | 'bad'

type ComputedEventJson = Readonly<{
  id: string
  rackMinutes: number
  setupMinutes: number
  onSiteTime: string
  leaveTime: string
  serviceEndTime: string
  breakDownFinishTime: string
  isFirstOfDay: boolean
  naturalFireLitTime: string | null
  spareMinutes: number | null
  turnaround: Turnaround | null
  earliestFirstPizzaTime: string | null
}>

type SpecialRequestJson = Readonly<{ requestType: string; headcount: number }>

export type DayEventJson = Readonly<{
  id: string
  rig: Rig
  firstPizzaTime: string
  headcount: number
  address: string
  clientName: string | null
  driveMinutes: number
  pizzaioloId: string
  crewMemberId: string
  fireDutyOverridePersonId: string | null
  crewArrivalOverrideMinutes: number | null
  truckId: string | null
  specialRequests: readonly SpecialRequestJson[]
  computed: ComputedEventJson
}>

export type FireDutyJson = Readonly<{
  rigId: string
  litAt: string
  litByPersonId: string
  isCovered: boolean
  ownArrivalTime: string
}>

export type ConsumablesJson = Readonly<{
  totalPizzas: number
  doughCount: number
  cheeseBags: number
  sauceUnits: number
  trays: number
  glutenFreeDoughExtra: number
}>

export type RigDayJson = Readonly<{
  rig: Rig
  label: string
  events: readonly DayEventJson[]
  backAtShopTime: string | null
  missingReturnDrive: boolean
  fireDuty: FireDutyJson | null
  consumables: ConsumablesJson
}>

export type DayViewJson = Readonly<{
  date: string
  rigs: readonly RigDayJson[]
}>

export type PersonLike = Readonly<{ id: string; name: string; minutesBeforeDepartureOverride: number | null }>
export type SettingsLike = Readonly<{
  ovenToTempMinutes: number
  defaultMinutesBeforeDeparture: number
  spareFoldThresholdMinutes: number
  kitchenAddress: string | null
}>

export type Block = Readonly<{
  kind: 'fire' | 'travel' | 'work' | 'rack' | 'serve' | 'spare'
  top: number
  height: number
  label: string
  sublabel?: string
  /** Extra line shown only in the expanded (wide) lane — spec §11's real labels view. */
  detail?: string
  /** Set on the 'serve' and 'travel' blocks — the two that map 1:1 to a single event, so they're where the edit affordance and the traffic badge anchor. */
  eventId?: string
  /** Which event this block belongs to, for EVERY block derived from one —
   * including the set-up, rack and break-down segments that carry no
   * affordance of their own. Kept separate from `eventId` so marking a whole
   * chain (the new-event preview outlines one in green) doesn't also sprout
   * edit buttons and traffic badges on blocks that shouldn't have them. */
  ownerEventId?: string
}>

export const blockStyle: Record<Block['kind'], string> = {
  fire: 'bg-gradient-to-br from-ember-a to-ember-b text-ember-fg',
  travel: 'bg-travel text-travel-fg',
  work: 'bg-work text-work-fg',
  // Rack time is "both at once" — dough loading into an oven that's already
  // serving — so it's drawn as the service colour dotted in the set-up
  // colour, the dots staggered half a tile so the lattice runs diagonally.
  // The pattern lives in CSS variables (main.css) rather than here: it has to
  // hold up at both day-board and week-strip size, and the dev bar swaps the
  // spacing live while that's being judged.
  rack: 'bg-serve text-serve-fg [background-image:var(--rack-dots)] [background-size:var(--rack-dots-size)] [background-position:var(--rack-dots-pos)]',
  serve: 'bg-serve text-serve-fg',
  spare: 'bg-spare text-spare-fg'
}

/**
 * The same paint as the block, minus its text colour — for the legend swatch.
 * Taking the first class instead dropped everything after it: fire lost the
 * gradient's colour stops and rendered invisible, and rack lost its outline.
 */
export const legendSwatch = (kind: Block['kind']): string =>
  blockStyle[kind]
    .split(' ')
    .filter((className) => !className.startsWith('text-'))
    .join(' ')

export const nameOf = (people: readonly PersonLike[], id: string) =>
  people.find((person) => person.id === id)?.name ?? '?'

/** Resolution order matches the server's: this rig's override for today,
 * then the person's standing one, then the shop default. */
export const crewArrivalIso = (
  people: readonly PersonLike[],
  settings: SettingsLike,
  crewMemberId: string,
  leaveIso: string,
  rigOverrideMinutes: number | null = null
): string => {
  const minutesBeforeDeparture =
    rigOverrideMinutes ??
    people.find((person) => person.id === crewMemberId)?.minutesBeforeDepartureOverride ??
    settings.defaultMinutesBeforeDeparture
  return addMinutesToIso(leaveIso, -minutesBeforeDeparture)
}

/**
 * When one of a rig's two people is due at the shop. One rule, whoever they
 * are: if they're the one lighting this rig's fire they have to be there for
 * it, otherwise they come in their own lead time before the truck leaves —
 * or, for a pizzaiolo whose fire someone else covered, at the handover.
 *
 * Fire duty is what decides this, not the job title. The pizzaiolo lights it
 * most days, but handing the match to the crew member is a normal way to run
 * a morning, and then it's the crew member who comes in early and the
 * pizzaiolo who turns up at departure.
 */
export const arrivalIsoFor = (
  people: readonly PersonLike[],
  settings: SettingsLike,
  first: DayEventJson,
  fireDuty: FireDutyJson | null,
  personId: string
): string => {
  if (fireDuty?.litByPersonId === personId) return fireDuty.litAt
  if (fireDuty && personId === first.pizzaioloId) return fireDuty.ownArrivalTime
  return crewArrivalIso(people, settings, personId, first.computed.leaveTime, first.crewArrivalOverrideMinutes)
}

const specialRequestSummary = (requests: readonly SpecialRequestJson[]): string =>
  requests.map((request) => `${REQUEST_LABELS[request.requestType as RequestType]}×${request.headcount}`).join(', ')

/** The blocks for one rig's day, positioned in minutes from a shared window start (spec §3/§11 chain, drawn to scale). */
export const buildBlocks = (
  rig: RigDayJson,
  ovenToTempMinutes: number,
  windowStartIso: string,
  spareFoldThresholdMinutes: number
): Block[] => {
  const blocks: Block[] = []
  const sorted = [...rig.events].sort(
    (a, b) => new Date(a.firstPizzaTime).getTime() - new Date(b.firstPizzaTime).getTime()
  )
  const from = (iso: string) => diffMinutes(iso, windowStartIso)

  sorted.forEach((event, index) => {
    const previous = sorted[index - 1]

    if (event.computed.isFirstOfDay && rig.fireDuty) {
      const readyAt = addMinutesToIso(rig.fireDuty.litAt, ovenToTempMinutes)
      // The oven burns until the truck pulls out, not until it merely hits
      // temperature — ending the block at "ready" left a phantom gap where
      // the fire is still very much going.
      const burnsUntil = event.computed.leaveTime
      blocks.push({
        ownerEventId: event.id,
        kind: 'fire',
        top: from(rig.fireDuty.litAt),
        height: diffMinutes(burnsUntil, rig.fireDuty.litAt),
        label: 'Fire',
        sublabel: formatDuration(diffMinutes(burnsUntil, rig.fireDuty.litAt)),
        detail: `ready ${formatClockTime(readyAt)}`
      })
    }

    const spareMinutes = event.computed.spareMinutes ?? 0
    // A spare gap this short isn't worth its own sliver on the board — fold
    // it into the drive block instead of drawing a barely-visible strip.
    const foldSpareIntoDrive = Boolean(previous) && spareMinutes > 0 && spareMinutes < spareFoldThresholdMinutes

    if (previous && spareMinutes > 0 && !foldSpareIntoDrive) {
      blocks.push({
        ownerEventId: event.id,
        kind: 'spare',
        top: from(previous.computed.breakDownFinishTime),
        height: spareMinutes,
        label: 'Spare',
        sublabel: formatDuration(spareMinutes)
      })
    }

    blocks.push({
      ownerEventId: event.id,
      kind: 'travel',
      top:
        foldSpareIntoDrive && previous ? from(previous.computed.breakDownFinishTime) : from(event.computed.leaveTime),
      height: foldSpareIntoDrive ? event.driveMinutes + spareMinutes : event.driveMinutes,
      label: 'Drive',
      sublabel: formatDuration(foldSpareIntoDrive ? event.driveMinutes + spareMinutes : event.driveMinutes),
      detail: event.address,
      eventId: event.id
    })

    blocks.push({
      ownerEventId: event.id,
      kind: 'work',
      top: from(event.computed.onSiteTime),
      height: event.computed.setupMinutes,
      label: 'Set up',
      sublabel: formatDuration(event.computed.setupMinutes)
    })

    if (event.computed.rackMinutes > 0) {
      blocks.push({
        ownerEventId: event.id,
        kind: 'rack',
        top: from(addMinutesToIso(event.computed.onSiteTime, event.computed.setupMinutes)),
        height: event.computed.rackMinutes,
        label: 'Rack',
        sublabel: formatDuration(event.computed.rackMinutes)
      })
    }

    const requestSummary = specialRequestSummary(event.specialRequests)
    blocks.push({
      ownerEventId: event.id,
      kind: 'serve',
      top: from(event.firstPizzaTime),
      height: diffMinutes(event.computed.serviceEndTime, event.firstPizzaTime),
      // Who the party is for, when known — reads as "the Kaplan Bar Mitzvah"
      // instead of a generic "Serve" label, in both normal and expanded view.
      label: event.clientName ?? 'Serve',
      // Duration, not the start time — the start is already printed on the
      // gap line just above this block (see `buildBoundaries`).
      sublabel: `${formatDuration(diffMinutes(event.computed.serviceEndTime, event.firstPizzaTime))} · ${event.headcount}p`,
      detail: requestSummary ? `${event.address} · ${requestSummary}` : event.address,
      eventId: event.id
    })

    blocks.push({
      ownerEventId: event.id,
      kind: 'work',
      top: from(event.computed.serviceEndTime),
      height: diffMinutes(event.computed.breakDownFinishTime, event.computed.serviceEndTime),
      label: 'Down',
      sublabel: formatDuration(diffMinutes(event.computed.breakDownFinishTime, event.computed.serviceEndTime))
    })
  })

  const last = sorted.at(-1)
  if (last && rig.backAtShopTime) {
    blocks.push({
      // The run home is owned by whichever party was last — it exists only
      // because that one finished when it did, so it belongs to that chain.
      ownerEventId: last.id,
      kind: 'travel',
      top: from(last.computed.breakDownFinishTime),
      height: diffMinutes(rig.backAtShopTime, last.computed.breakDownFinishTime),
      label: 'Home',
      sublabel: formatDuration(diffMinutes(rig.backAtShopTime, last.computed.breakDownFinishTime))
    })
  }

  return blocks
}

export type Boundary = Readonly<{ top: number; label: string }>

/**
 * The clock times that sit BETWEEN blocks. Blocks carry durations ("1h"),
 * the gaps between them carry the times those durations run from — so the
 * lane reads as a running schedule instead of repeating the clock inside
 * every box. Consecutive blocks that start at the same minute collapse to a
 * single line.
 */
export const buildBoundaries = (
  blocks: readonly Block[],
  windowStartIso: string,
  // Moments worth a clock reading that aren't a block edge — crew arrivals
  // especially, which land mid-block whenever someone comes in while the
  // fire is already burning.
  extraIsoTimes: readonly string[] = []
): Boundary[] => {
  const seen = new Set<number>()
  const boundaries: Boundary[] = []
  const edges = [
    ...[...blocks].sort((a, b) => a.top - b.top).flatMap((block) => [block.top, block.top + block.height]),
    ...extraIsoTimes.map((iso) => diffMinutes(iso, windowStartIso))
  ]
  for (const edge of edges) {
    const minute = Math.round(edge)
    if (seen.has(minute)) continue
    seen.add(minute)
    // Compact ("9:00", "2:30") — these stack every few minutes down a
    // narrow gutter, and the day's own span already fixes am/pm.
    boundaries.push({
      top: minute,
      label: formatClockTime(addMinutesToIso(windowStartIso, minute)).replace(/\s?[AP]M$/, '')
    })
  }
  return boundaries.sort((a, b) => a.top - b.top)
}

export type DayWindow = Readonly<{ start: Date; end: Date; minutes: number }>

/** The window computed from the day itself (spec §11): earliest fire/arrival to latest return, rounded to the half hour. Null when nothing's booked. */
export const computeDayWindow = (dayView: DayViewJson): DayWindow | null => {
  const populated = dayView.rigs.filter((rig) => rig.events.length > 0)
  const allTimes = populated.flatMap((rig) => [
    rig.fireDuty?.litAt,
    ...rig.events.flatMap((event) => [event.computed.leaveTime, event.computed.breakDownFinishTime]),
    rig.backAtShopTime
  ])
  const validTimes = allTimes.filter((time): time is string => Boolean(time)).map((time) => new Date(time))
  if (validTimes.length === 0) return null

  const start = roundDownToHalfHour(new Date(Math.min(...validTimes.map((date) => date.getTime()))))
  const end = roundUpToHalfHour(new Date(Math.max(...validTimes.map((date) => date.getTime()))))
  return { start, end, minutes: Math.max(1, diffMinutes(end.toISOString(), start.toISOString())) }
}
