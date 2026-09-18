import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { DaySummaryJson, PersonLike } from '@/lib/day-blocks'
import { nameOf } from '@/lib/day-blocks'
import { formatClockTime, formatDuration } from '@/lib/format'

type Row = Readonly<{
  personId: string
  minutes: number
  parties: number
  pizzas: number
  /** The day's in-to-out, or the number of days worked across a week. */
  detail: string
}>

type Totals = Readonly<{
  parties: number
  guests: number
  pizzas: number
  peopleWorking: number
  crewMinutes: number
  /** "7:00 AM → 10:15 PM" for a day, "5 days" for a week. */
  span: string | null
  spanLabel: string
}>

const Stat = ({ label, value }: Readonly<{ label: string; value: string | number }>) => (
  <div>
    <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="font-mono text-base font-medium">{value}</p>
  </div>
)

/**
 * The shared body: totals across the top, then a row per person.
 *
 * `personal` is a crew or pizzaiolo login, whose data has already been cut to
 * their own row on the server. For them the totals ARE their row, so the table
 * would only repeat it — they get the tiles, phrased as theirs.
 */
const SummaryBody = ({
  totals,
  rows,
  people,
  personal
}: Readonly<{ totals: Totals; rows: readonly Row[]; people: readonly PersonLike[]; personal: boolean }>) => {
  if (totals.parties === 0) {
    return <p className="text-sm text-muted-foreground">{personal ? "You're not on anything." : 'Nothing booked.'}</p>
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={personal ? 'Your hours' : 'Crew hours'} value={formatDuration(totals.crewMinutes)} />
        <Stat label="Parties" value={totals.parties} />
        <Stat label="Pizzas" value={totals.pizzas} />
        <Stat label="Guests" value={totals.guests} />
        {personal ? null : <Stat label="People" value={totals.peopleWorking} />}
        {totals.span ? <Stat label={totals.spanLabel} value={totals.span} /> : null}
      </div>

      {personal || rows.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1 pr-3 font-normal">Person</th>
                <th className="py-1 pr-3 text-right font-normal">Hours</th>
                <th className="py-1 pr-3 text-right font-normal">Parties</th>
                <th className="py-1 pr-3 text-right font-normal">Pizzas</th>
                <th className="py-1 font-normal">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.personId} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">{nameOf(people, row.personId)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{formatDuration(row.minutes)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{row.parties}</td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{row.pizzas}</td>
                  <td className="py-1.5 font-mono text-xs text-muted-foreground">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Longest day first: the table is read to spot who's carrying the most.
const byHours = (first: Row, second: Row) => second.minutes - first.minutes

export const DaySummaryCard = ({
  summary,
  people,
  personal
}: Readonly<{ summary: DaySummaryJson; people: readonly PersonLike[]; personal: boolean }>) => (
  <Card>
    <CardHeader>
      <CardTitle>{personal ? 'Your day' : 'Day summary'}</CardTitle>
    </CardHeader>
    <CardContent>
      <SummaryBody
        personal={personal}
        people={people}
        totals={{
          ...summary,
          spanLabel: personal ? 'In → done' : 'First in → last out',
          span:
            summary.firstIn && summary.lastOut
              ? `${formatClockTime(summary.firstIn)} → ${formatClockTime(summary.lastOut)}`
              : null
        }}
        rows={summary.people
          .map((shift) => ({
            personId: shift.personId,
            minutes: shift.minutes,
            parties: shift.parties,
            pizzas: shift.pizzas,
            detail: `${formatClockTime(shift.firstIn)} → ${formatClockTime(shift.lastOut)}`
          }))
          .sort(byHours)}
      />
    </CardContent>
  </Card>
)

/**
 * Seven days added together. Each day arrives already scoped by the server, so
 * a crew login's week is built only from their own rows.
 *
 * People are counted once across the week, not once per day they worked, and
 * the in-to-out span is dropped: across days it would only say "Monday
 * morning to Sunday night", so the rows say how many days instead.
 */
export const WeekSummaryCard = ({
  days,
  people,
  personal
}: Readonly<{ days: readonly DaySummaryJson[]; people: readonly PersonLike[]; personal: boolean }>) => {
  const byPerson = new Map<string, { minutes: number; parties: number; pizzas: number; days: number }>()
  for (const day of days) {
    for (const shift of day.people) {
      const tally = byPerson.get(shift.personId) ?? { minutes: 0, parties: 0, pizzas: 0, days: 0 }
      byPerson.set(shift.personId, {
        minutes: tally.minutes + shift.minutes,
        parties: tally.parties + shift.parties,
        pizzas: tally.pizzas + shift.pizzas,
        days: tally.days + 1
      })
    }
  }

  const workedDays = days.filter((day) => day.parties > 0).length
  const rows: Row[] = [...byPerson.entries()]
    .map(([personId, tally]) => ({
      personId,
      minutes: tally.minutes,
      parties: tally.parties,
      pizzas: tally.pizzas,
      detail: `${tally.days} ${tally.days === 1 ? 'day' : 'days'}`
    }))
    .sort(byHours)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{personal ? 'Your week' : 'Week summary'}</CardTitle>
      </CardHeader>
      <CardContent>
        <SummaryBody
          personal={personal}
          people={people}
          totals={{
            parties: days.reduce((sum, day) => sum + day.parties, 0),
            guests: days.reduce((sum, day) => sum + day.guests, 0),
            pizzas: days.reduce((sum, day) => sum + day.pizzas, 0),
            peopleWorking: byPerson.size,
            crewMinutes: days.reduce((sum, day) => sum + day.crewMinutes, 0),
            spanLabel: 'Working',
            span: workedDays > 0 ? `${workedDays} ${workedDays === 1 ? 'day' : 'days'}` : null
          }}
          rows={rows}
        />
      </CardContent>
    </Card>
  )
}
