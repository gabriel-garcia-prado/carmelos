import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { AddressAutocomplete } from '@/components/address-autocomplete'
import { useApiClient } from '@/components/api-client-provider'
import { EventPreviewLane } from '@/components/event-preview-lane'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { formatClockTime, formatDuration, toDateKey } from '@/lib/format'
import type { RequestType, Rig } from '@/lib/rigs'
import { REQUEST_LABELS, REQUEST_TYPES, RIG_LABELS, RIGS } from '@/lib/rigs'

type Turnaround = 'fine' | 'tight' | 'bad'

const FIT_RING: Readonly<Record<Turnaround, string>> = {
  fine: 'ring-2 ring-good',
  tight: 'ring-2 ring-warn',
  bad: 'ring-2 ring-bad'
}

// How long the oven is actually serving. Free-typed minutes were never really
// free - every booking lands on one of these - and a number field invited
// values the rest of the chain has no sensible answer for.
const DURATION_CHOICES = [90, 120, 180, 240] as const

const FIT_TEXT: Readonly<Record<Turnaround, string>> = {
  fine: 'text-good',
  tight: 'text-warn',
  bad: 'text-bad'
}

type RequestState = Record<RequestType, { checked: boolean; headcount: string }>

const emptyRequests = (): RequestState =>
  Object.fromEntries(REQUEST_TYPES.map((type) => [type, { checked: false, headcount: '' }])) as RequestState

type FormState = {
  date: string
  time: string
  headcount: string
  address: string
  clientName: string
  rig: Rig
  driveMinutes: string
  driveMinutesBackToShop: string
  serviceDurationMinutes: string
  rackCount: string
  setupMinutesOverride: string
  fireDutyOverridePersonId: string
  requests: RequestState
}

const defaultState = (date: string, rig: Rig): FormState => ({
  date,
  time: '12:00',
  headcount: '',
  address: '',
  clientName: '',
  rig,
  driveMinutes: '',
  driveMinutesBackToShop: '',
  serviceDurationMinutes: '120',
  rackCount: '0',
  setupMinutesOverride: '',
  fireDutyOverridePersonId: 'none',
  requests: emptyRequests()
})

type EventFormProperties = Readonly<{
  eventId?: string
  defaultDate: string
  defaultRig?: Rig
  // When given, called instead of navigating to the day view on save — the
  // drawer uses this to just close itself, since it's already showing that day.
  onSaved?: (saved: Readonly<{ firstPizzaTime: string }>) => void
  // Same idea for backing out or deleting: the drawer closes, a standalone
  // page falls back to the day the form is pointed at.
  onClose?: () => void
}>

