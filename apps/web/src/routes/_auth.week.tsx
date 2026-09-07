import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'

import { useApiClient } from '@/components/api-client-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { WeekBoard } from '@/components/week-board'
import { addDaysToKey, toDateKey } from '@/lib/format'
import { useViewer } from '@/lib/use-viewer'

const startOfWeek = (date: Date): Date => {
  const copy = new Date(date)
  copy.setDate(copy.getDate() - copy.getDay())
  return copy
}

const thisWeekStart = toDateKey(startOfWeek(new Date()))

const searchSchema = z.object({ start: z.string().optional() })

const shortWeekdayOf = (dateKey: string): string => {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short' })
}

const Week = () => {
  const client = useApiClient()
  const { isOwner } = useViewer()
  const { start } = Route.useSearch()
  const startDate = start ?? thisWeekStart

  const week = useQuery({
    queryKey: ['week', startDate],
    queryFn: async () => {
      const response = await client.api.events.week[':startDate'].$get({ param: { startDate } })
      if (!response.ok) throw new Error('Failed to load the week')
      return response.json()
    }
  })

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const response = await client.api.settings.$get()
      if (!response.ok) throw new Error('Failed to load settings')
      return response.json()
    }
  })

  if (week.isPending || settings.isPending) {
    return (
      <div className="mx-auto max-w-4xl space-y-2 p-3 sm:p-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (week.isError || settings.isError) {
    return <p className="p-3 text-destructive sm:p-5">Couldn't load the week.</p>
  }

  // Land on today if it's in the displayed week, otherwise the week's own
  // first day — either way "+ New event" opens a day with real context.
  const newEventDate = week.data.some((day) => day.date === thisWeekStart) ? thisWeekStart : startDate

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-3 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button asChild variant="outline" size="sm">
            <Link to="/week" search={{ start: addDaysToKey(startDate, -7) }}>
              ‹
            </Link>
          </Button>
          <h1 className="text-lg font-semibold sm:text-2xl">This week</h1>
          <Button asChild variant="outline" size="sm">
            <Link to="/week" search={{ start: addDaysToKey(startDate, 7) }}>
              ›
            </Link>
          </Button>
        </div>
        {isOwner ? (
          <Button asChild size="sm">
            <Link to="/day/$date" params={{ date: newEventDate }}>
              + New event
            </Link>
          </Button>
        ) : null}
      </div>
      <WeekBoard
        days={week.data}
        ovenToTempMinutes={settings.data.ovenToTempMinutes}
        spareFoldThresholdMinutes={settings.data.spareFoldThresholdMinutes}
        showFreeRigs={isOwner}
      />

      <Card>
        <CardHeader>
          <CardTitle>Night-before list</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Columns share the width evenly and shrink with it — a scrollbar
              under a week that already fits on screen was pure noise. */}
          <div className="flex gap-1.5 sm:gap-2">
            {week.data
              .filter((day) => day.rigs.some((rig) => rig.events.length > 0))
              .map((day) => (
                <div key={day.date} className="min-w-0 flex-1 space-y-1.5 rounded-md border p-1.5 text-sm sm:p-2">
                  <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                    {shortWeekdayOf(day.date)} {Number(day.date.split('-')[2])}
                  </p>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Pizzas</p>
                    <p className="font-mono text-base font-medium">{day.consumables.totalPizzas}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Cheese</p>
                    <p className="font-mono text-base font-medium">{day.consumables.cheeseBags}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Sauce</p>
                    <p className="font-mono text-base font-medium">{day.consumables.sauceUnits}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Trays</p>
                    <p className="font-mono text-base font-medium">{day.consumables.trays}</p>
                  </div>
                  {day.consumables.glutenFreeDoughExtra > 0 ? (
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">GF extra</p>
                      <p className="font-mono text-base font-medium">{day.consumables.glutenFreeDoughExtra}</p>
                    </div>
                  ) : null}
                </div>
              ))}
          </div>

          {/* The whole week in one column — what to order once rather than
              seven daily numbers to add up by hand before a shop run. */}
          {(() => {
            const week_ = week.data.reduce(
              (total, day) => ({
                totalPizzas: total.totalPizzas + day.consumables.totalPizzas,
                cheeseBags: total.cheeseBags + day.consumables.cheeseBags,
                sauceUnits: total.sauceUnits + day.consumables.sauceUnits,
                trays: total.trays + day.consumables.trays,
                glutenFreeDoughExtra: total.glutenFreeDoughExtra + day.consumables.glutenFreeDoughExtra
              }),
              { totalPizzas: 0, cheeseBags: 0, sauceUnits: 0, trays: 0, glutenFreeDoughExtra: 0 }
            )
            if (week_.totalPizzas === 0) return null

            return (
              <div className="mt-3 rounded-md border border-foreground/25 bg-muted/40 p-2">
                <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Whole week</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                  {(
                    [
                      ['Pizzas', week_.totalPizzas],
                      ['Cheese bags', week_.cheeseBags],
                      ['Sauce', week_.sauceUnits],
                      ['Trays', week_.trays],
                      ...(week_.glutenFreeDoughExtra > 0
                        ? ([['GF dough extra', week_.glutenFreeDoughExtra]] as const)
                        : [])
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <p className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                      <p className="font-mono text-lg font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </CardContent>
      </Card>
    </div>
  )
}

export const Route = createFileRoute('/_auth/week')({ validateSearch: searchSchema, component: Week })
