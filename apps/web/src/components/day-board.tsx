import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { TrafficBadge, WeatherBadges } from '@/components/event-status-badges'
import { diffMinutes, initialsOf } from '@/lib/board-time'
import type { AssignmentJson, DayViewJson, PersonLike, RigDayJson, SettingsLike, Turnaround } from '@/lib/day-blocks'
import {
  arrivalIsoFor,
  blockStyle,
  buildBlocks,
  buildBoundaries,
  computeDayWindow,
  labelMaskFor,
  legendSwatch,
  nameOf,
  pizzaioloOf,
  stickOf
} from '@/lib/day-blocks'
import { formatLaneTime, toDateKey } from '@/lib/format'
import type { Rig } from '@/lib/rigs'
import { RIGS } from '@/lib/rigs'

// Mobile-first: lanes are sized by weight and laid out as percentages of the
// available width, so the board never overflows horizontally — it just gets
// narrower. Tapping a lane expands it and shrinks the rest to colour-only
// strips (spec's "Pizzaiolo" view — one rig wide with real labels, the
// others collapsed to strips at the same vertical positions).
const BASE_WEIGHT = 3
const EXPANDED_WEIGHT = 6
const COLLAPSED_WEIGHT = 1
const IDLE_WEIGHT = 1
const GAP_WEIGHT = 0.15
const PX_PER_MIN = 1
// Left-hand strip inside each lane reserved for the clock time at every
// block seam, so those labels never sit on top of a block's own text.
const TIME_GUTTER = 26
// Blocks are inset from their lane by this much on the left; the header sits
// on exactly the same span so the column reads as one width top to bottom.
const BLOCK_INSET = 2
// Matches the blocks' own `rounded` (0.25rem). A divider that lands on a
// block's top or bottom edge is inset by this at both ends so it stops where
// the corner starts to bend instead of carrying on over the curve.
const BLOCK_RADIUS = 4
// A row of moment badges measures 16px tall; two rows that would overlap are
// pushed this far apart so neither is hidden.
const BADGE_ROW_HEIGHT = 17
// Vehicle name, then the crew chips.
const HEADER_HEIGHT = 46

/** One chip pinned to a moment on a lane: an arrival, the opener covering
 * this rig's fire, or a fire this lane's opener also has to light elsewhere. */
type MomentBadge = Readonly<{
  key: string
  top: number
  label: string
  hasFire: boolean
  /** The whole name, for the pinned chips — trimmed to fit at render time. */
  fullName?: string
  tone: 'pizzaiolo' | 'crew' | 'away'
  /** Shown only in the expanded lane — true only for the other-rig fire tags,
   * where the flame alone still says "there's another fire on the way in" and
   * the rig name isn't worth the width until someone opens the lane up. */
  labelOptional: boolean
}>

// The lanes resize on a bare `transition-all`, i.e. Tailwind's 150ms default.
// Anything animating alongside them has to run on the same clock: at 300ms the
// lane finished widening first and the half-grown badges overflowed it, which
// bounced the row onto a second line and back.
const BADGE_SLIDE = 'transition-all duration-150 ease-out'

const BADGE_BASE =
  'flex items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap rounded-full font-mono font-semibold'

const badgeSize = (compact: boolean): string => (compact ? 'h-4 min-w-4 px-0.5 text-[7px]' : 'px-1.5 py-0.5 text-[8px]')

/**
 * Everyone working a rig today, in seat order, each person once.
 *
 * A rig no longer has one crew for the whole day — a stick can be replaced at
 * lunchtime — so the header answers "who's on this rig" with the union rather
 * than with whichever party happens to be first.
 */
const dedupeBySeat = (events: readonly RigDayJson['events'][number][]): readonly AssignmentJson[] => {
  const order: readonly AssignmentJson['role'][] = ['pizzaiolo', 'stick', 'cutter']
  const seen = new Map<string, AssignmentJson>()
  for (const event of events) {
    for (const assignment of event.assignments) {
      if (!seen.has(assignment.personId)) seen.set(assignment.personId, assignment)
    }
  }
  return [...seen.values()].sort((first, second) => order.indexOf(first.role) - order.indexOf(second.role))
}

/**
 * As much of a name as the space can hold: all of it, a shortened form, or
 * just the initials.
 *
 * The widths are estimates off the mono font's advance — 4.2px a character at
 * 7px, 4.9px at 8px — because measuring every candidate string per render to
 * get the exact answer costs a layout pass for a chip a centimetre wide. Being
 * a few pixels pessimistic only means falling back a tier early.
 */
const fitName = (name: string, budgetPx: number, compact: boolean): string => {
  const charPx = compact ? 4.2 : 4.9
  const room = Math.floor(budgetPx / charPx)
  if (room >= name.length) return name
  // Below four characters an abbreviation says less than the initials do, and
  // costs the ellipsis to say it.
  if (room >= 4) return `${name.slice(0, room - 1)}…`
  return initialsOf(name)
}

const badgeTone = (tone: MomentBadge['tone']): string =>
  tone === 'pizzaiolo'
    ? 'bg-card text-foreground ring-1 ring-inset ring-foreground'
    : tone === 'crew'
      ? 'bg-foreground text-background ring-1 ring-inset ring-background'
      : 'bg-fired text-white'

/**
 * The line across the lane takes the colour of the badge sitting on it — the
 * ring above, or for the red tag its fill, since it has no ring of its own.
 * Kept next to `badgeTone` because it restates that function's colours: change
 * one without the other and the line stops matching its badge.
 */
const momentLineColor = (tone: MomentBadge['tone']): string =>
  tone === 'pizzaiolo' ? 'var(--foreground)' : tone === 'crew' ? 'var(--background)' : 'var(--fired)'

