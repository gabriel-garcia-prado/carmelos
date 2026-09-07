import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useApiClient } from '@/components/api-client-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { arrivalIsoFor } from '@/lib/day-blocks'
import { formatClockTime } from '@/lib/format'
import type { Rig } from '@/lib/rigs'
import { RIG_LABELS } from '@/lib/rigs'

type RigCrewState = Readonly<{
  pizzaioloId: string
  crewMemberId: string
  fireDutyOverridePersonId: string
  crewArrivalMinutes: string
  truckId: string
}>

type RigCrewFormProperties = Readonly<{ date: string; rig: Rig; onSaved: () => void }>

/** Changes the pizzaiolo/crew for every event on one rig's day at once —
 * the only way to change crew once a rig has more than one event, so a
 * single-event edit can never quietly fork what "this rig's crew" means. */
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

  useEffect(() => {
    if (state !== null || !dayView.data) return
    const rigEvents = dayView.data.rigs.find((candidate) => candidate.rig === rig)?.events ?? []
    // The override lives on whichever event is chronologically first for
    // this rig today — same event `updateRigCrew` writes it back onto.
    const earliest = [...rigEvents].sort(
      (a, b) => new Date(a.firstPizzaTime).getTime() - new Date(b.firstPizzaTime).getTime()
    )[0]
    if (earliest) {
      setState({
        pizzaioloId: earliest.pizzaioloId,
        crewMemberId: earliest.crewMemberId,
        fireDutyOverridePersonId: earliest.fireDutyOverridePersonId ?? 'none',
        crewArrivalMinutes:
          earliest.crewArrivalOverrideMinutes === null ? '' : String(earliest.crewArrivalOverrideMinutes),
        // Null means the rig runs its namesake truck, and the ids match the
        // rig slugs, so the rig itself is the default.
        truckId: earliest.truckId ?? rig
      })
    }
  }, [dayView.data, rig, state])

  // Who's on another rig today, and which one — picking them isn't blocked
  // any more, it swaps them with whoever they displace here, so the label
  // says where they're coming from rather than shutting the option off.
  const otherRigOf = new Map<string, string>()
  for (const candidate of dayView.data?.rigs ?? []) {
    if (candidate.rig === rig) continue
    for (const event of candidate.events) {
      otherRigOf.set(event.pizzaioloId, candidate.label)
      otherRigOf.set(event.crewMemberId, candidate.label)
    }
  }
  const swapNote = (personId: string) => (otherRigOf.has(personId) ? ` (swap with ${otherRigOf.get(personId)})` : '')

  const earliestOf = <T extends { firstPizzaTime: string }>(events: readonly T[]): T | undefined =>
    [...events].sort((a, b) => a.firstPizzaTime.localeCompare(b.firstPizzaTime))[0]

  // When this rig's fire has to be lit. The NATURAL time, not the currently
  // assigned one — if someone else is covering it right now their bundled
  // (earlier) lighting moment isn't what a different opener would face.
  const rigFirstEvent = earliestOf(dayView.data?.rigs.find((candidate) => candidate.rig === rig)?.events ?? [])
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
      presence.set(first.pizzaioloId, { from: new Date(pizzaioloFrom).getTime(), to })
      // The crew member is in early too when THEY are the one lighting this
      // rig's fire — which also makes them available to cover another rig.
      presence.set(first.crewMemberId, {
        from: new Date(
          arrivalIsoFor(people.data, settings.data, first, candidate.fireDuty, first.crewMemberId)
        ).getTime(),
        to
      })
    }
  }

  // Live preview of what the entered lead time actually means on the clock,
  // so "20 minutes" reads as a time Billy can check against the board.
  const rigLeaveTime = rigFirstEvent?.computed.leaveTime ?? null
  const crewName = people.data?.find((person) => person.id === state?.crewMemberId)?.name ?? ''
  const effectiveLead =
    state?.crewArrivalMinutes !== undefined && state.crewArrivalMinutes !== ''
      ? Number(state.crewArrivalMinutes)
      : (people.data?.find((person) => person.id === state?.crewMemberId)?.minutesBeforeDepartureOverride ??
        settings.data?.defaultMinutesBeforeDeparture ??
        15)
  const crewDueAt = rigLeaveTime
    ? new Date(new Date(rigLeaveTime).getTime() - effectiveLead * 60_000).toISOString()
    : null

  const canLightThisFire = (personId: string): boolean => {
    // This rig's own pizzaiolo is the default opener — they come in for
    // exactly this, so they're always eligible however the day shakes out.
    if (personId === state?.pizzaioloId) return true
    // So is its own crew member. Judging them by the presence window below
    // is circular: that window starts at the lead time they'd have if they
    // WEREN'T lighting the fire, which is the very arrival this choice
    // replaces. Give them the match and they come in for it instead.
    if (personId === state?.crewMemberId) return true
    if (!fireTime) return true
    const window_ = presence.get(personId)
    if (!window_) return false
    const at = new Date(fireTime).getTime()
    return window_.from <= at && at <= window_.to
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!state) return
      const response = await client.api.events['rig-crew'].$patch({
        json: {
          date,
          rig,
          pizzaioloId: state.pizzaioloId,
          crewMemberId: state.crewMemberId,
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
  const assignedCrew = (people.data ?? []).filter(
    (person) => person.id === state?.pizzaioloId || person.id === state?.crewMemberId
  )
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
          <p className="text-sm text-muted-foreground">
            Changes every event on {RIG_LABELS[rig]} today to this pizzaiolo and crew member.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="rig-pizzaiolo">Pizzaiolo</Label>
              <Select value={state.pizzaioloId} onValueChange={(value) => setState({ ...state, pizzaioloId: value })}>
                <SelectTrigger id="rig-pizzaiolo">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {people.data
                    .filter((person) => person.isPizzaiolo)
                    .map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.name}
                        {swapNote(person.id)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rig-crew">Crew member</Label>
              <Select value={state.crewMemberId} onValueChange={(value) => setState({ ...state, crewMemberId: value })}>
                <SelectTrigger id="rig-crew">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {people.data.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                      {swapNote(person.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="rig-fire">Who starts the fire</Label>
            <Select
              value={state.fireDutyOverridePersonId}
              onValueChange={(value) => setState({ ...state, fireDutyOverridePersonId: value })}
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
            <Label htmlFor="rig-crew-arrival">Crew arrives (minutes before the truck leaves)</Label>
            <Input
              id="rig-crew-arrival"
              type="number"
              min="0"
              placeholder={`default ${settings.data?.defaultMinutesBeforeDeparture ?? 15}`}
              value={state.crewArrivalMinutes}
              onChange={(changeEvent) => setState({ ...state, crewArrivalMinutes: changeEvent.target.value })}
            />
            {rigLeaveTime ? (
              <p className="text-xs text-muted-foreground">
                {RIG_LABELS[rig]} leaves at {formatClockTime(rigLeaveTime)} — {crewName || 'the crew'} is due in at{' '}
                {formatClockTime(crewDueAt)}.
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="rig-truck">Truck</Label>
            <Select value={state.truckId} onValueChange={(value) => setState({ ...state, truckId: value })}>
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
