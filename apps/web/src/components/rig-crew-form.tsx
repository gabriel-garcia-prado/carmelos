import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useApiClient } from '@/components/api-client-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { arrivalIsoFor, pizzaioloOf, stickOf } from '@/lib/day-blocks'
import { formatClockTime } from '@/lib/format'
import type { Rig } from '@/lib/rigs'
import { RIG_LABELS } from '@/lib/rigs'

/** Who works one party. */
type PartyCrew = Readonly<{
  pizzaioloId: string
  stickId: string
  cutterIds: readonly string[]
  /** Person ids making their own way to the site rather than riding out. */
  meetsOnSite: readonly string[]
}>

type RigCrewState = Readonly<{
  /** One entry per party on the rig, keyed by event id. */
  byParty: Readonly<Record<string, PartyCrew>>
  /**
   * Whether every party shares one crew — nearly always true, so it's the
   * default and the form shows a single pair of pickers. Unticking it is the
   * uncommon day: a stick who can only do the afternoon, or one who leaves and
   * is replaced.
   */
  linked: boolean
  fireDutyOverridePersonId: string
  crewArrivalMinutes: string
  truckId: string
  /**
   * The rig's stored state this form was filled from.
   *
   * React Query hands back the cached day while it refetches, so reopening
   * straight after a save seeds from data that is one save out of date. Keeping
   * the signature lets the form notice when the real answer arrives and reseed
   * — which it does only while untouched, so a background refetch can't wipe
   * what someone is halfway through typing.
   */
  seededFrom: string
  dirty: boolean
}>

type RigCrewFormProperties = Readonly<{ date: string; rig: Rig; onSaved: () => void }>

const sameCrew = (first: PartyCrew, second: PartyCrew): boolean =>
  first.pizzaioloId === second.pizzaioloId &&
  first.stickId === second.stickId &&
  first.cutterIds.join() === second.cutterIds.join() &&
  [...first.meetsOnSite].sort().join() === [...second.meetsOnSite].sort().join()