/**
 * Which badge lends the line its colour when several land on one minute.
 * Running the rig outranks working on it, which outranks a fire owed on a rig
 * that isn't this one — the order of how much the moment is about this lane.
 */
const TONE_PRIORITY: readonly MomentBadge['tone'][] = ['pizzaiolo', 'crew', 'away']

export type TruckLike = Readonly<{ id: string; name: string; shortName: string | null }>

/** The truck's own abbreviation, or the first word of its name when it hasn't
 * been given one — what a lane shows once it's squeezed to a sliver. */
const shortLabelOf = (truck: TruckLike | undefined, fallback: string): string =>
  truck?.shortName ?? (truck?.name ?? fallback).split(' ')[0]?.toUpperCase() ?? fallback

export type DayBoardProperties = Readonly<{
  dayView: DayViewJson
  people: readonly PersonLike[]
  settings: SettingsLike
  trucks: readonly TruckLike[]
  onEditEvent: (eventId: string) => void
  onEditRigCrew: (rig: Rig) => void
  /**
   * Whether to offer the edit affordances at all. False for a crew or
   * pizzaiolo login, who can read their day but not rewrite it - the API
   * refuses those writes regardless, so this only keeps the board honest
   * about what it offers.
   */
  canEdit: boolean
  /**
   * Open the lane on sight when it's the only one there is.
   *
   * The collapsed lane exists so several rigs fit side by side; someone who
   * only ever sees their own has nothing to compare it against, and a
   * collapsed single column is just a narrower version of the same thing with
   * the labels taken away.
   */
  expandSoleRig: boolean
}>