export const EventForm = ({ eventId, defaultDate, defaultRig, onSaved, onClose }: EventFormProperties) => {
  const client = useApiClient()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [state, setState] = useState<FormState>(defaultState(defaultDate, defaultRig ?? RIGS[0]))
  const [error, setError] = useState<string | null>(null)
  const [driveError, setDriveError] = useState<string | null>(null)
  // Deleting a booked party is not undoable and there's no trash to fish it
  // back out of, so the button asks once before it does it.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Which origin the drive times currently in state were measured against.
  const measuredFrom = useRef<string | null>(null)

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

  // Same rig's other events that day, so "Calculate" can measure from the
  // preceding party's address instead of the shop when this isn't the rig's
  // first event of the day.
  const dayEvents = useQuery({
    queryKey: ['day', state.date],
    queryFn: async () => {
      const response = await client.api.events.day[':date'].$get({ param: { date: state.date } })
      if (!response.ok) throw new Error('Failed to load the day')
      return response.json()
    }
  })

  const calculateDrive = useMutation({
    mutationFn: async (input: { origin: string; destination: string; departureTime: number | 'now' }) => {
      const response = await client.api['drive-time'].$post({ json: input })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
      return response.json()
    }
  })

  // The origin for "drive minutes to here": the address of whichever of this
  // rig's other events that day comes right before the draft's first-pizza
  // time, or the shop if there isn't one.
  const arrivalOrigin = (): string | null => {
    const rigEvents = dayEvents.data?.rigs.find((rig) => rig.rig === state.rig)?.events ?? []
    const draftTime = state.time ? new Date(`${state.date}T${state.time}`).getTime() : null
    const earlier = rigEvents
      .filter(
        (event) => event.id !== eventId && (draftTime === null || new Date(event.firstPizzaTime).getTime() < draftTime)
      )
      .sort((a, b) => new Date(b.firstPizzaTime).getTime() - new Date(a.firstPizzaTime).getTime())[0]
    return earlier ? earlier.address : (settings.data?.kitchenAddress ?? null)
  }

  // Google only returns traffic-aware duration for a departure time that's
  // now or in the future — falls back to "now" (current traffic) rather
  // than the historical average when the estimate lands in the past.
  const asDepartureTime = (target: Date): number | 'now' => {
    const seconds = Math.floor(target.getTime() / 1000)
    return seconds > Date.now() / 1000 ? seconds : 'now'
  }

  // Neither leg's actual leave time is known yet — that's derived server-side
  // from the drive time we're trying to calculate — so this estimates it
  // from what the form already has: on-site needs to be ~setup minutes
  // before first pizza, and the return leg leaves ~service + breakdown after.
  const arrivalDepartureEstimate = (): number | 'now' => {
    const firstPizza = new Date(`${state.date}T${state.time}`)
    const setupMinutes = settings.data?.setupAimedMinutes ?? 60
    return asDepartureTime(new Date(firstPizza.getTime() - setupMinutes * 60_000))
  }

  const returnDepartureEstimate = (): number | 'now' => {
    const firstPizza = new Date(`${state.date}T${state.time}`)
    const serviceMinutes = Number(state.serviceDurationMinutes) || 120
    const breakDownMinutes = settings.data?.breakDownMinutes ?? 30
    return asDepartureTime(new Date(firstPizza.getTime() + (serviceMinutes + breakDownMinutes) * 60_000))
  }

  // Both legs at once: out to the party from wherever the rig is coming
  // from, and back to the shop in case this ends up last of the day. The
  // return leg is never required to save — it only matters for the "home by"
  // line, and the day view already flags a rig that's missing it.
  // Awaited one after the other, not fired together. Both legs share a single
  // useMutation, and firing a second mutate() before the first settles means
  // the first one's per-call callbacks never run — so the arrival leg was
  // measured, returned, and thrown away, leaving the old drive time on screen
  // while the network tab showed a perfectly good answer.
  const calculateBothLegs = async (address: string) => {
    setDriveError(null)
    const origin = arrivalOrigin()
    if (!origin) {
      setDriveError('Set a shop/kitchen address in Settings first.')
      return
    }
    measuredFrom.current = origin

    try {
      const there = await calculateDrive.mutateAsync({
        origin,
        destination: address,
        departureTime: arrivalDepartureEstimate()
      })
      setState((s) => ({ ...s, driveMinutes: String(there.minutes) }))

      // Never required to save — it only feeds the "home by" line, and the day
      // view already flags a rig that's missing it.
      if (settings.data?.kitchenAddress) {
        const back = await calculateDrive.mutateAsync({
          origin: address,
          destination: settings.data.kitchenAddress,
          departureTime: returnDepartureEstimate()
        })
        setState((s) => ({ ...s, driveMinutesBackToShop: String(back.minutes) }))
      }
    } catch (mutationError) {
      setDriveError(mutationError instanceof Error ? mutationError.message : String(mutationError))
    }
  }

  // The drive out is measured from wherever the rig is coming FROM — the
  // party before this one on that rig, or the shop when there isn't one. So
  // switching rigs, or moving the time across another booking, changes the
  // origin and makes the existing number simply wrong. Re-measure when the
  // origin moves away from whatever it was last measured against.
  //
  // Deliberately not keyed on the address as well: that changes on every
  // keystroke while it's being typed, and would fire a request per character.
  // A first measurement comes from picking a Places result or blurring the
  // field; this only ever re-measures something already measured once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on what moves the origin, not on every value the closure reads — see above
  useEffect(() => {
    if (!state.address || state.driveMinutes === '') return
    const origin = arrivalOrigin()
    if (!origin) return
    // The first pass only records where the drive time already on the form is
    // taken to have been measured from. Re-measuring on open would spend two
    // Google calls every time a drawer is opened, and would quietly rewrite a
    // saved number the moment anyone looked at it.
    if (measuredFrom.current === null) {
      measuredFrom.current = origin
      return
    }
    if (origin === measuredFrom.current) return
    void calculateBothLegs(state.address)
  }, [state.rig, state.date, state.time, dayEvents.data])

  const existing = useQuery({
    enabled: Boolean(eventId),
    queryKey: ['event', eventId],
    queryFn: async () => {
      const response = await client.api.events[':id'].$get({ param: { id: eventId as string } })
      if (!response.ok) throw new Error('Failed to load the event')
      return response.json()
    }
  })

  // Both queries have to have landed before the real fields exist; the
  // skeleton stands in until then.
  const formIsMounted = !(people.isPending || (Boolean(eventId) && existing.isPending) || !people.data)

  // Debounced so a live "does this fit" preview doesn't fire a request per
  // keystroke — only after the user pauses on a field that affects the chain.
  const [previewState, setPreviewState] = useState(state)
  useEffect(() => {
    const timeout = setTimeout(() => setPreviewState(state), 400)
    return () => clearTimeout(timeout)
  }, [state])

  const previewReady =
    previewState.date &&
    previewState.time &&
    previewState.driveMinutes !== '' &&
    previewState.serviceDurationMinutes !== '' &&
    previewState.rackCount !== ''

  const turnaroundPreview = useQuery({
    enabled: Boolean(previewReady),
    // Every edited field builds a new query key, and without this `data` drops
    // to undefined until the new one lands — which unmounts the lane and the
    // verdict line, collapses the form back to full width, then puts it all
    // back. Holding the last result keeps the layout still, so a changed rack
    // count moves the blocks instead of blinking the whole drawer.
    placeholderData: keepPreviousData,
    queryKey: [
      'event-preview',
      eventId,
      previewState.rig,
      previewState.date,
      previewState.time,
      previewState.driveMinutes,
      previewState.driveMinutesBackToShop,
      previewState.serviceDurationMinutes,
      previewState.setupMinutesOverride,
      previewState.rackCount
    ],
    queryFn: async () => {
      const response = await client.api.events.preview.$post({
        json: {
          id: eventId,
          rig: previewState.rig,
          firstPizzaTime: new Date(`${previewState.date}T${previewState.time}`).toISOString(),
          driveMinutes: Number(previewState.driveMinutes),
          driveMinutesBackToShop:
            previewState.driveMinutesBackToShop === '' ? null : Number(previewState.driveMinutesBackToShop),
          serviceDurationMinutes: Number(previewState.serviceDurationMinutes),
          setupMinutesOverride:
            previewState.setupMinutesOverride === '' ? null : Number(previewState.setupMinutesOverride),
          rackCount: Number(previewState.rackCount)
        }
      })
      if (!response.ok) throw new Error('Failed to preview')
      return response.json()
    }
  })

  // No prior event on the rig that day (turnaround null) is exactly as good
  // as a comfortable gap — nothing to be tight or bad against.
  // An event saved before this was a dropdown, or from some future preset
  // list, keeps its own value as an extra choice. Without it Radix renders the
  // trigger blank and the first save quietly rewrites the duration.
  const stored = Number(state.serviceDurationMinutes)
  const durationChoices: readonly number[] =
    Number.isFinite(stored) && stored > 0 && !DURATION_CHOICES.includes(stored as (typeof DURATION_CHOICES)[number])
      ? [...DURATION_CHOICES, stored].sort((first, second) => first - second)
      : DURATION_CHOICES

  // Two different failures wear the same red. The draft can be impossible in
  // its own right, or be perfectly fine and shove an existing party past what
  // that party can do - and they need different answers, so they can't share a
  // sentence. Reporting the other party's earliest time as though it were the
  // draft's is what sent the booking walking down the day one number at a time.
  const blockedBy = turnaroundPreview.data?.blockedBy ?? null
  const earliest = turnaroundPreview.data?.earliestFirstPizzaTime ?? null
  const rigLabel = RIG_LABELS[state.rig]
  const clash = blockedBy
    ? `${blockedBy.clientName ?? 'the party'} at ${formatClockTime(blockedBy.firstPizzaTime)}`
    : null

  const badVerdict = clash
    ? earliest
      ? `Would push ${clash} past what it can do. Earliest that works for both is ${formatClockTime(earliest)}`
      : `Would push ${clash} past what it can do, and no later slot on ${rigLabel} works either`
    : earliest
      ? `Doesn't fit on ${rigLabel} — earliest that works is ${formatClockTime(earliest)}`
      : `Doesn't fit on ${rigLabel}, and no other slot today works either`

  const tightVerdict = `Tight turnaround on ${rigLabel}, but bookable`
  const fineVerdict = `Fits comfortably on ${rigLabel}`

  // The lane is up from the moment the drawer opens, drawn from the day that's
  // already loaded for the chosen rig. Once there's enough filled in to
  // schedule a draft, the preview's own merged day takes over and the new
  // chain appears outlined inside it. Same shape either way, so the swap is
  // invisible.
  const laneRigDay =
    turnaroundPreview.data?.rigDay ?? dayEvents.data?.rigs.find((rigView) => rigView.rig === state.rig) ?? null

  const fit: Turnaround | null = turnaroundPreview.data ? (turnaroundPreview.data.turnaround ?? 'fine') : null

  useEffect(() => {
    if (!existing.data) return
    const firstPizza = new Date(existing.data.firstPizzaTime)
    setState({
      date: toDateKey(firstPizza),
      time: firstPizza.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
      headcount: String(existing.data.headcount),
      address: existing.data.address,
      clientName: existing.data.clientName ?? '',
      rig: existing.data.rig,
      driveMinutes: String(existing.data.driveMinutes),
      driveMinutesBackToShop:
        existing.data.driveMinutesBackToShop === null ? '' : String(existing.data.driveMinutesBackToShop),
      serviceDurationMinutes: String(existing.data.serviceDurationMinutes),
      rackCount: String(existing.data.rackCount),
      setupMinutesOverride:
        existing.data.setupMinutesOverride === null ? '' : String(existing.data.setupMinutesOverride),
      fireDutyOverridePersonId: existing.data.fireDutyOverridePersonId ?? 'none',
      requests: {
        ...emptyRequests(),
        ...Object.fromEntries(
          existing.data.specialRequests.map((request) => [
            request.requestType,
            { checked: true, headcount: String(request.headcount) }
          ])
        )
      }
    })
  }, [existing.data])

  const buildPayload = () => ({
    rig: state.rig,
    firstPizzaTime: new Date(`${state.date}T${state.time}`).toISOString(),
    headcount: Number(state.headcount),
    address: state.address,
    clientName: state.clientName.trim() === '' ? null : state.clientName.trim(),
    driveMinutes: Number(state.driveMinutes),
    driveMinutesBackToShop: state.driveMinutesBackToShop === '' ? null : Number(state.driveMinutesBackToShop),
    serviceDurationMinutes: Number(state.serviceDurationMinutes),
    rackCount: Number(state.rackCount),
    specialRequests: REQUEST_TYPES.filter((type) => state.requests[type].checked).map((type) => ({
      requestType: type,
      headcount: Number(state.requests[type].headcount) || 0
    }))
  })

  const save = useMutation({
    mutationFn: async () => {
      const payload = buildPayload()
      const response = eventId
        ? await client.api.events[':id'].$patch({ param: { id: eventId }, json: payload })
        : await client.api.events.$post({ json: payload })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
      return response.json()
    },
    onSuccess: async (saved) => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['day'] })
      await queryClient.invalidateQueries({ queryKey: ['week'] })
      await queryClient.invalidateQueries({ queryKey: ['confirmations'] })
      if (onSaved) {
        onSaved(saved)
      } else {
        await navigate({ to: '/day/$date', params: { date: toDateKey(new Date(saved.firstPizzaTime)) } })
      }
    },
    onError: (mutationError: Error) => setError(mutationError.message)
  })

  const close = () => {
    if (onClose) {
      onClose()
    } else {
      void navigate({ to: '/day/$date', params: { date: state.date } })
    }
  }

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await client.api.events[':id'].$delete({ param: { id } })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['day'] })
      await queryClient.invalidateQueries({ queryKey: ['week'] })
      await queryClient.invalidateQueries({ queryKey: ['confirmations'] })
      close()
    },
    onError: (mutationError: Error) => {
      setConfirmingDelete(false)
      setError(mutationError.message)
    }
  })

  if (!formIsMounted) {
    return <Skeleton className="mx-auto h-96 w-full max-w-xl" />
  }

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>{eventId ? 'Edit event' : 'New event'}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* The lane sits alongside the fields rather than under them, and
            sticks while the form scrolls — the whole point is to watch the
            placement move as the slot changes, which it can't do off-screen.
            It only appears once there's enough filled in to schedule against,
            which is the same moment the fit verdict starts working. */}
        <div className="flex gap-4">
          {laneRigDay && settings.data ? (
            <div className="sticky top-4 self-start">
              <EventPreviewLane
                rigDay={laneRigDay}
                draftEventId={turnaroundPreview.data?.draftEventId ?? null}
                fit={fit}
                settings={settings.data}
              />
            </div>
          ) : null}

          <form
            className="min-w-0 flex-1 space-y-4"
            onSubmit={(submitEvent) => {
              submitEvent.preventDefault()
              save.mutate()
            }}
          >
            {/* Ordered so the answer arrives before the commitment. The address
              fixes both drive legs, service length fixes how long the rig is
              tied up, and only then is the slot asked for — date, first pizza,
              rig — with the fit verdict updating underneath as it changes.
              Asking for the slot first meant finding out it was impossible
              only after everything else had already been filled in. */}
            <div className="space-y-1">
              <Label htmlFor="address">Address</Label>
              <AddressAutocomplete
                id="address"
                required
                placeholder="Start typing and pick from the list"
                value={state.address}
                onChange={(address) => setState({ ...state, address })}
                onSelect={(address) => void calculateBothLegs(address)}
                // Covers an address typed straight in and never picked from the
                // list, which would otherwise reach Save with no drive time.
                onBlur={() => {
                  if (state.address && state.driveMinutes === '' && !calculateDrive.isPending) {
                    void calculateBothLegs(state.address)
                  }
                }}
              />
            </div>

            {/* Client name pairs with service length: together they're the two
              things a caller gives you first — whose party it is and how long
              they want the oven running. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="clientName">Client name</Label>
                <Input
                  id="clientName"
                  required
                  placeholder="e.g. Kaplan Bar Mitzvah"
                  value={state.clientName}
                  onChange={(e) => setState({ ...state, clientName: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="service">Duration</Label>
                <Select
                  value={state.serviceDurationMinutes}
                  // Radix fires an empty value while a Select's items are being
                  // recomputed; taking that verbatim would blank the duration
                  // and fail the save with a validation error.
                  onValueChange={(value) => value && setState({ ...state, serviceDurationMinutes: value })}
                >
                  <SelectTrigger id="service">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {durationChoices.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {formatDuration(minutes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* The slot, ringed by the live verdict. The rig belongs in here with
              the date and time because it's just as much a part of "does this
              fit", and switching it is the usual way out of a clash. */}
            <div className={`grid grid-cols-2 gap-3 rounded-md p-1.5 ${fit ? FIT_RING[fit] : ''}`}>
              <div className="space-y-1">
                <Label htmlFor="date">Date</Label>
                <Input
                  id="date"
                  type="date"
                  required
                  value={state.date}
                  onChange={(e) => setState({ ...state, date: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="time">First pizza</Label>
                <Input
                  id="time"
                  type="time"
                  required
                  value={state.time}
                  onChange={(e) => setState({ ...state, time: e.target.value })}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor="rig">Rig</Label>
                <Select
                  value={state.rig}
                  // Crew isn't chosen here — a new party inherits whoever is
                  // on the rig's latest one, and it's changed from "Edit crew".
                  onValueChange={(rig) => setState((s) => ({ ...s, rig: rig as Rig }))}
                >
                  <SelectTrigger id="rig">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RIGS.map((rig) => (
                      <SelectItem key={rig} value={rig}>
                        {RIG_LABELS[rig]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {fit ? (
              <p className={`text-xs font-medium ${FIT_TEXT[fit]}`}>
                {fit === 'bad' ? badVerdict : fit === 'tight' ? tightVerdict : fineVerdict}
              </p>
            ) : null}

            {/* Both legs are measured from the address, never shown as fields:
              a drive time is a derived number, and the moment it looks like an
              input someone will "fix" it and silently rewrite the whole chain
              behind it. Kept as a caption so it's still checkable — it feeds
              straight into the fit verdict below, and a wrong-looking number
              here is the first clue an address landed in the wrong town. */}
            {state.driveMinutes !== '' || calculateDrive.isPending ? (
              <p className="text-xs text-muted-foreground">
                {calculateDrive.isPending
                  ? 'Measuring drive time…'
                  : `Drive ${state.driveMinutes} min there${
                      state.driveMinutesBackToShop === '' ? '' : ` · ${state.driveMinutesBackToShop} min back`
                    }`}
              </p>
            ) : null}

            {driveError ? (
              <p className="border-l-2 border-bad bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
                {driveError}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="headcount">People</Label>
                <Input
                  id="headcount"
                  type="number"
                  min="1"
                  required
                  value={state.headcount}
                  onChange={(e) => setState({ ...state, headcount: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rack">Rack count</Label>
                <Input
                  id="rack"
                  type="number"
                  min="0"
                  value={state.rackCount}
                  onChange={(e) => setState({ ...state, rackCount: e.target.value })}
                />
              </div>
            </div>

            {/* Crew and fire duty belong to the rig, not the party — they're set
              once for the whole rig's day from its own "Edit crew". */}
            <p className="text-xs text-muted-foreground">
              {RIG_LABELS[state.rig]} decides who runs this one — set its pizzaiolo, crew, fire duty and arrival time
              from the rig's "Edit crew" button on the board.
            </p>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Special requests</legend>
              {REQUEST_TYPES.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <Checkbox
                    id={`request-${type}`}
                    checked={state.requests[type].checked}
                    onCheckedChange={(checked) =>
                      setState({
                        ...state,
                        requests: { ...state.requests, [type]: { ...state.requests[type], checked: checked === true } }
                      })
                    }
                  />
                  <Label htmlFor={`request-${type}`} className="w-32 font-normal">
                    {REQUEST_LABELS[type]}
                  </Label>
                  {state.requests[type].checked ? (
                    <Input
                      type="number"
                      min="1"
                      className="w-24"
                      placeholder="people"
                      value={state.requests[type].headcount}
                      onChange={(e) =>
                        setState({
                          ...state,
                          requests: {
                            ...state.requests,
                            [type]: { ...state.requests[type], headcount: e.target.value }
                          }
                        })
                      }
                    />
                  ) : null}
                </div>
              ))}
            </fieldset>

            {error ? (
              <p className="border-l-2 border-bad bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
                {error}
              </p>
            ) : null}

            <div className="grid grid-cols-[auto_1fr] gap-3">
              <Button type="button" variant="outline" onClick={close} disabled={save.isPending || remove.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending || remove.isPending}>
                {save.isPending ? 'Saving…' : eventId ? 'Save changes' : 'Save event'}
              </Button>
            </div>

            {/* Only an event that exists can be deleted — on a new one there's
              nothing to remove and Cancel already throws the draft away. */}
            {eventId ? (
              <div className="border-t pt-4">
                {confirmingDelete ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      Delete this party for good? Its crew texts and confirmations go with it.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)}>
                        Keep it
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(eventId)}
                      >
                        {remove.isPending ? 'Deleting…' : 'Delete'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    Delete event
                  </Button>
                )}
              </div>
            ) : null}
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
