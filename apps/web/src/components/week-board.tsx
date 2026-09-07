import { Link } from '@tanstack/react-router'

import { diffMinutes } from '@/lib/board-time'
import type { DayViewJson, RigDayJson } from '@/lib/day-blocks'
import { blockStyle, buildBlocks, computeDayWindow, legendSwatch } from '@/lib/day-blocks'
import { toDateKey } from '@/lib/format'
import type { Rig } from '@/lib/rigs'
import { RIGS } from '@/lib/rigs'

const STRIP_HEIGHT = 220
// Trimmed from 44 when the reference gutter arrived: seven columns plus the
// gutter plus the card's own padding tipped just past a narrow viewport, and
// a scrollbar under a week that already fits is pure noise.
const COLUMN_MIN_WIDTH = 40
// Gutter down the left of the strips holding the shared hour references.
const TIME_GUTTER = 30
// How far apart the reference hours are — every three keeps a working day to
// roughly five marks, enough to read a height as a time without clutter.
const REFERENCE_HOURS = 3

const weekdayOf = (dateKey: string): string => {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
}

const dayNumberOf = (dateKey: string): number => Number(dateKey.split('-')[2])

/**
 * A day's working rigs in the order they actually start — earliest fire
 * first, then whoever pulls out first. Matches how the day board orders its
 * lanes, so a rig doesn't jump position between the two views. The free ones
 * are returned too — they carry no shape worth drawing, but the caller needs
 * them to key one placeholder each on a wide screen.
 */
const rigsFor = (
  day: DayViewJson,
  showFreeRigs: boolean
): Readonly<{ working: readonly { rig: Rig; rigDay: RigDayJson }[]; free: readonly Rig[] }> => {
  const entries = RIGS.map((rig) => ({ rig, rigDay: day.rigs.find((candidate) => candidate.rig === rig) }))
  const startOf = (rigDay: RigDayJson): number =>
    new Date(rigDay.fireDuty?.litAt ?? rigDay.events[0]?.computed.leaveTime ?? 0).getTime()

  const working = entries
    .flatMap((entry) =>
      entry.rigDay && entry.rigDay.events.length > 0 ? [{ rig: entry.rig, rigDay: entry.rigDay }] : []
    )
    .sort((a, b) => startOf(a.rigDay) - startOf(b.rigDay))
  // Free rigs are the ones this viewer isn't shown working. For someone who
  // only ever sees their own rig that's the other three every day of the week,
  // which would draw the fleet they were never meant to see, in dashes.
  const free = showFreeRigs ? RIGS.filter((rig) => !working.some((entry) => entry.rig === rig)) : []
  return { working, free }
}

// A day with nothing booked gets a fraction of a working day's width. It
// still has to show its date and stay clickable to add an event, so it can't
// collapse entirely — but an empty Sunday earning the same width as a
// three-rig Thursday is space the busy days needed more.
const EMPTY_DAY_FLEX = 0.4
// Floor for any day column: the date circle is 24px and a divider column adds
// 6px of padding, so anything narrower pushes the date out over its neighbour.
const DAY_MIN_WIDTH = 30
const flexFor = (day: DayViewJson): number => (day.rigs.some((rig) => rig.events.length > 0) ? 1 : EMPTY_DAY_FLEX)

// A divider between every day, so each column reads as its own day rather
// than bleeding into its neighbours.
const dayDivider = (index: number): string => (index === 0 ? '' : 'ml-1.5 pl-1.5 border-l')

export type WeekBoardProperties = Readonly<{
  days: readonly DayViewJson[]
  ovenToTempMinutes: number
  spareFoldThresholdMinutes: number
  /**
   * Whether to draw a placeholder for the rigs not working a given day.
   *
   * False for a crew or pizzaiolo login: their week is one lane per day, the
   * one they're on, and four dashed slots would be an outline of a fleet
   * they're not being shown.
   */
  showFreeRigs: boolean
}>

/**
 * The collapsed week — colour and position, no labels (spec §9). Each rig
 * strip scales its own day's blocks into a shared fixed height, so a quiet
 * day reads as mostly-empty and a full one fills the strip top to bottom.
 * Every day column gets a divider on its left.
 */
