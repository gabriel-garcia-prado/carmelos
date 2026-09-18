import { addMinutesToIso, diffMinutes, roundDownToHalfHour, roundUpToHalfHour } from '@/lib/board-time'
import { formatClockTime, formatDuration, formatLaneTime } from '@/lib/format'
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
  assignments: readonly AssignmentJson[]
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

export type AssignmentRoleJson = 'pizzaiolo' | 'stick' | 'cutter'

/** One person on one party — see `Assignment` on the API side. */
export type AssignmentJson = Readonly<{
  personId: string
  role: AssignmentRoleJson
  meetsOnSite: boolean
}>

export const pizzaioloOf = (assignments: readonly AssignmentJson[]): AssignmentJson | undefined =>
  assignments.find((assignment) => assignment.role === 'pizzaiolo')

export const stickOf = (assignments: readonly AssignmentJson[]): AssignmentJson | undefined =>
  assignments.find((assignment) => assignment.role === 'stick')

export type RigDayJson = Readonly<{
  rig: Rig
  label: string
  events: readonly DayEventJson[]
  backAtShopTime: string | null
  missingReturnDrive: boolean
  fireDuty: FireDutyJson | null
  consumables: ConsumablesJson
}>

/** A fire owed on a rig this viewer isn't shown — see `OutsideFireDuty` on the
 * API side. Empty for the operator, who can just look at the rig. */
export type OutsideFireDutyJson = Readonly<{
  rig: Rig
  label: string
  litAt: string
  litByPersonId: string
  truckId: string | null
}>

/** One person's day, added up — see `PersonShift` on the API side. */
export type PersonShiftJson = Readonly<{
  personId: string
  minutes: number
  parties: number
  guests: number
  pizzas: number
  firstIn: string
  lastOut: string
}>

export type DaySummaryJson = Readonly<{
  parties: number
  guests: number
  pizzas: number
  peopleWorking: number
  crewMinutes: number
  firstIn: string | null
  lastOut: string | null
  people: readonly PersonShiftJson[]
}>

export const EMPTY_SUMMARY: DaySummaryJson = {
  parties: 0,
  guests: 0,
  pizzas: 0,
  peopleWorking: 0,
  crewMinutes: 0,
  firstIn: null,
  lastOut: null,
  people: []
}

export type DayViewJson = Readonly<{
  date: string
  rigs: readonly RigDayJson[]
  fireDutyElsewhere: readonly OutsideFireDutyJson[]
  summary: DaySummaryJson
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
  /** A further line under `detail`, for something that must not be truncated
   * away. The special requests used to ride on the end of the address, which
   * is long enough on its own to push them past the edge of the lane — and
   * they're the one thing on a serve block you can't guess from the rest. */
  note?: string
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
 * The block's own ground, per kind — what a line of its text sits on.
 *
 * Fire is painted with a gradient and takes the colour it starts from: its
 * labels sit in the block's top-left corner, which is where the gradient still
 * is that colour.
 */
const LABEL_GROUND: Record<Block['kind'], string> = {
  fire: 'bg-ember-a shadow-[0_0_2px_1px_var(--ember-a)]',
  travel: 'bg-travel shadow-[0_0_2px_1px_var(--travel)]',
  work: 'bg-work shadow-[0_0_2px_1px_var(--work)]',
  rack: 'bg-serve shadow-[0_0_2px_1px_var(--serve)]',
  serve: 'bg-serve shadow-[0_0_2px_1px_var(--serve)]',
  spare: 'bg-spare shadow-[0_0_2px_1px_var(--spare)]'
}

/**
 * A patch of that ground behind one line of a block's text.
 *
 * It began as a fix for rack alone, whose dotted lattice has a dot centre
 * every 2px and furred up the glyph strokes crossing it. Every kind needs it
 * now that the current-time rule passes behind the writing: without a ground
 * of its own, the red line runs through the gaps between the letters.
 *
 * A pill rather than a rounded box, padded 4px a side so its edge runs through
 * the whitespace around the glyphs instead of hugging them; the negative
 * margin gives that padding back so the text still lines up with every other
 * block's label. The blurred shadow is the same colour as the patch, so it is
 * invisible except where it lands on something else — on rack that is what
 * stops dots being sliced in half at the pill's edge, since the pill is sized
 * by text metrics and has nothing in the lattice to snap to.
 */
export const labelMaskFor = (kind: Block['kind']): string =>
  `inline-block max-w-full truncate rounded-full -mx-0.5 px-0.5 ${LABEL_GROUND[kind]}`

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
/**
 * When one person is personally due at one party — the client-side mirror of
 * `arrivalTimeFor` on the API. Someone making their own way is due on site for
 * the start of set-up; whoever lights the fire is due at it; everyone else
 * rides out with the rig.
 */
export const arrivesOnSite = (event: DayEventJson, previous: DayEventJson | undefined, personId: string): boolean => {
  const assignment = event.assignments.find((candidate) => candidate.personId === personId)
  if (assignment?.meetsOnSite) return true
  if (event.computed.isFirstOfDay) return false
  // Joining partway through the rig's day without having worked the party
  // before it: there was no truck to ride out on.
  return !previous?.assignments.some((seat) => seat.personId === personId)
}

export const arrivalIsoFor = (
  people: readonly PersonLike[],
  settings: SettingsLike,
  first: DayEventJson,
  fireDuty: FireDutyJson | null,
  personId: string,
  previous?: DayEventJson
): string => {
  // Every branch here has to match `arrivalTimeFor` on the API, clause for
  // clause. Missing one drew a badge fifteen minutes before a departure the
  // person's own text put at the departure itself.
  if (arrivesOnSite(first, previous, personId)) return first.computed.onSiteTime

  const assignment = first.assignments.find((candidate) => candidate.personId === personId)
  const isFirstOfDay = first.computed.isFirstOfDay
  if (isFirstOfDay && fireDuty?.litByPersonId === personId) return fireDuty.litAt
  if (!isFirstOfDay) return first.computed.leaveTime
  if (fireDuty && assignment?.role === 'pizzaiolo') return fireDuty.ownArrivalTime
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
      detail: event.address,
      note: requestSummary || undefined,
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
      label: formatLaneTime(addMinutesToIso(windowStartIso, minute))
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
