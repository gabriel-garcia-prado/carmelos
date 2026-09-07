import type { RigDayJson, SettingsLike } from '@/lib/day-blocks'
import { blockStyle, buildBlocks, computeDayWindow } from '@/lib/day-blocks'
import { formatClockTime } from '@/lib/format'

// Tall enough to read a shape from, short enough to sit beside the form
// without scrolling. The lane scales its own day into this, the way the week
// strips do — a real day can run twelve hours and the board's 1px-per-minute
// would be nine hundred pixels of drawer.
const LANE_HEIGHT = 300
// A clock reading every three hours, same cadence as the week board.
const REFERENCE_HOURS = 3

/**
 * The draft's own chain is outlined DASHED, while the boards draw a solid ring
 * for a tight or impossible turnaround. Both want the same three colours, so
 * colour alone can't separate them — dashed vs solid is what says "this is the
 * thing being added" as opposed to "this gap is a problem", and it keeps
 * working in greyscale and at week-strip size.
 */
const FIT_OUTLINE: Readonly<Record<'fine' | 'tight' | 'bad', string>> = {
  fine: 'outline-good',
  tight: 'outline-warn',
  bad: 'outline-bad'
}

export type EventPreviewLaneProperties = Readonly<{
  /** The rig's day with the draft already scheduled into it — straight from
   * the preview endpoint, so it's the server's arithmetic, not a second copy. */
  rigDay: RigDayJson
  /** Which event in that day is the draft, or null before there's enough
   * filled in to place one — the lane still shows the day being added to. */
  draftEventId: string | null
  /** The live verdict, so the outline says whether it fits as well as where it
   * lands. Null before there's enough filled in to schedule against. */
  fit: 'fine' | 'tight' | 'bad' | null
  settings: SettingsLike
}>

/**
 * A single lane showing where a draft event lands on its rig's day, with the
 * draft's own blocks outlined. Same `buildBlocks` and `blockStyle` the day and
 * week boards use, so a shape here means what it means there — the only thing
 * this adds is the outline marking which chain is the new one.
 */
export const EventPreviewLane = ({ rigDay, draftEventId, fit, settings }: EventPreviewLaneProperties) => {
  const window_ = computeDayWindow({ date: '', rigs: [rigDay] })

  // An empty rig on an empty day has no window to scale to, but the lane still
  // has a job: it holds its place from the moment the drawer opens, so nothing
  // jumps sideways once the first real placement arrives.
  if (!window_) {
    return (
      <div className="w-24 shrink-0">
        <p className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{rigDay.label}</p>
        <div
          className="mt-1 flex items-center justify-center rounded-sm border border-dashed border-border"
          style={{ height: LANE_HEIGHT }}
        >
          <span className="px-1 text-center font-mono text-[9px] leading-tight text-muted-foreground">
            Nothing booked
          </span>
        </div>
      </div>
    )
  }

  const { start, minutes } = window_
  const pxPerMin = LANE_HEIGHT / minutes
  const blocks = buildBlocks(
    rigDay,
    settings.ovenToTempMinutes,
    start.toISOString(),
    settings.spareFoldThresholdMinutes
  )

  // Round hours inside the window, so the lane can be read as a clock.
  const references: { top: number; label: string }[] = []
  const startHour = start.getHours() + start.getMinutes() / 60
  const firstMark = Math.ceil(startHour / REFERENCE_HOURS) * REFERENCE_HOURS
  for (let hour = firstMark; (hour - startHour) * 60 <= minutes; hour += REFERENCE_HOURS) {
    const suffix = hour % 24 < 12 ? 'AM' : 'PM'
    const display = hour % 12 === 0 ? 12 : hour % 12
    references.push({ top: (hour - startHour) * 60 * pxPerMin, label: `${display}${suffix}` })
  }

  const draft = rigDay.events.find((event) => event.id === draftEventId)

  return (
    <div className="w-24 shrink-0">
      <p className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{rigDay.label}</p>
      <div className="relative mt-1 flex" style={{ height: LANE_HEIGHT }}>
        <div className="relative w-6 shrink-0">
          {references.map((reference) => (
            <span
              key={reference.label}
              className="absolute right-1 -translate-y-1/2 font-mono text-[8px] leading-none text-muted-foreground"
              style={{ top: reference.top }}
            >
              {reference.label}
            </span>
          ))}
        </div>

        <div className="relative flex-1 rounded-sm bg-muted/40">
          {blocks.map((block) => (
            <div
              key={`${block.kind}-${block.top}`}
              className={`absolute inset-x-0 rounded-sm ${blockStyle[block.kind]} ${
                // Outline, not ring: a ring is a box-shadow and can't be
                // dashed, and dashed is what distinguishes the draft from a
                // turnaround warning (see FIT_OUTLINE).
                block.ownerEventId === draftEventId ? `z-10 outline-2 outline-dashed ${FIT_OUTLINE[fit ?? 'fine']}` : ''
              }`}
              style={{ top: block.top * pxPerMin, height: Math.max(2, block.height * pxPerMin) }}
            />
          ))}
        </div>
      </div>

      {draft ? (
        <p
          className={`mt-1 font-mono text-[9px] leading-tight ${
            fit === 'bad' ? 'text-bad' : fit === 'tight' ? 'text-warn' : 'text-good'
          }`}
        >
          {formatClockTime(draft.computed.leaveTime)} out · {formatClockTime(draft.firstPizzaTime)} first pizza
        </p>
      ) : null}
    </div>
  )
}