export const WeekBoard = ({
  days,
  ovenToTempMinutes,
  spareFoldThresholdMinutes,
  showFreeRigs
}: WeekBoardProperties) => {
  const today = toDateKey(new Date())

  // A shared window, but of TIME OF DAY — not an absolute datetime range.
  // Spanning min-start to max-end across the week covers several days, which
  // squeezes every day into a sliver and makes the hour marks repeat. What we
  // want is the earliest start and latest finish seen on any day, applied to
  // each day's own date, so equal heights mean the same clock time.
  const midnightOf = (dateKey: string): Date => {
    const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
    return new Date(year, month - 1, day)
  }

  const spans = days.flatMap((day) => {
    const window_ = computeDayWindow(day)
    if (!window_) return []
    const midnight = midnightOf(day.date).getTime()
    return [
      {
        fromMidnight: (window_.start.getTime() - midnight) / 60_000,
        toMidnight: (window_.end.getTime() - midnight) / 60_000
      }
    ]
  })

  const startMinute = spans.length > 0 ? Math.min(...spans.map((span) => span.fromMidnight)) : 0
  const endMinute = spans.length > 0 ? Math.max(...spans.map((span) => span.toMidnight)) : 0
  const weekMinutes = Math.max(1, endMinute - startMinute)
  const pxPerMin = STRIP_HEIGHT / weekMinutes

  // Round hours inside that band, every REFERENCE_HOURS.
  const references: { top: number; label: string }[] = []
  if (spans.length > 0) {
    const firstMark = Math.ceil(startMinute / (REFERENCE_HOURS * 60)) * REFERENCE_HOURS * 60
    for (let minute = firstMark; minute <= endMinute; minute += REFERENCE_HOURS * 60) {
      const hour = Math.floor(minute / 60) % 24
      const suffix = hour < 12 ? 'AM' : 'PM'
      const display = hour % 12 === 0 ? 12 : hour % 12
      references.push({ top: (minute - startMinute) * pxPerMin, label: `${display}${suffix}` })
    }
  }

  return (
    <div className="space-y-2 overflow-x-auto rounded-lg border bg-card p-3 sm:p-4">
      <div className="flex" style={{ minWidth: 7 * COLUMN_MIN_WIDTH + TIME_GUTTER }}>
        <div style={{ width: TIME_GUTTER, flexShrink: 0 }} />
        {days.map((day, index) => (
          <div
            key={day.date}
            style={{ flexGrow: flexFor(day), flexBasis: 0, minWidth: DAY_MIN_WIDTH }}
            className={`text-center font-mono text-[10px] uppercase tracking-wide text-muted-foreground ${dayDivider(index)}`}
          >
            <div className={day.date === today ? 'font-semibold text-foreground' : ''}>{weekdayOf(day.date)}</div>
            <div
              className={`mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-sm ${
                day.date === today ? 'bg-primary text-primary-foreground' : 'text-foreground'
              }`}
            >
              {dayNumberOf(day.date)}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-0" style={{ minWidth: 7 * COLUMN_MIN_WIDTH + TIME_GUTTER }}>
        <div className="relative" style={{ width: TIME_GUTTER, flexShrink: 0, height: STRIP_HEIGHT }}>
          {references.map((reference) => (
            <span
              key={reference.label}
              className="absolute right-1 -translate-y-1/2 font-mono text-[9px] leading-none text-muted-foreground"
              style={{ top: reference.top }}
            >
              {reference.label}
            </span>
          ))}
        </div>

        <div className="relative flex flex-1 gap-0">
          {/* Shared hour lines, behind the strips — the whole point of one
              window for the week is that a height means the same time in
              every column, and these make that readable. */}
          {references.map((reference) => (
            <div
              key={`line-${reference.label}`}
              className="pointer-events-none absolute inset-x-0 border-t border-border/60"
              style={{ top: reference.top }}
            />
          ))}
          {days.map((day, index) => {
            const window_ =
              spans.length > 0
                ? { start: new Date(midnightOf(day.date).getTime() + startMinute * 60_000), minutes: weekMinutes }
                : null
            // Without a window there's nothing to scale against, so the whole
            // day reads as free rather than drawing shapeless strips.
            const { working, free } = window_
              ? rigsFor(day, showFreeRigs)
              : { working: [], free: showFreeRigs ? RIGS : [] }

            return (
              <Link
                key={day.date}
                to="/day/$date"
                params={{ date: day.date }}
                style={{ flexGrow: flexFor(day), flexBasis: 0, minWidth: DAY_MIN_WIDTH }}
                className={`block rounded transition hover:opacity-80 ${dayDivider(index)}`}
              >
                <div className="flex gap-0.5 px-0.5" style={{ height: STRIP_HEIGHT }}>
                  {working.map(({ rig, rigDay }) => {
                    if (!window_) return null

                    const pxPerMin = STRIP_HEIGHT / window_.minutes
                    const blocks = buildBlocks(
                      rigDay,
                      ovenToTempMinutes,
                      window_.start.toISOString(),
                      spareFoldThresholdMinutes
                    )
                    // Ring only the hurry window — break down, drive, set up,
                    // ending at this event's first pizza — not the whole day's
                    // strip (mirrors the day board's per-turnaround rings).
                    const sortedEvents = [...rigDay.events].sort(
                      (a, b) => new Date(a.firstPizzaTime).getTime() - new Date(b.firstPizzaTime).getTime()
                    )
                    const fromStart = (iso: string) => diffMinutes(iso, window_.start.toISOString())
                    const hurryRings = sortedEvents.flatMap((event, eventIndex) => {
                      if (event.computed.turnaround !== 'tight' && event.computed.turnaround !== 'bad') return []
                      const previous = sortedEvents[eventIndex - 1]
                      if (!previous) return []
                      return [
                        {
                          key: `${event.id}-hurry`,
                          severity: event.computed.turnaround,
                          top: fromStart(previous.computed.serviceEndTime) * pxPerMin,
                          bottom: fromStart(event.firstPizzaTime) * pxPerMin
                        }
                      ]
                    })

                    return (
                      <div key={rig} className="relative min-w-0 flex-1 overflow-visible rounded-sm bg-muted/40">
                        {blocks.map((block) => (
                          <div
                            key={`${block.kind}-${block.top}`}
                            // Same rounded corners the day board's blocks
                            // have, scaled down for a strip this narrow.
                            className={`absolute inset-x-0 rounded-sm ${blockStyle[block.kind]}`}
                            style={{ top: block.top * pxPerMin, height: Math.max(1, block.height * pxPerMin) }}
                          />
                        ))}
                        {/* One star per special-request event, centered on
                          that event's own serve block — not the whole
                          day's strip — so it lines up with which party it
                          actually belongs to. */}
                        {blocks
                          .filter((block) => block.kind === 'serve' && block.eventId)
                          .map((block) => {
                            const event = rigDay.events.find((candidate) => candidate.id === block.eventId)
                            if (!event || event.specialRequests.length === 0) return null
                            return (
                              // text-serve-fg, not text-foreground — this sits
                              // over a serve block specifically (always light),
                              // and isn't nested inside it to inherit that
                              // colour, so the theme's default foreground would
                              // wash out against it instead of contrasting.
                              <span
                                key={`star-${block.eventId}`}
                                className="pointer-events-none absolute inset-x-0 flex items-center justify-center text-[10px] text-serve-fg"
                                style={{ top: block.top * pxPerMin, height: Math.max(1, block.height * pxPerMin) }}
                              >
                                ★
                              </span>
                            )
                          })}
                        {/* Rendered last so it paints in front of the blocks,
                            and carrying the blocks' own radius — a ring that
                            curves harder or softer than what it wraps leaves a
                            sliver of lane showing in each corner. */}
                        {hurryRings.map((ring) => (
                          <div
                            key={ring.key}
                            className={`pointer-events-none absolute rounded-sm ${
                              ring.severity === 'bad' ? 'ring-2 ring-bad' : 'ring-2 ring-warn'
                            }`}
                            style={{ left: 0, right: 0, top: ring.top, height: ring.bottom - ring.top }}
                          />
                        ))}
                      </div>
                    )
                  })}

                  {/* Every free rig on this day as one placeholder carrying
                      the count. Four empty strips said the same thing four
                      times and cost a quarter of the day's width each. */}
                  {/* Free rigs read two ways depending on the room available.
                      On a phone every pixel counts, so they collapse into one
                      counted placeholder; from `sm` up there's width to spare
                      and one slot per free rig looks less like an oddity.
                      Both are rendered and the breakpoint picks — no resize
                      listener, and no flash of the wrong one on first paint. */}
                  {free.length > 0 ? (
                    <div
                      title={`${free.length} rig${free.length === 1 ? '' : 's'} free`}
                      // Shares the row like a working rig but caps out narrow:
                      // a fixed width claimed its pixels before the rigs got
                      // any, which crushed real lanes to nothing on a tight
                      // column. Grows to the cap when there's room, yields
                      // proportionally when there isn't.
                      className="flex min-w-0 max-w-5 flex-1 items-center justify-center overflow-hidden rounded-sm border border-dashed border-border sm:hidden"
                    >
                      <span className="font-mono text-[10px] leading-none text-muted-foreground">{free.length}</span>
                    </div>
                  ) : null}
                  {free.map((rig) => (
                    <div
                      key={`free-${rig}`}
                      className="hidden min-w-0 max-w-5 flex-1 rounded-sm border border-dashed border-border sm:block"
                    />
                  ))}
                </div>
              </Link>
            )
          })}
        </div>
      </div>

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
