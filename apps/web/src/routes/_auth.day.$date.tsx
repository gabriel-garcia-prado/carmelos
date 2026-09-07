import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { useApiClient } from '@/components/api-client-provider'
import { DayBoard } from '@/components/day-board'
import { EventForm } from '@/components/event-form'
import { RigCrewForm } from '@/components/rig-crew-form'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import type { ConsumablesJson } from '@/lib/day-blocks'
import { arrivalIsoFor } from '@/lib/day-blocks'
import { addDaysToKey, formatClockTime, formatDateLabel, toDateKey } from '@/lib/format'
import type { Rig } from '@/lib/rigs'
import { smsHref } from '@/lib/sms'
import { useIsTouchDevice } from '@/lib/use-touch-device'
import { useViewer } from '@/lib/use-viewer'

type DrawerState = Readonly<{ kind: 'event'; eventId?: string; rig?: Rig }> | Readonly<{ kind: 'rig-crew'; rig: Rig }>

const ROLE_LABELS: Readonly<Record<string, string>> = {
  pizzaiolo: 'Pizzaiolo',
  crew: 'Crew',
  fire_duty: 'Fire duty note'
}

// The message is copied to the clipboard and pasted wherever the texting
// actually happens, so "sent" is a claim this app can't make - what it knows
// is whether the text has been taken. The stored status is still `sent`;
// only what it's called here changed.
const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Not copied',
  sent: 'Copied',
  confirmed: 'Confirmed',
  declined: 'Declined'
}

const STATUS_VARIANTS: Readonly<Record<string, BadgeProps['variant']>> = {
  pending: 'outline',
  sent: 'secondary',
  confirmed: 'default',
  declined: 'destructive'
}

// Lower number = "needs more attention" — the whole group shows whichever
// status is least settled, so a single still-pending event doesn't get
// hidden behind three already-confirmed ones.
const STATUS_PRIORITY: Readonly<Record<string, number>> = { pending: 0, declined: 1, sent: 2, confirmed: 3 }

const CONSUMABLE_FIELDS = [
  ['Pizzas', 'totalPizzas'],
  ['Cheese bags', 'cheeseBags'],
  ['Sauce', 'sauceUnits'],
  ['Trays', 'trays']
] as const

/** One group's night-before numbers — a rig's own slice, or the day's total. */
const ConsumablesGrid = ({ consumables }: Readonly<{ consumables: ConsumablesJson }>) => (
  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
    {CONSUMABLE_FIELDS.map(([label, key]) => (
      <div key={key}>
        <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="font-mono text-lg font-medium">{consumables[key]}</p>
      </div>
    ))}
    {/* Only worth a column when there actually is gluten-free dough to pull. */}
    {consumables.glutenFreeDoughExtra > 0 ? (
      <div>
        <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">GF dough extra</p>
        <p className="font-mono text-lg font-medium">{consumables.glutenFreeDoughExtra}</p>
      </div>
    ) : null}
  </div>
)

/** A titled, bordered block — one rig, or the day's "All rigs" summary. */
const RigGroup = ({
  title,
  isTotal,
  children
}: Readonly<{ title: string; isTotal?: boolean; children: React.ReactNode }>) => (
  <div className={`rounded-lg border p-3 ${isTotal ? 'border-foreground/25 bg-muted/40' : ''}`}>
    <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
    <div className="mt-2">{children}</div>
  </div>
)

// A structural subset of a `personGroups` entry — only what a row renders.
type CrewTextGroup = Readonly<{
  personId: string
  personName: string
  personPhone: string
  role: string
  arrivalIso: string | null
  combinedBody: string
  confirmationIds: readonly string[]
  overallStatus: string
}>

/** Who to text for this rig, and whether it's gone out yet — one row per
 * person, carrying every event they're on in a single message.
 * `divider` closes the block off from whatever follows it in the group. */