/** Sets who works a rig — one crew for the day, or a different one per party. */
export const RigCrewForm = ({ date, rig, onSaved }: RigCrewFormProperties) => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const [state, setState] = useState<RigCrewState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const people = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const response = await client.api.people.$get()
      if (!response.ok) throw new Error('Failed to load people')
      return response.json()
    }
  })

  const dayView = useQuery({
    queryKey: ['day', date],
    queryFn: async () => {
      const response = await client.api.events.day[':date'].$get({ param: { date } })
      if (!response.ok) throw new Error('Failed to load the day')
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

  // Needed to work out when each crew member is due in — their own lead
  // time before their rig leaves, or the shop-wide default.
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const response = await client.api.settings.$get()
      if (!response.ok) throw new Error('Failed to load settings')
      return response.json()
    }
  })

  const rigEventsToday = [...(dayView.data?.rigs.find((candidate) => candidate.rig === rig)?.events ?? [])].sort(
    (first, second) => first.firstPizzaTime.localeCompare(second.firstPizzaTime)
  )

  const storedSignature = JSON.stringify(
    rigEventsToday.map((event) => [
      event.id,
      event.assignments,
      event.fireDutyOverridePersonId,
      event.crewArrivalOverrideMinutes,
      event.truckId
    ])
  )

  useEffect(() => {
    if (rigEventsToday.length === 0) return
    if (state && (state.dirty || state.seededFrom === storedSignature)) return
    const byParty = Object.fromEntries(
      rigEventsToday.map((event) => [
        event.id,
        {
          pizzaioloId: pizzaioloOf(event.assignments)?.personId ?? '',
          stickId: stickOf(event.assignments)?.personId ?? '',
          cutterIds: event.assignments
            .filter((assignment) => assignment.role === 'cutter')
            .map((assignment) => assignment.personId),
          meetsOnSite: event.assignments
            .filter((assignment) => assignment.meetsOnSite)
            .map((assignment) => assignment.personId)
        }
      ])
    )
    // The overrides live on whichever party is chronologically first for this
    // rig today — the same one `updateRigCrew` writes them back onto.
    const earliest = rigEventsToday[0]
    if (!earliest) return
    const crews = Object.values(byParty)
    setState({
      byParty,
      // Split only when the day already is: reopening a rig whose afternoon
      // stick differs shouldn't quietly relink and overwrite them on save.
      linked: crews.every((crew) => sameCrew(crew, crews[0] as PartyCrew)),
      fireDutyOverridePersonId: earliest.fireDutyOverridePersonId ?? 'none',
      crewArrivalMinutes:
        earliest.crewArrivalOverrideMinutes === null ? '' : String(earliest.crewArrivalOverrideMinutes),
      // Null means the rig runs its namesake truck, and the ids match the rig
      // slugs, so the rig itself is the default.
      truckId: earliest.truckId ?? rig,
      seededFrom: storedSignature,
      dirty: false
    })
  }, [rigEventsToday, rig, state, storedSignature])

  // Who's already working elsewhere today, and where. Nobody gets swapped out
  // any more — a person can work two rigs in a day — so this is a note, not a
  // consequence. Whether it's actually possible is the overlap check's call on
  // save, which knows the times; this just says "they're also on the Bus".
  const otherRigOf = new Map<string, string>()
  for (const candidate of dayView.data?.rigs ?? []) {
    if (candidate.rig === rig) continue
    for (const event of candidate.events) {
      for (const assignment of event.assignments) otherRigOf.set(assignment.personId, candidate.label)
    }
  }
  const alsoOnNote = (personId: string) => (otherRigOf.has(personId) ? ` (also on ${otherRigOf.get(personId)})` : '')

  const earliestOf = <T extends { firstPizzaTime: string }>(events: readonly T[]): T | undefined =>
    [...events].sort((a, b) => a.firstPizzaTime.localeCompare(b.firstPizzaTime))[0]

  const firstPartyId = rigEventsToday[0]?.id ?? ''
  const primary = state?.byParty[firstPartyId]

  // When this rig's fire has to be lit. The NATURAL time, not the currently
  // assigned one — if someone else is covering it right now their bundled
  // (earlier) lighting moment isn't what a different opener would face.
  const rigFirstEvent = rigEventsToday[0]
  const fireTime = rigFirstEvent?.computed.naturalFireLitTime ?? null

  // Everyone's window at the shop: from when they're due in until their own
  // rig pulls out. Lighting a fire means being there for it, so this is what
  // decides who can be offered the job.
  const presence = new Map<string, { from: number; to: number }>()
  if (people.data && settings.data) {
    for (const candidate of dayView.data?.rigs ?? []) {
      const first = earliestOf(candidate.events)
      if (!first) continue
      const to = new Date(first.computed.leaveTime).getTime()
      // The pizzaiolo is in as early as the fire — unless someone else is
      // covering it, in which case they only turn up for the handover.
      const pizzaioloFrom = candidate.fireDuty
        ? candidate.fireDuty.isCovered
          ? candidate.fireDuty.ownArrivalTime
          : candidate.fireDuty.litAt
        : first.computed.leaveTime
      const firstPizzaiolo = pizzaioloOf(first.assignments)?.personId
      if (firstPizzaiolo) presence.set(firstPizzaiolo, { from: new Date(pizzaioloFrom).getTime(), to })
      // The stick is in early too when THEY are the one lighting this rig's
      // fire — which also makes them available to cover another rig.
      const firstStick = stickOf(first.assignments)?.personId
      if (firstStick) {
        presence.set(firstStick, {
          from: new Date(arrivalIsoFor(people.data, settings.data, first, candidate.fireDuty, firstStick)).getTime(),
          to
        })
      }
    }
  }

  // Live preview of what the entered lead time actually means on the clock,
  // so "20 minutes" reads as a time Billy can check against the board.
  const rigLeaveTime = rigFirstEvent?.computed.leaveTime ?? null
  const stickName = people.data?.find((person) => person.id === primary?.stickId)?.name ?? ''
  const effectiveLead =
    state?.crewArrivalMinutes !== undefined && state.crewArrivalMinutes !== ''
      ? Number(state.crewArrivalMinutes)
      : (people.data?.find((person) => person.id === primary?.stickId)?.minutesBeforeDepartureOverride ??
        settings.data?.defaultMinutesBeforeDeparture ??
        15)
  const crewDueAt = rigLeaveTime
    ? new Date(new Date(rigLeaveTime).getTime() - effectiveLead * 60_000).toISOString()
    : null

  const canLightThisFire = (personId: string): boolean => {
    // This rig's own pizzaiolo is the default opener — they come in for
    // exactly this, so they're always eligible however the day shakes out.
    if (personId === primary?.pizzaioloId) return true
    // So is its own stick. Judging them by the presence window below is
    // circular: that window starts at the lead time they'd have if they
    // WEREN'T lighting the fire, which is the very arrival this choice
    // replaces. Give them the match and they come in for it instead.
    if (personId === primary?.stickId) return true
    if (!fireTime) return true
    const window_ = presence.get(personId)
    if (!window_) return false
    const at = new Date(fireTime).getTime()
    return window_.from <= at && at <= window_.to
  }

  /**
   * Someone taking a seat on a party that isn't the rig's first, who wasn't on
   * the party before it, can't ride out with the rig — it's at the last party,
   * where they never were. Ticking the box is only a convenience here; the
   * arrival itself is derived server-side so a forgotten tick can't send
   * anyone to a departure they can't reach.
   */
  const joinsMidDay = (eventId: string, personId: string): boolean => {
    const index = rigEventsToday.findIndex((event) => event.id === eventId)
    if (index <= 0) return false
    return !rigEventsToday[index - 1]?.assignments.some((assignment) => assignment.personId === personId)
  }

  /** Writes a change to one party, or to all of them while they're linked. */
  const setCrew = (eventId: string, patch: (crew: PartyCrew) => PartyCrew) => {
    if (!state) return
    const targets = state.linked ? Object.keys(state.byParty) : [eventId]
    setState({
      ...state,
      dirty: true,
      byParty: Object.fromEntries(
        Object.entries(state.byParty).map(([id, crew]) => [id, targets.includes(id) ? patch(crew) : crew])
      )
    })
  }

  /**
   * Turning "set per party" off doesn't just stop splitting future edits — it
   * has to collapse the parties that are already split onto the one crew the
   * form is now showing. Leaving them alone made the form claim one crew for
   * the rig while quietly saving the old, different ones.
   */
  /**
   * Flips the switch and nothing else.
   *
   * Collapsing the parties here would make the toggle destructive: split the
   * crew, put a different stick on the afternoon, flick the switch off and on
   * again, and that stick is gone. So the parties keep their own answers and
   * the collapse happens on save — see `crewFor`. Off still means one crew for
   * the rig, it's just decided at the moment it's written rather than the
   * moment the box is unticked.
   */
  const setLinked = (linked: boolean) => {
    if (!state) return
    setState({ ...state, linked, dirty: true })
  }

  /**
   * Which crew a party is saved with: the one on screen when the parties are
   * linked, its own when they aren't.
   *
   * Editing while linked already writes through to every party (see
   * `setCrew`), so this only settles the parties that were split earlier and
   * haven't been touched since.
   */
  const crewFor = (eventId: string, byParty: RigCrewState['byParty'], linked: boolean): PartyCrew =>
    (linked ? (byParty[firstPartyId] ?? byParty[eventId]) : byParty[eventId]) as PartyCrew

  const reseat = (eventId: string, crew: PartyCrew, incoming: string, outgoing: string): readonly string[] => {
    const without = crew.meetsOnSite.filter((id) => id !== outgoing)
    return joinsMidDay(eventId, incoming) ? [...new Set([...without, incoming])] : without
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!state) return
      const response = await client.api.events['rig-crew'].$patch({
        json: {
          date,
          rig,
          parties: Object.keys(state.byParty).map((eventId) => {
            const crew = crewFor(eventId, state.byParty, state.linked)
            return {
              eventId,
              assignments: [
                {
                  personId: crew.pizzaioloId,
                  role: 'pizzaiolo' as const,
                  meetsOnSite: crew.meetsOnSite.includes(crew.pizzaioloId)
                },
                {
                  personId: crew.stickId,
                  role: 'stick' as const,
                  meetsOnSite: crew.meetsOnSite.includes(crew.stickId)
                },
                ...crew.cutterIds.map((personId) => ({
                  personId,
                  role: 'cutter' as const,
                  meetsOnSite: crew.meetsOnSite.includes(personId)
                }))
              ]
            }
          }),
          fireDutyOverridePersonId: state.fireDutyOverridePersonId === 'none' ? null : state.fireDutyOverridePersonId,
          crewArrivalOverrideMinutes: state.crewArrivalMinutes === '' ? null : Number(state.crewArrivalMinutes),
          truckId: state.truckId
        }
      })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
      return response.json()
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['day'] })
      await queryClient.invalidateQueries({ queryKey: ['confirmations'] })
      onSaved()
    },
    onError: (mutationError: Error) => setError(mutationError.message)
  })

  // Whoever is on the rig has to be able to move the truck, and a towed oven
  // needs someone cleared for a trailer. Shown as a warning rather than a
  // block — Billy knows things the app doesn't, and a wrong truck is a thing
  // to notice, not a thing to be prevented from recording.
  const chosenTruck = trucks.data?.find((truck) => truck.id === state?.truckId)
  const everyoneOnTheRig = new Set(
    Object.values(state?.byParty ?? {}).flatMap((crew) => [crew.pizzaioloId, crew.stickId, ...crew.cutterIds])
  )
  const assignedCrew = (people.data ?? []).filter((person) => everyoneOnTheRig.has(person.id))
  const truckWarning = !chosenTruck
    ? null
    : !assignedCrew.some((person) => person.canDrive)
      ? `Nobody on this rig can drive ${chosenTruck.name}.`
      : chosenTruck.ovenMount === 'trailer' && !assignedCrew.some((person) => person.canDrive && person.canDriveTrailer)
        ? `${chosenTruck.name} tows its oven, and nobody here is cleared for a trailer.`
        : null

  if (people.isPending || dayView.isPending || settings.isPending || trucks.isPending || !people.data || !state) {
    return <Skeleton className="mx-auto h-64 w-full max-w-xl" />
  }

  const partyLabel = (eventId: string): string => {
    const event = rigEventsToday.find((candidate) => candidate.id === eventId)
    if (!event) return 'Party'
    return `${formatClockTime(event.firstPizzaTime)} · ${event.clientName ?? 'Party'}`
  }

  /** Everyone on one party: the two required seats, then any extra hands. */
  const crewRow = (eventId: string, crew: PartyCrew) => {
    /**
     * Cutters and who-makes-their-own-way belong to a party, not to a rig's
     * day, so they're only offered when this row IS a party.
     *
     * Spread across a whole day they stop meaning anything: the same extra
     * hand on every party, and someone "meeting us there" at a party they
     * reach on the truck they were already sitting in. A rig with one party
     * is the exception — its day and its party are the same thing.
     *
     * Still shown if there's already something there, so a value set while
     * split can't be stranded out of reach after relinking.
     */
    const perParty = !state.linked || rigEventsToday.length === 1
    const showExtras = perParty || crew.cutterIds.length > 0 || crew.meetsOnSite.length > 0

    return (
      <div className="space-y-3">
        <div className={`grid grid-cols-1 gap-3 ${showExtras ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          <div className="space-y-1">
            <Label htmlFor={`pizzaiolo-${eventId}`}>Pizzaiolo</Label>
            <Select
              value={crew.pizzaioloId}
              onValueChange={(value) =>
                setCrew(eventId, (current) => ({
                  ...current,
                  pizzaioloId: value,
                  meetsOnSite: reseat(eventId, current, value, current.pizzaioloId)
                }))
              }
            >
              <SelectTrigger id={`pizzaiolo-${eventId}`}>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {people.data
                  ?.filter((person) => person.isPizzaiolo)
                  .map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                      {alsoOnNote(person.id)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor={`stick-${eventId}`}>Stick</Label>
            <Select
              value={crew.stickId}
              onValueChange={(value) =>
                setCrew(eventId, (current) => ({
                  ...current,
                  stickId: value,
                  meetsOnSite: reseat(eventId, current, value, current.stickId)
                }))
              }
            >
              <SelectTrigger id={`stick-${eventId}`}>
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {/* Cutters-only are left out: the seat refuses them on save, and
                  offering a choice that can't be taken is worse than not
                  offering it. */}
                {people.data
                  ?.filter((person) => person.canStick)
                  .map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                      {alsoOnNote(person.id)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* Third seat onwards. Optional and usually empty, so it sits in the
            row rather than behind anything — an empty column reads as "no
            cutters" at a glance, which is the answer most days. */}
          {showExtras ? (
            <div className="space-y-1">
              <Label>Cutters</Label>
              <div className="space-y-2">
                {crew.cutterIds.map((cutterId) => (
                  <div key={cutterId} className="flex items-center gap-1">
                    <Select
                      value={cutterId}
                      onValueChange={(value) =>
                        setCrew(eventId, (current) => ({
                          ...current,
                          cutterIds: current.cutterIds.map((id) => (id === cutterId ? value : id))
                        }))
                      }
                    >
                      <SelectTrigger className="min-w-0 flex-1">
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        {people.data
                          ?.filter(
                            (person) =>
                              person.id !== crew.pizzaioloId &&
                              person.id !== crew.stickId &&
                              (person.id === cutterId || !crew.cutterIds.includes(person.id))
                          )
                          .map((person) => (
                            <SelectItem key={person.id} value={person.id}>
                              {person.name}
                              {alsoOnNote(person.id)}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title="Remove this cutter"
                      className="h-8 w-8 shrink-0 p-0"
                      onClick={() =>
                        setCrew(eventId, (current) => ({
                          ...current,
                          cutterIds: current.cutterIds.filter((id) => id !== cutterId)
                        }))
                      }
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    const free = people.data?.find(
                      (person) =>
                        person.id !== crew.pizzaioloId &&
                        person.id !== crew.stickId &&
                        !crew.cutterIds.includes(person.id)
                    )
                    if (!free) return
                    // New cutters default to meeting at the site, which is how the
                    // extra hands usually turn up.
                    setCrew(eventId, (current) => ({
                      ...current,
                      cutterIds: [...current.cutterIds, free.id],
                      meetsOnSite: [...current.meetsOnSite, free.id]
                    }))
                  }}
                >
                  + Add cutter
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Who makes their own way: due at the site for the start of set-up
          rather than at the shop before the truck leaves. */}
        {showExtras ? (
          <div className="space-y-1">
            <Label>Meeting us there</Label>
            <div className="flex flex-wrap gap-2">
              {[crew.pizzaioloId, crew.stickId, ...crew.cutterIds].filter(Boolean).map((personId) => {
                const forced = joinsMidDay(eventId, personId)
                return (
                  <label
                    key={personId}
                    title={
                      forced ? "They weren't on the party before this one, so there's no truck to ride out on." : ''
                    }
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                      forced ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      // Forced on for a mid-day joiner: it isn't a preference, it's
                      // the only way they can get there.
                      checked={forced || crew.meetsOnSite.includes(personId)}
                      disabled={forced}
                      onChange={(changeEvent) =>
                        setCrew(eventId, (current) => ({
                          ...current,
                          meetsOnSite: changeEvent.target.checked
                            ? [...current.meetsOnSite, personId]
                            : current.meetsOnSite.filter((id) => id !== personId)
                        }))
                      }
                    />
                    {people.data?.find((person) => person.id === personId)?.name ?? personId}
                  </label>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  const linkedCrew = primary ?? (Object.values(state.byParty)[0] as PartyCrew)

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>Edit {RIG_LABELS[rig]}'s crew</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault()
            save.mutate()
          }}
        >
          {/* Splitting the crew is rare, so it's one checkbox rather than a
              section: ticked, the pickers below become one set per party;
              unticked, a single set covers the rig's whole day. */}
          {rigEventsToday.length > 1 ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={!state.linked}
                onChange={(changeEvent) => setLinked(!changeEvent.target.checked)}
              />
              Set per party
            </label>
          ) : null}

          {state.linked ? (
            crewRow(firstPartyId, linkedCrew)
          ) : (
            <div className="space-y-4">
              {rigEventsToday.map((event) => (
                <div key={event.id} className="space-y-3 rounded-md border p-3">
                  <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                    {partyLabel(event.id)}
                  </p>
                  {crewRow(event.id, state.byParty[event.id] as PartyCrew)}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="rig-fire">Who starts the fire</Label>
            <Select
              value={state.fireDutyOverridePersonId}
              onValueChange={(value) => setState({ ...state, fireDutyOverridePersonId: value, dirty: true })}
            >
              <SelectTrigger id="rig-fire">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Let the schedule decide</SelectItem>
                {/* Greyed out rather than removed — same reason as the crew
                    pickers above: Radix can't hold a value whose item never
                    mounts, which would silently blank an existing override. */}
                {people.data.map((person) => {
                  const available = canLightThisFire(person.id)
                  return (
                    <SelectItem key={person.id} value={person.id} disabled={!available}>
                      {person.name}
                      {available ? '' : ' (not at the shop then)'}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
            {fireTime ? (
              <p className="text-xs text-muted-foreground">
                Only people already at the shop for {formatClockTime(fireTime)} can light this one.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="rig-truck">Truck</Label>
            <Select
              value={state.truckId}
              onValueChange={(value) => setState({ ...state, truckId: value, dirty: true })}
            >
              <SelectTrigger id="rig-truck">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(trucks.data ?? []).map((truck) => (
                  <SelectItem key={truck.id} value={truck.id}>
                    {truck.name} — {truck.ovenMount === 'trailer' ? 'trailer' : 'built-in'} oven, {truck.rangeMiles}mi,
                    comfort {truck.comfort}/5
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {truckWarning ? <p className="text-xs text-warn">{truckWarning}</p> : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="rig-crew-arrival">Crew arrives (minutes before the truck leaves)</Label>
            <Input
              id="rig-crew-arrival"
              type="number"
              min="0"
              placeholder={`default ${settings.data?.defaultMinutesBeforeDeparture ?? 15}`}
              value={state.crewArrivalMinutes}
              onChange={(changeEvent) =>
                setState({ ...state, crewArrivalMinutes: changeEvent.target.value, dirty: true })
              }
            />
            {rigLeaveTime ? (
              <p className="text-xs text-muted-foreground">
                {RIG_LABELS[rig]} leaves at {formatClockTime(rigLeaveTime)} — {stickName || 'the crew'} is due in at{' '}
                {formatClockTime(crewDueAt)}.
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="border-l-2 border-bad bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save crew'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