export const DayBoard = ({
  dayView,
  people,
  settings,
  trucks,
  onEditEvent,
  onEditRigCrew,
  canEdit,
  expandSoleRig
}: DayBoardProperties) => {
  const [chosenRig, setChosenRig] = useState<Rig | null>(null)

  // Lane widths are percentages, and a name has to be fitted in pixels, so the
  // board measures itself once and on resize. Zero until the first measurement
  // lands, which `fitName` reads as "no idea yet" and answers with initials —
  // the safe end, since a too-long name is what breaks the row.
  const lanesRef = useRef<HTMLDivElement>(null)
  const [lanesWidth, setLanesWidth] = useState(0)
  useEffect(() => {
    const element = lanesRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => setLanesWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Read once at mount and then on every minute boundary, so a board left open
  // doesn't keep pointing at whatever o'clock it happened to load at. Aligned
  // to the next whole minute first: a bare 60s interval would drift to
  // whenever this mounted and land the marker mid-minute for the rest of the
  // session.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined
    const timeout = setTimeout(
      () => {
        setNow(new Date())
        interval = setInterval(() => setNow(new Date()), 60_000)
      },
      60_000 - (Date.now() % 60_000)
    )
    return () => {
      clearTimeout(timeout)
      if (interval) clearInterval(interval)
    }
  }, [])

  const populated = dayView.rigs.filter((rig) => rig.events.length > 0)
  const idle = dayView.rigs.filter((rig) => rig.events.length === 0)

  // A forced expansion beats the click state rather than seeding it: seeding
  // would go stale the moment the day's data arrived or changed.
  const soleRig = expandSoleRig && populated.length === 1 ? (populated[0]?.rig ?? null) : null
  const expandedRig = soleRig ?? chosenRig

  const orderedPopulated = [...populated].sort((a, b) => {
    const aTime = new Date(a.fireDuty?.litAt ?? a.events[0]?.computed.leaveTime ?? 0).getTime()
    const bTime = new Date(b.fireDuty?.litAt ?? b.events[0]?.computed.leaveTime ?? 0).getTime()
    return aTime - bTime
  })
  const orderedIdle = RIGS.filter((rig) => idle.some((idleRig) => idleRig.rig === rig)).map(
    (rig) => idle.find((idleRig) => idleRig.rig === rig) as RigDayJson
  )
  const ordered = [...orderedPopulated, ...orderedIdle]

  const window_ = computeDayWindow(dayView)
  if (ordered.length === 0 || !window_) return null
  const { start: windowStart, minutes: windowMinutes } = window_
  const boardHeight = windowMinutes * PX_PER_MIN

  const weightFor = (rig: RigDayJson): number => {
    if (rig.events.length === 0) return IDLE_WEIGHT
    if (expandedRig === null) return BASE_WEIGHT
    return rig.rig === expandedRig ? EXPANDED_WEIGHT : COLLAPSED_WEIGHT
  }

  // Percentages of the lanes area (the axis is a fixed-width sibling, not
  // part of this 0-100 scale), so the whole board always fits its container.
  const totalWeight = ordered.reduce((sum, rig) => sum + weightFor(rig), 0) + GAP_WEIGHT * (ordered.length - 1)
  const offsets = new Map<Rig, { leftPct: number; widthPct: number }>()
  let cursor = 0
  for (const rig of ordered) {
    const weight = weightFor(rig)
    offsets.set(rig.rig, { leftPct: (cursor / totalWeight) * 100, widthPct: (weight / totalWeight) * 100 })
    cursor += weight + GAP_WEIGHT
  }

  const minutesFromStart = (iso: string) => diffMinutes(iso, windowStart.toISOString())

  // The current-time line only makes sense on today's board.
  const nowMinutes = diffMinutes(now.toISOString(), windowStart.toISOString())
  const nowVisible = dayView.date === toDateKey(now) && nowMinutes >= 0 && nowMinutes <= windowMinutes
  const nowTop = nowMinutes * PX_PER_MIN

  return (
    <div className="w-full space-y-2 rounded-lg border bg-card p-3 sm:p-4">
      {/* Lane headers */}
      {/* A floor, not a fixed height: a rig running three or four hands wraps
          its chips onto a second line, and a fixed header let that line spill
          out of the bottom and land on the first badge row in the lane below. */}
      <div className="relative flex" style={{ minHeight: HEADER_HEIGHT }}>
        <div className="relative flex-1">
          {ordered.map((rig) => {
            const offset = offsets.get(rig.rig)
            if (!offset) return null
            const isIdle = rig.events.length === 0
            const isCollapsed = !isIdle && expandedRig !== null && rig.rig !== expandedRig
            const isExpanded = !isIdle && rig.rig === expandedRig
            const worstTurnaround = rig.events.reduce<Turnaround | null>((worst, event) => {
              if (event.computed.turnaround === 'bad' || worst === 'bad')
                return event.computed.turnaround === 'bad' ? 'bad' : worst
              if (event.computed.turnaround === 'tight') return 'tight'
              return worst
            }, null)
            const hasStar = rig.events.some((event) => event.specialRequests.length > 0)
            // Everyone who works this rig today, in seat order, first
            // appearance wins. The union rather than one party's crew: with a
            // stick who only does the afternoon, no single party answers "who's
            // on this rig".
            const crewToday = dedupeBySeat(rig.events)
            // The lane is titled by the vehicle it's actually taking out, not
            // by the rig slot — that's what the crew turns up to, and it makes
            // a truck swap read straight off the two headers with no subtitle.
            const runningTruckId = (() => {
              const first = [...rig.events].sort((a, b) => a.firstPizzaTime.localeCompare(b.firstPizzaTime))[0]
              return first ? (first.truckId ?? rig.rig) : rig.rig
            })()
            const runningTruck = trucks.find((truck) => truck.id === runningTruckId)
            const laneLabel = runningTruck?.name ?? rig.label
            const laneShortLabel = shortLabelOf(runningTruck, rig.label)

            return (
              // A div, not a button: the non-idle/expanded state needs to
              // nest a real edit-crew button inside it, and a <button> can't
              // validly contain another interactive control.
              // biome-ignore lint/a11y/useSemanticElements: needs to contain a nested <button> (the edit-crew icon), which a real <button> can't do
              <div
                key={rig.rig}
                role="button"
                tabIndex={isIdle ? -1 : 0}
                onClick={() => !isIdle && setChosenRig((current) => (current === rig.rig ? null : rig.rig))}
                onKeyDown={(keyEvent) => {
                  if (isIdle || (keyEvent.key !== 'Enter' && keyEvent.key !== ' ')) return
                  keyEvent.preventDefault()
                  setChosenRig((current) => (current === rig.rig ? null : rig.rig))
                }}
                className={
                  isIdle
                    ? 'absolute rounded border border-dashed border-border text-center transition-all'
                    : `absolute cursor-pointer rounded px-1 py-1.5 text-center font-mono uppercase tracking-wide transition-all ${
                        worstTurnaround === 'bad'
                          ? 'ring-2 ring-bad'
                          : worstTurnaround === 'tight'
                            ? 'ring-2 ring-warn'
                            : ''
                      }`
                }
                style={{
                  // Matches the blocks below exactly — same left gutter, same
                  // right inset — so a rig is one continuous column.
                  left: `calc(${offset.leftPct}% + ${isCollapsed || isIdle ? BLOCK_INSET : TIME_GUTTER}px)`,
                  width: `calc(${offset.widthPct}% - ${BLOCK_INSET + (isCollapsed || isIdle ? BLOCK_INSET : TIME_GUTTER)}px)`,
                  minHeight: HEADER_HEIGHT,
                  ...(isIdle ? {} : { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' })
                }}
              >
                {isIdle ? (
                  <span className="flex h-full items-center justify-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Free
                  </span>
                ) : isCollapsed ? (
                  <div className="flex h-full flex-col items-center justify-center gap-0.5">
                    <span className="text-[9px] font-semibold">{laneShortLabel}</span>
                    <div className="flex items-center gap-0.5">
                      {crewToday.map((assignment) => (
                        <span
                          key={assignment.personId}
                          className={`flex h-3.5 w-3.5 items-center justify-center rounded-full text-[6px] font-semibold ${
                            assignment.role === 'pizzaiolo'
                              ? 'bg-card text-foreground ring-1 ring-inset ring-foreground'
                              : 'bg-foreground text-background ring-1 ring-inset ring-background'
                          }`}
                        >
                          {initialsOf(nameOf(people, assignment.personId))}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Editing affordances belong to the lane you've opened.
                        At base width four rigs each carry a pencil, which is
                        four targets competing with the tap that expands the
                        lane in the first place — and at that size the header
                        has barely room for the vehicle name and two chips. */}
                    {isExpanded && canEdit ? (
                      <button
                        type="button"
                        title={`Edit ${rig.label}'s crew`}
                        onClick={(clickEvent) => {
                          clickEvent.stopPropagation()
                          onEditRigCrew(rig.rig)
                        }}
                        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-md bg-primary-foreground text-primary hover:opacity-90"
                      >
                        <Pencil className="h-2.5 w-2.5" />
                      </button>
                    ) : null}
                    {/* Star sits inline with the title, same font/size/weight,
                        so it reads as part of the label. It's a sibling of the
                        truncating text (not a child) so `truncate` only clips
                        the label itself, never the star. */}
                    <div className="flex items-center justify-center gap-1 text-[11px] font-semibold sm:text-xs">
                      {hasStar ? <span className="text-primary-foreground">★</span> : null}
                      <span className="truncate">{laneLabel}</span>
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-nowrap items-center justify-center gap-1 normal-case">
                      {/* Pizzaiolo is the solid chip; everyone else is the
                          outlined opposite. Fire coverage is conveyed on the
                          timeline, not by dimming a header badge (which made it
                          indistinguishable from the stick's outlined chip).

                          One line, truncating, rather than wrapping. The header
                          is a fixed height with absolutely-positioned lanes
                          inside it, so a wrapped second line can't push it
                          taller — it spills out of the bottom and lands on the
                          first badge row in the lane below, hiding whoever is
                          on it. A shortened name is recoverable; a name sitting
                          underneath a badge just looks like a rendering fault. */}
                      {crewToday.map((assignment) => (
                        <span
                          key={assignment.personId}
                          className={`min-w-0 truncate rounded-full px-1.5 py-0.5 text-[8px] font-semibold ${
                            assignment.role === 'pizzaiolo'
                              ? 'bg-card text-foreground ring-1 ring-inset ring-foreground'
                              : 'bg-foreground text-background ring-1 ring-inset ring-background'
                          }`}
                        >
                          {nameOf(people, assignment.personId)}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Lanes. No hour axis or gridlines any more — every lane prints the
          clock time at each of its own block seams, which is the thing those
          were there to let you read. */}
      <div className="flex" style={{ height: boardHeight }}>
        <div className="relative flex-1" ref={lanesRef}>
          {/* In front of the block fills, behind everything written on them.
              Drawn first in the lanes' own stacking context and lifted with a
              z-index rather than moved later in the DOM: paint order alone
              would put it over the labels too, and a red rule struck through
              the text is worse than not seeing the line at all. Nothing
              between here and the raised elements may take a z-index of its
              own, or they lose the ability to sit above this. */}
          {nowVisible ? (
            <div
              className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-fired"
              style={{ top: nowTop }}
              aria-hidden="true"
            />
          ) : null}

          {ordered.map((rig) => {
            const offset = offsets.get(rig.rig)
            if (!offset) return null

            if (rig.events.length === 0) {
              return (
                <div
                  key={rig.rig}
                  className="absolute rounded border border-dashed border-border transition-all"
                  style={{ left: `${offset.leftPct}%`, width: `${offset.widthPct}%`, top: 0, height: boardHeight }}
                />
              )
            }

            const isCollapsed = expandedRig !== null && rig.rig !== expandedRig
            const isExpanded = expandedRig === rig.rig
            const blocks = buildBlocks(
              rig,
              settings.ovenToTempMinutes,
              windowStart.toISOString(),
              settings.spareFoldThresholdMinutes
            )
            // Clock times live on the seams between blocks, so each block
            // only has to carry how long it lasts. Declared after `arrivals`
            // below, which contributes the crew/pizzaiolo arrival moments —
            // those fall mid-block, so they'd otherwise have no clock at all.

            // The full hurry window for a tight/bad event — break down
            // (finishing the previous party), drive, and set up, ending at
            // this event's first pizza — not the rig's whole day. The
            // header above still rings for the whole rig.
            const sortedEvents = [...rig.events].sort(
              (a, b) => new Date(a.firstPizzaTime).getTime() - new Date(b.firstPizzaTime).getTime()
            )
            const hurryRings = sortedEvents.flatMap((event, index) => {
              if (event.computed.turnaround !== 'tight' && event.computed.turnaround !== 'bad') return []
              const previous = sortedEvents[index - 1]
              if (!previous) return []
              return [
                {
                  key: `${event.id}-hurry`,
                  severity: event.computed.turnaround,
                  top: minutesFromStart(previous.computed.serviceEndTime) * PX_PER_MIN,
                  bottom: minutesFromStart(event.firstPizzaTime) * PX_PER_MIN
                }
              ]
            })

            const firstEvent = rig.events[0]
            const pizzaioloId = firstEvent ? pizzaioloOf(firstEvent.assignments)?.personId : undefined
            const crewMemberId = firstEvent ? stickOf(firstEvent.assignments)?.personId : undefined
            // One circle per person — even when two arrive at the same moment
            // they stay separate chips side by side rather than merging into
            // one label, so it's always clear who's who.
            const labelFor = (personId: string) => nameOf(people, personId)
            // When this rig's own pizzaiolo lights their own fire, their
            // arrival IS the fire-lighting moment — one badge (name + 🔥),
            // not a separate fire pill sitting right on top of their circle.
            // Who actually strikes the match, not whether the optimizer chose
            // them: a manual fire-duty override leaves `isCovered` false while
            // still handing the job to someone else entirely, so keying off
            // that flag credited the fire to this rig's pizzaiolo regardless.
            // ...and either of this rig's OWN two people counts as its own
            // fire: handing the match to the crew member is a normal way to
            // run a morning, and it's still nobody arriving from elsewhere.
            const pizzaioloLightsOwnFire = Boolean(rig.fireDuty) && rig.fireDuty?.litByPersonId === pizzaioloId
            const crewLightsOwnFire = Boolean(rig.fireDuty) && rig.fireDuty?.litByPersonId === crewMemberId
            const litByOwnCrew = pizzaioloLightsOwnFire || crewLightsOwnFire
            /**
             * One badge per person, at the first moment they're personally
             * due on this rig.
             *
             * Keyed by person rather than by seat, because a stick who works
             * both parties arrives once — a second badge at the later party
             * would read as a second trip in. Someone who joins only for the
             * afternoon gets theirs at their own hour, which is the whole
             * point of tracking arrivals per person.
             *
             * The pizzaiolo is the solid chip and everyone else outlined —
             * fire coverage is conveyed by the red pill, not by which one
             * looks "filled".
             */
            const arrivals = rig.fireDuty
              ? [
                  ...rig.events
                    .flatMap((event, index) =>
                      event.assignments.map((assignment) => ({
                        assignment,
                        atIso: arrivalIsoFor(
                          people,
                          settings,
                          event,
                          rig.fireDuty,
                          assignment.personId,
                          rig.events[index - 1]
                        )
                      }))
                    )
                    .sort((first, second) => first.atIso.localeCompare(second.atIso))
                    .reduce((earliest, entry) => {
                      if (earliest.has(entry.assignment.personId)) return earliest
                      earliest.set(entry.assignment.personId, entry)
                      return earliest
                    }, new Map<string, { assignment: AssignmentJson; atIso: string }>())
                    .values()
                ].map(({ assignment, atIso }) => ({
                  key: assignment.personId,
                  atIso,
                  label: labelFor(assignment.personId),
                  filled: assignment.role === 'pizzaiolo',
                  hasFire: rig.fireDuty?.litByPersonId === assignment.personId
                }))
              : []

            // Who lit this rig's fire — only shown as its own (all-red) pill
            // when someone from ANOTHER rig covered it; when this rig's own
            // pizzaiolo lit it, that's a small decoration on their arrival
            // badge instead (see `hasFire` above) — normal colour, not red,
            // since red is reserved for "someone from elsewhere is here."
            const fireBadge =
              rig.fireDuty && !litByOwnCrew
                ? {
                    top: minutesFromStart(rig.fireDuty.litAt) * PX_PER_MIN,
                    label: initialsOf(nameOf(people, rig.fireDuty.litByPersonId))
                  }
                : null

            // When this rig's own opener is ALSO covering another rig's
            // fire, that other duty doesn't show anywhere on their own
            // lane otherwise — a small tag here says "then go light X too."
            // Positioned at the moment THAT rig's fire is lit (not this
            // rig's), so it sits level with that rig's own fire badge and
            // reads as a time on the same clock as everything else.
            const alsoLights = litByOwnCrew
              ? dayView.rigs.flatMap((other) =>
                  other.rig !== rig.rig &&
                  other.fireDuty &&
                  other.fireDuty.litByPersonId === rig.fireDuty?.litByPersonId &&
                  // ...and it isn't simply that rig's own pizzaiolo doing it.
                  other.fireDuty.litByPersonId !==
                    (other.events[0] && pizzaioloOf(other.events[0].assignments)?.personId)
                    ? [
                        {
                          rig: other.rig,
                          label: shortLabelOf(
                            trucks.find(
                              (truck) =>
                                truck.id ===
                                ([...other.events].sort((a, b) => a.firstPizzaTime.localeCompare(b.firstPizzaTime))[0]
                                  ?.truckId ?? other.rig)
                            ),
                            other.label
                          ),
                          top: minutesFromStart(other.fireDuty.litAt) * PX_PER_MIN,
                          atIso: other.fireDuty.litAt,
                          personId: other.fireDuty.litByPersonId
                        }
                      ]
                    : []
                )
              : []

            // A viewer who only sees their own rig has had the covered rig cut
            // out of the response entirely, so the scan above finds nothing.
            // The duty still travelled with them — it arrives as its own list.
            const alsoLightsElsewhere = dayView.fireDutyElsewhere.flatMap((duty) =>
              duty.litByPersonId === pizzaioloId || duty.litByPersonId === crewMemberId
                ? [
                    {
                      rig: duty.rig,
                      label: shortLabelOf(
                        trucks.find((truck) => truck.id === (duty.truckId ?? duty.rig)),
                        duty.label
                      ),
                      top: minutesFromStart(duty.litAt) * PX_PER_MIN,
                      atIso: duty.litAt,
                      personId: duty.litByPersonId
                    }
                  ]
                : []
            )

            // Computed here rather than up with the blocks because the away
            // fires feed it: their hour belongs in the gutter with every other
            // clock reading on the lane, not printed on the tag itself, where
            // it was the one time on the board written somewhere different
            // from all the others.
            const boundaries = isCollapsed
              ? []
              : buildBoundaries(blocks, windowStart.toISOString(), [
                  ...arrivals.map((arrival) => arrival.atIso),
                  ...[...alsoLights, ...alsoLightsElsewhere].flatMap((tag) => (tag.atIso ? [tag.atIso] : []))
                ])

            // Everything that pins to a moment on this lane, in one list: the
            // two arrivals, a red pill for an opener covering from elsewhere,
            // and a "→ RIG 🔥" tag per fire this lane's opener also lights.
            // They all compete for the same few pixels, and three of them
            // landing on one minute is routine once fires get bundled — so
            // they're laid out together rather than as three passes that each
            // assumed they had the moment to themselves.
            const awayTags = [...alsoLights, ...alsoLightsElsewhere]
            const sameMoment = (first: number, second: number) => Math.round(first) === Math.round(second)

            const momentBadges: MomentBadge[] = [
              ...arrivals.map((arrival) => {
                const top = minutesFromStart(arrival.atIso) * PX_PER_MIN
                return {
                  key: arrival.key,
                  top,
                  label: arrival.label,
                  fullName: arrival.label,
                  hasFire: arrival.hasFire,
                  tone: arrival.filled ? ('pizzaiolo' as const) : ('crew' as const),
                  labelOptional: false
                }
              }),
              ...(fireBadge
                ? [
                    {
                      key: 'covering',
                      top: fireBadge.top,
                      label: fireBadge.label,
                      hasFire: true,
                      tone: 'away' as const,
                      // Who is lighting THIS rig's fire is identity, not
                      // decoration — it stays legible however narrow the lane.
                      labelOptional: false
                    }
                  ]
                : []),
              ...awayTags.map((tag) => ({
                key: `also-${tag.rig}`,
                top: tag.top,
                label: tag.label,
                hasFire: true,
                tone: 'away' as const,
                labelOptional: true
              }))
            ]

            // The rule across the lane that ties a badge to its moment, taken
            // straight off the badges so the two can't disagree about either
            // where a moment is or what colour it is. Keyed by minute, so
            // several badges on one minute draw a single line rather than a
            // stack of them; the top stays the unrounded pixel, so the line
            // still lands exactly where its badges do.
            const momentLines = [
              ...momentBadges
                .reduce((lines, badge) => {
                  const minute = Math.round(badge.top)
                  const existing = lines.get(minute)
                  if (!existing || TONE_PRIORITY.indexOf(badge.tone) < TONE_PRIORITY.indexOf(existing.tone)) {
                    lines.set(minute, { top: badge.top, tone: badge.tone })
                  }
                  return lines
                }, new Map<number, { top: number; tone: MomentBadge['tone'] }>())
                .entries()
            ]

            // Same moment means the same row, sitting side by side. Rows that
            // would still overlap after that are pushed down in time order, so
            // a badge is never hidden behind another.
            /**
             * Moments close enough to collide share one row, side by side.
             *
             * Height on this lane means time, so a badge shunted downwards to
             * dodge another is reading as a later hour than the one it belongs
             * to — which is worse than sharing. Anything within a row's height
             * of the cluster it starts therefore joins it, and the row sits at
             * the average of the moments in it. The exact clock readings are in
             * the gutter either way: every badge moment is fed to
             * `buildBoundaries`, so a cluster is bracketed by its own times.
             */
            const badgeRows = [...new Set(momentBadges.map((badge) => badge.top))]
              .sort((first, second) => first - second)
              .reduce<number[][]>((clusters, top) => {
                const current = clusters[clusters.length - 1]
                if (current && top - (current[0] as number) < BADGE_ROW_HEIGHT) current.push(top)
                else clusters.push([top])
                return clusters
              }, [])
              .map((tops) => ({
                top: tops.reduce((sum, top) => sum + top, 0) / tops.length,
                badges: momentBadges.filter((badge) => tops.includes(badge.top))
              }))

            return (
              // biome-ignore lint/a11y/useSemanticElements: needs to contain nested <button>s (edit icons), which a real <button> can't do
              <div
                key={rig.rig}
                role="button"
                tabIndex={0}
                onClick={() => setChosenRig((current) => (current === rig.rig ? null : rig.rig))}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return
                  keyEvent.preventDefault()
                  setChosenRig((current) => (current === rig.rig ? null : rig.rig))
                }}
                className="absolute cursor-pointer rounded bg-muted/40 transition-all"
                style={{ left: `${offset.leftPct}%`, width: `${offset.widthPct}%`, top: 0, height: boardHeight }}
              >
                {blocks.map((block) => {
                  const sourceEvent = block.eventId ? sortedEvents.find((event) => event.id === block.eventId) : null
                  const hasStar = block.kind === 'serve' && Boolean(sourceEvent?.specialRequests.length)
                  const labelMask = labelMaskFor(block.kind)
                  // Wrapping costs a line, so it's only on offer where there's
                  // a line spare. 32px is the measured two-line height, the
                  // same figure the detail row below is gated on.
                  const canWrapLabel = block.height * PX_PER_MIN >= 32

                  return (
                    <div
                      key={`${block.kind}-${block.top}`}
                      className={`absolute overflow-hidden rounded font-mono leading-tight transition-all ${blockStyle[block.kind]} ${
                        isCollapsed
                          ? ''
                          : // Fire blocks get extra top clearance — the
                            // centered fire+arrival badge sits right at this
                            // block's own top edge, and would otherwise land
                            // on top of the "Fire H:MM" label's first line.
                            `px-1.5 pb-0.5 text-[10px] ${block.kind === 'fire' ? 'pt-3' : 'pt-0.5'}`
                      }`}
                      style={{
                        // Blocks start after the seam-time gutter, except when
                        // collapsed to a sliver where the times aren't drawn.
                        left: isCollapsed ? BLOCK_INSET : TIME_GUTTER,
                        right: BLOCK_INSET,
                        top: block.top * PX_PER_MIN,
                        // Drive blocks get a taller floor than the general
                        // anti-invisibility minimum — a 5-minute hop still
                        // needs room for its own label.
                        height: Math.max(block.kind === 'travel' ? 15 : 2, block.height * PX_PER_MIN)
                      }}
                    >
                      {!isCollapsed && block.height * PX_PER_MIN >= (isExpanded ? 11 : 14) ? (
                        // Positioned only to earn a z-index, so the current-time
                        // rule passes behind the writing on the block — and
                        // deaf to the mouse, because that z-index also lifts it
                        // over the block's own edit pencil and traffic link,
                        // which carry none. Nothing in here is clickable, so
                        // letting clicks through costs nothing and means a
                        // control added to a block later can't be swallowed by
                        // a label sitting on top of it.
                        <div className="pointer-events-none relative z-[18]">
                          {/* Name and duration share a line where they fit: the
                              duration used to cost a whole row of its own,
                              which on a short block meant showing "Drive" and
                              having no room left to say how long it was — the
                              one thing the block is there to answer.

                              Where they don't fit, the duration drops to the
                              next line rather than the name being eaten to make
                              room. That needs a second line's worth of height,
                              so a block too short for one keeps the old
                              behaviour: hold one line and shrink the name.

                              Inline, not an absolute overlay — this box clips
                              overflow, and an overlay star sat on top of the
                              label's own first letter. */}
                          <div
                            className={`flex items-baseline gap-1 font-semibold ${
                              canWrapLabel ? 'flex-wrap' : 'flex-nowrap'
                            }`}
                          >
                            <span className={`${labelMask} ${canWrapLabel ? 'max-w-full' : 'min-w-0'}`}>
                              {hasStar ? '★ ' : ''}
                              {block.label}
                            </span>
                            {block.sublabel ? (
                              <span className={`${labelMask} shrink-0 font-normal opacity-80`}>{block.sublabel}</span>
                            ) : null}
                          </div>
                          {/* Now the second line rather than the third. 32px
                              is measured, not guessed: one line of this text
                              occupies 17px and two occupy 32px including the
                              block's own padding. A 20-minute drive is 20px
                              tall, so anything lower than this renders an
                              address the block then cuts in half. */}
                          {block.detail && isExpanded && block.height * PX_PER_MIN >= 32 ? (
                            <div className="opacity-70">
                              <span className={labelMask}>{block.detail}</span>
                            </div>
                          ) : null}
                          {/* Third line, so it needs a third line's worth of
                              room. Measured like the others: 17px for one line,
                              32 for two, 48 for three. */}
                          {block.note && isExpanded && block.height * PX_PER_MIN >= 48 ? (
                            <div className="opacity-70">
                              <span className={labelMask}>{block.note}</span>
                            </div>
                          ) : null}
                        </div>
                      ) : hasStar && isCollapsed ? (
                        // No explicit text colour — inherits the block's own
                        // `text-serve-fg` (this is always a serve block), so
                        // it stays legible instead of the theme's default
                        // foreground colour washing out against a light block.
                        <span
                          title="Special request"
                          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px]"
                        >
                          ★
                        </span>
                      ) : null}
                      {block.kind === 'serve' &&
                      block.eventId &&
                      isExpanded &&
                      canEdit &&
                      block.height * PX_PER_MIN >= 14 ? (
                        <button
                          type="button"
                          title="Edit this event"
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
                            onEditEvent(block.eventId as string)
                          }}
                          className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-md bg-serve-fg text-serve hover:opacity-90"
                        >
                          <Pencil className="h-2 w-2" />
                        </button>
                      ) : null}
                      {/* Live traffic/weather stay visible even collapsed — a
                          colour dot and tiny icons still read at sliver width. */}
                      {block.kind === 'serve' && sourceEvent ? <WeatherBadges address={sourceEvent.address} /> : null}
                      {block.kind === 'travel' && sourceEvent
                        ? (() => {
                            const eventIndex = sortedEvents.indexOf(sourceEvent)
                            const previousEvent = eventIndex > 0 ? sortedEvents[eventIndex - 1] : null
                            const origin = previousEvent ? previousEvent.address : settings.kitchenAddress
                            return (
                              <TrafficBadge
                                origin={origin}
                                destination={sourceEvent.address}
                                plannedDriveMinutes={sourceEvent.driveMinutes}
                                departsAtIso={sourceEvent.computed.leaveTime}
                                arriveByIso={sourceEvent.computed.onSiteTime}
                                isExpanded={isExpanded}
                              />
                            )
                          })()
                        : null}
                    </div>
                  )
                })}

                {/* Clock time at every block seam, in the lane's own gutter
                    down the left so it never lands on a block's label. */}
                {boundaries.map((boundary) => (
                  <span
                    key={`t-${boundary.top}`}
                    className="pointer-events-none absolute left-0 z-20 -translate-y-1/2 font-mono text-[8px] leading-none text-muted-foreground"
                    style={{ top: boundary.top * PX_PER_MIN }}
                  >
                    {boundary.label}
                  </span>
                ))}

                {/* Divider lines drawn first (and thus behind), badges drawn
                    after (and thus in front) — as two separate passes, not
                    interleaved per-moment, so when two land at the same or
                    nearby times, the SECOND one's full-width line can't paint
                    over the FIRST one's badge. */}
                {!isCollapsed &&
                  momentLines.map(([minute, line]) => (
                    <div
                      key={`moment-${minute}`}
                      className="absolute border-t"
                      style={{
                        left: TIME_GUTTER + BLOCK_RADIUS,
                        right: BLOCK_INSET + BLOCK_RADIUS,
                        top: line.top,
                        borderColor: momentLineColor(line.tone)
                      }}
                    />
                  ))}

                {/* One row per moment, so everything due at the same minute
                    sits side by side instead of stacking on top of whatever
                    got there first. The row spans the block and centres its
                    contents, which lets it wrap on a narrow lane rather than
                    running off the edge. Colour carries the role: this rig's
                    own two people in the normal black/white pair, red only for
                    "this involves another rig" — lighting your OWN fire just
                    adds the small flame, it doesn't turn the badge red. */}
                {badgeRows.map((row) => {
                  // The other-rig fire tags are laid out as their own cluster,
                  // because several of them collapse into a single marker.
                  const pinned = row.badges.filter((badge) => !badge.labelOptional)
                  // What one chip may occupy: the lane's own width less its
                  // gutter and insets, shared between everything on this row,
                  // less the flame and the chip's own padding.
                  const lanePx = (offset.widthPct / 100) * lanesWidth
                  const rowPx = Math.max(
                    0,
                    lanePx - (isCollapsed ? BLOCK_INSET * 2 : TIME_GUTTER + BLOCK_INSET) - row.badges.length * 4
                  )
                  const chipPx = rowPx / Math.max(1, row.badges.length)
                  const away = row.badges.filter((badge) => badge.labelOptional)
                  // Two or three flames in a row ate the whole lane and wrapped
                  // onto a second line. Until the lane is opened they read as
                  // one circle carrying the count instead; opening it fans them
                  // back out into a named tag each. Every tag stays mounted
                  // across both states so the change is a width transition —
                  // an actual split — rather than one element being swapped
                  // out for three.
                  const merged = !isExpanded && away.length > 1
                  return (
                    <span
                      key={`row-${row.top}`}
                      className="pointer-events-none absolute z-20 flex -translate-y-1/2 flex-nowrap items-center justify-center gap-0.5"
                      style={{ left: isCollapsed ? BLOCK_INSET : TIME_GUTTER, right: BLOCK_INSET, top: row.top }}
                    >
                      {pinned.map((badge) => (
                        <span
                          key={badge.key}
                          className={`${BADGE_BASE} ${badgeSize(isCollapsed)} ${badgeTone(badge.tone)}`}
                        >
                          {badge.fullName
                            ? fitName(
                                badge.fullName,
                                chipPx - (isCollapsed ? 4 : 12) - (badge.hasFire ? 11 : 0),
                                isCollapsed
                              )
                            : badge.label}
                          {badge.hasFire ? <span className={isCollapsed ? 'text-[7px]' : 'text-[8px]'}>🔥</span> : null}
                        </span>
                      ))}

                      {away.length > 0 ? (
                        <span className="flex items-center gap-0.5">
                          {away.map((badge, index) => (
                            // Two things slide at once, on the same clock: the
                            // rig name inside every tag, and the whole of every
                            // tag past the first. Both animate a grid column
                            // from 0fr to 1fr rather than a max-width — a
                            // max-width wide enough for the longest rig name is
                            // far wider than most, so the growth finished in
                            // the first fraction of the duration and read as a
                            // snap; an fr column resolves to exactly the
                            // content's width, so the whole run is the split.
                            //
                            // It rides on wrappers rather than the badge itself
                            // because a width utility on the badge would have
                            // to out-rank its own min-width, and between two
                            // equal-specificity utilities that comes down to
                            // stylesheet order, not the order written here.
                            <span
                              key={badge.key}
                              className={`grid ${BADGE_SLIDE} ${
                                merged && index > 0 ? 'grid-cols-[0fr] opacity-0' : 'grid-cols-[1fr] opacity-100'
                              }`}
                            >
                              <span className="min-w-0 overflow-hidden">
                                <span className={`${BADGE_BASE} ${badgeSize(isCollapsed)} ${badgeTone(badge.tone)}`}>
                                  <span
                                    className={`grid ${BADGE_SLIDE} ${
                                      isExpanded ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]'
                                    }`}
                                  >
                                    <span className="min-w-0 overflow-hidden whitespace-nowrap">{badge.label}</span>
                                  </span>
                                  <span className={isCollapsed ? 'text-[7px]' : 'text-[8px]'}>🔥</span>
                                </span>
                              </span>
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  )
                })}

                {/* Rendered last so it paints in front of the blocks. The
                    radius has to be the blocks' own `rounded`, not something
                    tighter — a ring that curves harder than what it wraps
                    leaves a sliver of card showing in each corner.

                    Layering, bottom to top: current-time rule (10), the
                    writing on the blocks (18), this frame (19), badges (20).
                    Above the rule, or the warning reads as the clock's. Above
                    the block labels too: each label sits on a pill of its
                    block's colour with a soft halo, and where the frame's
                    edge ran along a label that halo swallowed the yellow.
                    Still under the badges, which often sit right on its edge
                    and have to stay readable. */}
                {hurryRings.map((ring) => (
                  <div
                    key={ring.key}
                    className={`pointer-events-none absolute z-[19] rounded ${ring.severity === 'bad' ? 'ring-[3px] ring-bad' : 'ring-[3px] ring-warn'}`}
                    style={{
                      left: isCollapsed ? BLOCK_INSET : TIME_GUTTER,
                      right: BLOCK_INSET,
                      top: ring.top,
                      height: ring.bottom - ring.top
                    }}
                  />
                ))}
              </div>
            )
          })}

          {/* The now marker's clock reads on top of everything — with the hour
              axis gone this is the only absolute time on the board, so it has
              to win over whatever it lands on. Above the seam times too (z-20,
              inside the lanes): those sit at every block boundary, so one of
              them lands on this pill often enough to matter, and the seam time
              is the reading you can work out from the block either way. */}
          {nowVisible ? (
            <span
              // Hung from its RIGHT edge just inside the seam-time gutter, so
              // it grows leftwards into the card's padding instead of out over
              // the blocks. Anchoring the left edge meant a wider time — an
              // 11:15 against a 3:30 — reached further across the lane and sat
              // on whatever label was there.
              className="pointer-events-none absolute z-30 -translate-x-full -translate-y-1/2 rounded-full bg-fired px-1 py-0.5 font-mono text-[8px] font-semibold leading-none text-white"
              style={{ top: nowTop, left: TIME_GUTTER - 2 }}
            >
              {formatLaneTime(now.toISOString())}
            </span>
          ) : null}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 border-t pt-2 font-mono text-[10px] text-muted-foreground">
        {(
          [
            ['fire', 'Fire'],
            ['travel', 'Travel'],
            ['work', 'Set up'],
            ['rack', 'Rack'],
            ['serve', 'Service'],
            ['spare', 'Spare']
          ] as const
        ).map(([kind, label]) => (
          <span key={kind} className="flex items-center gap-1">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${legendSwatch(kind)}`} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