const CrewRows = ({
  groups,
  onSetStatus,
  divider
}: Readonly<{
  groups: readonly CrewTextGroup[]
  onSetStatus: (ids: readonly string[], status: 'pending' | 'sent') => void
  divider?: boolean
}>) => {
  const isTouch = useIsTouchDevice()

  return groups.length === 0 ? null : (
    // Rows are divided, not individually boxed — the group already carries
    // the border, and nesting a second one per person made the rig itself
    // hard to pick out.
    <div className={`divide-y ${divider ? 'mb-3 border-b' : ''}`}>
      {groups.map((group) => (
        <div key={group.personId} className="flex items-center justify-between gap-2 py-2 first:pt-0">
          <p className="truncate text-sm font-medium">
            {group.personName}{' '}
            <span className="text-muted-foreground">
              · {ROLE_LABELS[group.role]}
              {/* Same separator as the role's, so the two read as one trail
                  — only the time itself switches to mono. */}
              {group.arrivalIso ? (
                <>
                  {' · '}
                  <span className="font-mono text-xs">arrive {formatClockTime(group.arrivalIso)}</span>
                </>
              ) : null}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {/* Copied is the one status you set by hand here, so it's the one
                you can take back - a mis-click otherwise leaves the list
                claiming someone has been told when they haven't. Confirmed and
                declined come from the crew replying and aren't ours to undo. */}
            {group.overallStatus === 'sent' ? (
              <button
                type="button"
                title="Mark as not copied"
                className="cursor-pointer rounded-full"
                onClick={() => onSetStatus(group.confirmationIds, 'pending')}
              >
                <Badge variant={STATUS_VARIANTS.sent}>{STATUS_LABELS.sent}</Badge>
              </button>
            ) : (
              <Badge variant={STATUS_VARIANTS[group.overallStatus]}>{STATUS_LABELS[group.overallStatus]}</Badge>
            )}
            {/* On a phone the deep link is the whole job: it opens Messages
                with the number and the body already filled in, so it leads and
                copying is the fallback. On a desktop it is not offered at all
                - nothing there handles `sms:`, the navigation is dropped in
                silence, and a button that looks like it sent something is
                worse than no button. */}
            {isTouch ? (
              <Button asChild size="sm">
                <a
                  href={smsHref(group.personPhone, group.combinedBody)}
                  onClick={() => onSetStatus(group.confirmationIds, 'sent')}
                >
                  Text
                </a>
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={isTouch ? 'ghost' : 'outline'}
              // Marked only once the clipboard write resolves. The old sms:
              // link marked on click and had no way to know whether the OS
              // ever opened anything - on desktop nothing handles that scheme,
              // so a whole crew could read as notified with no message sent.
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(group.combinedBody)
                  onSetStatus(group.confirmationIds, 'sent')
                } catch {
                  // Clipboard refused (no permission, insecure context). Leave
                  // the status alone - "Not copied" is the honest answer.
                }
              }}
            >
              {isTouch ? 'Copy' : 'Copy text'}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

const Day = () => {
  const { date } = Route.useParams()
  const client = useApiClient()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const { isOwner } = useViewer()

  const dayView = useQuery({
    queryKey: ['day', date],
    queryFn: async () => {
      const response = await client.api.events.day[':date'].$get({ param: { date } })
      if (!response.ok) throw new Error('Failed to load the day')
      return response.json()
    }
  })

  const people = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const response = await client.api.people.$get()
      if (!response.ok) throw new Error('Failed to load people')
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

  const trucks = useQuery({
    queryKey: ['trucks'],
    queryFn: async () => {
      const response = await client.api.trucks.$get()
      if (!response.ok) throw new Error('Failed to load trucks')
      return response.json()
    }
  })

  const confirmations = useQuery({
    queryKey: ['confirmations', date],
    // The crew texts are the operator's tool - the API answers 403 for anyone
    // else, so don't ask and don't leave the page stuck in an error state.
    enabled: isOwner,
    queryFn: async () => {
      const response = await client.api.confirmations.day[':date'].$get({ param: { date } })
      if (!response.ok) throw new Error('Failed to load confirmations')
      return response.json()
    }
  })

  // One combined text can cover several underlying (event, role) confirmation
  // rows for the same person — marking it "sent" marks all of them at once.
  const setStatus = useMutation({
    mutationFn: async ({ ids, status }: { ids: readonly string[]; status: 'pending' | 'sent' }) => {
      await Promise.all(
        ids.map(async (id) => {
          const response = await client.api.confirmations[':id'].$patch({ param: { id }, json: { status } })
          if (!response.ok) throw new Error('Failed to update confirmation')
        })
      )
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['confirmations', date] })
  })

  if (dayView.isPending || people.isPending || settings.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (dayView.isError || people.isError || settings.isError) {
    return <p className="p-3 text-destructive sm:p-5">Couldn't load this day.</p>
  }

  const view = dayView.data

  // One text per person per day: every confirmation they're on (their own
  // rig's pizzaiolo/crew message, plus any fire-duty note for a rig they're
  // covering) gets combined into a single message, grouped under whichever
  // rig is actually theirs — not scattered across rows per event.
  const personGroups = (() => {
    if (!confirmations.data) return []
    const eventInfo = new Map(
      view.rigs.flatMap((rig) => rig.events.map((event) => [event.id, { time: event.firstPizzaTime, rig }] as const))
    )
    type Confirmation = (typeof confirmations.data)[number]
    const byPerson = new Map<string, Confirmation[]>()
    for (const confirmation of confirmations.data) {
      const list = byPerson.get(confirmation.personId) ?? []
      list.push(confirmation)
      byPerson.set(confirmation.personId, list)
    }

    return [...byPerson.entries()].flatMap(([personId, personConfirmations]) => {
      const person = people.data.find((candidate) => candidate.id === personId)
      if (!person) return []

      const primary = personConfirmations.find((c) => c.role === 'pizzaiolo' || c.role === 'crew')
      const homeRig = primary ? eventInfo.get(primary.eventId)?.rig : undefined
      const role = primary?.role ?? personConfirmations[0]?.role ?? 'crew'

      const sorted = [...personConfirmations].sort((a, b) =>
        (eventInfo.get(a.eventId)?.time ?? '').localeCompare(eventInfo.get(b.eventId)?.time ?? '')
      )
      const overallStatus = sorted.reduce(
        (worst, c) => ((STATUS_PRIORITY[c.status] ?? 0) < (STATUS_PRIORITY[worst] ?? 0) ? c.status : worst),
        sorted[0]?.status ?? 'pending'
      )

      // The same moment the board draws their arrival badge at, so the list
      // and the board can't disagree about when someone is due in. This is
      // the time that actually goes out in their text, so it has to follow
      // fire duty rather than job title — on a day the crew member lights
      // the fire, they're the one told to come in early.
      const firstEvent = homeRig
        ? [...homeRig.events].sort((a, b) => a.firstPizzaTime.localeCompare(b.firstPizzaTime))[0]
        : undefined
      const arrivalIso = firstEvent
        ? arrivalIsoFor(people.data, settings.data, firstEvent, homeRig?.fireDuty ?? null, personId)
        : null

      return [
        {
          personId,
          personName: person.name,
          // Redacted to null for non-owners; this whole panel is the
          // operator's, so an empty string never reaches a link.
          personPhone: person.phone ?? '',
          homeRigRig: homeRig?.rig ?? 'other',
          homeRigLabel: homeRig?.label ?? 'Other',
          role,
          arrivalIso,
          combinedBody: sorted.map((c) => c.messageBody).join('\n\n'),
          confirmationIds: sorted.map((c) => c.id),
          overallStatus
        }
      ]
    })
  })()

  const rigOrder = [...view.rigs.map((rig) => rig.rig), 'other']
  const groupsByRig = rigOrder
    .map((rig) => ({ rig, groups: personGroups.filter((group) => group.homeRigRig === rig) }))
    .filter(({ groups }) => groups.length > 0)

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:space-y-6 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button asChild variant="outline" size="sm">
            <Link to="/day/$date" params={{ date: addDaysToKey(date, -1) }}>
              ‹
            </Link>
          </Button>
          <h1 className="text-lg font-semibold sm:text-2xl">{formatDateLabel(date)}</h1>
          <Button asChild variant="outline" size="sm">
            <Link to="/day/$date" params={{ date: addDaysToKey(date, 1) }}>
              ›
            </Link>
          </Button>
        </div>
        {isOwner ? (
          <Button size="sm" onClick={() => setDrawer({ kind: 'event' })}>
            + New event
          </Button>
        ) : null}
      </div>

      <DayBoard
        dayView={view}
        people={people.data}
        settings={settings.data}
        trucks={trucks.data ?? []}
        onEditEvent={(eventId) => {
          const rig = view.rigs.find((candidate) => candidate.events.some((event) => event.id === eventId))
          setDrawer({ kind: 'event', eventId, rig: rig?.rig })
        }}
        onEditRigCrew={(rig) => setDrawer({ kind: 'rig-crew', rig })}
        canEdit={isOwner}
        expandSoleRig={!isOwner}
      />

      <Card>
        <CardHeader>
          <CardTitle>Day before list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isOwner && confirmations.isError ? (
            <p className="text-sm text-destructive">Couldn't load confirmations — crew texts are hidden.</p>
          ) : null}

          {view.rigs
            .filter((rig) => rig.events.length > 0)
            .map((rig) => (
              <RigGroup key={rig.rig} title={rig.label}>
                {/* Whose text has gone out is the operator's business; the
                    crew see the prep numbers for their own rig and nothing
                    about who else was contacted. */}
                {isOwner ? (
                  confirmations.isPending ? (
                    <Skeleton className="mb-3 h-16 w-full" />
                  ) : (
                    <CrewRows
                      groups={groupsByRig.find((entry) => entry.rig === rig.rig)?.groups ?? []}
                      onSetStatus={(ids, status) => setStatus.mutate({ ids, status })}
                      divider
                    />
                  )
                ) : null}
                <ConsumablesGrid consumables={rig.consumables} />
              </RigGroup>
            ))}

          {/* Anyone whose own rig couldn't be worked out (a fire-duty note
              with no shift of their own) still needs their text sent, so
              they get a group rather than being quietly dropped. */}
          {groupsByRig
            .filter((entry) => !view.rigs.some((rig) => rig.rig === entry.rig && rig.events.length > 0))
            .map((entry) => (
              <RigGroup key={entry.rig} title={entry.groups[0]?.homeRigLabel ?? 'Other'}>
                <CrewRows groups={entry.groups} onSetStatus={(ids, status) => setStatus.mutate({ ids, status })} />
              </RigGroup>
            ))}

          {/* The day-wide total is a second copy of the same numbers once the
              view is scoped to one rig, and it reads as a claim about the
              whole operation that this person can't see. */}
          {isOwner ? (
            <RigGroup title="All rigs" isTotal>
              <ConsumablesGrid consumables={view.consumables} />
            </RigGroup>
          ) : null}
        </CardContent>
      </Card>

      <Sheet open={drawer !== null} onOpenChange={(open) => !open && setDrawer(null)}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto p-0 sm:max-w-xl"
          // First Escape dismisses an open address suggestion list, second one
          // closes the drawer. Radix decides this in a capture-phase listener
          // on document, before the field's own handler runs, so the state has
          // to be read from the DOM — `aria-expanded` on the combobox is the
          // field's own record of whether its list is showing.
          onEscapeKeyDown={(escapeEvent) => {
            if (document.querySelector('#address[aria-expanded="true"]')) escapeEvent.preventDefault()
          }}
        >
          {drawer?.kind === 'event' ? (
            <EventForm
              key={drawer.eventId ?? 'new'}
              eventId={drawer.eventId}
              defaultDate={date}
              defaultRig={drawer.rig}
              onClose={() => setDrawer(null)}
              onSaved={(saved) => {
                setDrawer(null)
                const savedDate = toDateKey(new Date(saved.firstPizzaTime))
                if (savedDate !== date) void navigate({ to: '/day/$date', params: { date: savedDate } })
              }}
            />
          ) : drawer?.kind === 'rig-crew' ? (
            <RigCrewForm key={drawer.rig} date={date} rig={drawer.rig} onSaved={() => setDrawer(null)} />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

export const Route = createFileRoute('/_auth/day/$date')({ component: Day })
