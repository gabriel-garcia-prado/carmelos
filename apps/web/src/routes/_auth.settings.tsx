import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useApiClient } from '@/components/api-client-provider'
import { OwnerOnly } from '@/components/owner-only'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'

const FIELDS = [
  { key: 'ovenToTempMinutes', label: 'Oven to temperature (min)', group: 'Kitchen / shop' },
  { key: 'fireBeforeLoadMinutes', label: 'Fire before loading (min)', group: 'Kitchen / shop' },
  { key: 'sparePizzasPerEvent', label: 'Spare pizzas per event', group: 'Kitchen / shop' },
  { key: 'cheeseBagsPerDough', label: 'Dough per cheese bag', group: 'Kitchen / shop' },
  { key: 'saucePerPizzas', label: 'Pizzas per sauce unit', group: 'Kitchen / shop' },
  { key: 'traySize', label: 'Tray size (dough)', group: 'Kitchen / shop' },
  { key: 'setupAimedMinutes', label: 'Set up — aimed (min)', group: 'Rig' },
  { key: 'setupFloorMinutes', label: 'Set up — floor (min)', group: 'Rig' },
  { key: 'breakDownMinutes', label: 'Break down (min)', group: 'Rig' },
  { key: 'defaultRackRatePer30Min', label: 'Rack rate (pizzas / 30 min)', group: 'Crew' },
  { key: 'defaultMinutesBeforeDeparture', label: 'Minutes before departure', group: 'Crew' },
  { key: 'fireGroupingWindowMinutes', label: 'Fire grouping window (min)', group: 'Global' },
  { key: 'spareFoldThresholdMinutes', label: 'Fold spare into drive under (min)', group: 'Global' }
] as const

type SettingsKey = (typeof FIELDS)[number]['key']
type SettingsForm = Record<SettingsKey, string> & { kitchenAddress: string }

type TruckForm = Readonly<{
  name: string
  shortName: string
  ovenMount: 'trailer' | 'built_in'
  rangeMiles: string
  comfort: string
  notes: string
}>

const EMPTY_TRUCK: TruckForm = {
  name: '',
  shortName: '',
  ovenMount: 'trailer',
  rangeMiles: '100',
  comfort: '3',
  notes: ''
}

/** A read-only row — label on the left, current value on the right. */
const Row = ({ label, value }: Readonly<{ label: string; value: string }>) => (
  <div className="flex items-baseline justify-between gap-3 py-1.5">
    <span className="text-sm text-muted-foreground">{label}</span>
    <span className="font-mono text-sm font-medium">{value}</span>
  </div>
)

/** Every section reads the same: title, an Edit affordance, and values you
 * can't fat-finger by scrolling past a focused number input. */
const Section = ({
  title,
  onEdit,
  action,
  children
}: Readonly<{ title: string; onEdit?: () => void; action?: React.ReactNode; children: React.ReactNode }>) => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between space-y-0">
      <CardTitle className="text-base">{title}</CardTitle>
      {action ??
        (onEdit ? (
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="mr-1 h-3 w-3" />
            Edit
          </Button>
        ) : null)}
    </CardHeader>
    <CardContent className="divide-y pt-0">{children}</CardContent>
  </Card>
)

type Drawer =
  | Readonly<{ kind: 'settings'; group: string }>
  | Readonly<{ kind: 'truck'; id: string }>
  | Readonly<{ kind: 'new-truck' }>

const Settings = () => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const [drawer, setDrawer] = useState<Drawer | null>(null)
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [truckForm, setTruckForm] = useState<TruckForm>(EMPTY_TRUCK)
  const [error, setError] = useState<string | null>(null)

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

  const saveSettings = useMutation({
    mutationFn: async (next: SettingsForm) => {
      const payload = {
        ...Object.fromEntries(FIELDS.map((field) => [field.key, Number(next[field.key])])),
        kitchenAddress: next.kitchenAddress.trim() === '' ? null : next.kitchenAddress.trim()
      }
      const response = await client.api.settings.$put({ json: payload as never })
      if (!response.ok) throw new Error('Failed to save settings')
      return response.json()
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
      setDrawer(null)
    }
  })

  const saveTruck = useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: TruckForm }) => {
      const json = {
        name: values.name.trim(),
        shortName: values.shortName.trim() === '' ? null : values.shortName.trim(),
        ovenMount: values.ovenMount,
        rangeMiles: Number(values.rangeMiles),
        comfort: Number(values.comfort),
        notes: values.notes.trim() === '' ? null : values.notes.trim()
      }
      const response = id
        ? await client.api.trucks[':id'].$patch({ param: { id }, json })
        : await client.api.trucks.$post({ json })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
      return response.json()
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['trucks'] })
      setDrawer(null)
    },
    onError: (mutationError: Error) => setError(mutationError.message)
  })

  const removeTruck = useMutation({
    mutationFn: async (id: string) => {
      const response = await client.api.trucks[':id'].$delete({ param: { id } })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['trucks'] })
      setDrawer(null)
    },
    onError: (mutationError: Error) => setError(mutationError.message)
  })

  if (settings.isPending || trucks.isPending) return <Skeleton className="mx-auto h-96 w-full max-w-xl" />
  if (settings.isError || trucks.isError) return <p className="p-5 text-destructive">Couldn't load settings.</p>

  const current = settings.data
  const groups = Array.from(new Set(FIELDS.map((field) => field.group)))

  const openSettings = (group: string) => {
    setForm({
      ...(Object.fromEntries(FIELDS.map((field) => [field.key, String(current[field.key])])) as Record<
        SettingsKey,
        string
      >),
      kitchenAddress: current.kitchenAddress ?? ''
    })
    setDrawer({ kind: 'settings', group })
  }

  const openTruck = (id: string) => {
    const truck = trucks.data.find((candidate) => candidate.id === id)
    if (!truck) return
    setTruckForm({
      name: truck.name,
      shortName: truck.shortName ?? '',
      ovenMount: truck.ovenMount,
      rangeMiles: String(truck.rangeMiles),
      comfort: String(truck.comfort),
      notes: truck.notes ?? ''
    })
    setError(null)
    setDrawer({ kind: 'truck', id })
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-5">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="text-sm text-muted-foreground">
        Every constant here is a default — Billy can still override any of them on a single event.
      </p>

      <Section
        title="Trucks"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setTruckForm(EMPTY_TRUCK)
              setError(null)
              setDrawer({ kind: 'new-truck' })
            }}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        }
      >
        {trucks.data.map((truck) => (
          <div key={truck.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{truck.name}</span>
                {truck.shortName ? <Badge variant="secondary">{truck.shortName}</Badge> : null}
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                {truck.ovenMount === 'trailer' ? 'trailer' : 'built-in'} oven · {truck.rangeMiles}mi · comfort{' '}
                {truck.comfort}/5
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => openTruck(truck.id)}>
              <Pencil className="mr-1 h-3 w-3" />
              Edit
            </Button>
          </div>
        ))}
      </Section>

      {groups.map((group) => (
        <Section key={group} title={group} onEdit={() => openSettings(group)}>
          {group === 'Kitchen / shop' ? (
            <Row label="Shop / kitchen address" value={current.kitchenAddress ?? '—'} />
          ) : null}
          {FIELDS.filter((field) => field.group === group).map((field) => (
            <Row key={field.key} label={field.label} value={String(current[field.key])} />
          ))}
        </Section>
      ))}

      <Sheet open={drawer !== null} onOpenChange={(open) => !open && setDrawer(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {drawer?.kind === 'settings' && form ? (
            <form
              className="space-y-4 pt-6"
              onSubmit={(event) => {
                event.preventDefault()
                saveSettings.mutate(form)
              }}
            >
              <h2 className="text-lg font-semibold">{drawer.group}</h2>
              {drawer.group === 'Kitchen / shop' ? (
                <div className="space-y-1">
                  <Label htmlFor="kitchenAddress">Shop / kitchen address</Label>
                  <Input
                    id="kitchenAddress"
                    placeholder="500 Morris Ave, Springfield, NJ"
                    value={form.kitchenAddress}
                    onChange={(e) => setForm({ ...form, kitchenAddress: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Used to auto-calculate drive time. Leave blank to keep entering drive times by hand.
                  </p>
                </div>
              ) : null}
              {FIELDS.filter((field) => field.group === drawer.group).map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={field.key}>{field.label}</Label>
                  <Input
                    id={field.key}
                    type="number"
                    min="0"
                    required
                    value={form[field.key]}
                    onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                  />
                </div>
              ))}
              <Button type="submit" className="w-full" disabled={saveSettings.isPending}>
                {saveSettings.isPending ? 'Saving…' : 'Save'}
              </Button>
            </form>
          ) : drawer?.kind === 'truck' || drawer?.kind === 'new-truck' ? (
            <form
              className="space-y-4 pt-6"
              onSubmit={(event) => {
                event.preventDefault()
                saveTruck.mutate({ id: drawer.kind === 'truck' ? drawer.id : null, values: truckForm })
              }}
            >
              <h2 className="text-lg font-semibold">{drawer.kind === 'truck' ? 'Edit truck' : 'Add a truck'}</h2>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="truck-name">Name</Label>
                  <Input
                    id="truck-name"
                    required
                    value={truckForm.name}
                    onChange={(e) => setTruckForm({ ...truckForm, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="truck-short">Abbreviation</Label>
                  <Input
                    id="truck-short"
                    maxLength={8}
                    placeholder="S·CAD"
                    value={truckForm.shortName}
                    onChange={(e) => setTruckForm({ ...truckForm, shortName: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Shown when a lane is squeezed to a sliver.</p>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="truck-oven">Oven</Label>
                <Select
                  value={truckForm.ovenMount}
                  onValueChange={(value) => setTruckForm({ ...truckForm, ovenMount: value as 'trailer' | 'built_in' })}
                >
                  <SelectTrigger id="truck-oven">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trailer">Trailer — towed, needs a trailer-cleared driver</SelectItem>
                    <SelectItem value="built_in">Built in — rides in the vehicle</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="truck-range">Range (mi)</Label>
                  <Input
                    id="truck-range"
                    type="number"
                    min="1"
                    required
                    value={truckForm.rangeMiles}
                    onChange={(e) => setTruckForm({ ...truckForm, rangeMiles: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="truck-comfort">Comfort (1–5)</Label>
                  <Input
                    id="truck-comfort"
                    type="number"
                    min="1"
                    max="5"
                    required
                    value={truckForm.comfort}
                    onChange={(e) => setTruckForm({ ...truckForm, comfort: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="truck-notes">Notes</Label>
                <Input
                  id="truck-notes"
                  value={truckForm.notes}
                  onChange={(e) => setTruckForm({ ...truckForm, notes: e.target.value })}
                />
              </div>

              {error ? (
                <p className="border-l-2 border-bad bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
                  {error}
                </p>
              ) : null}

              <Button type="submit" className="w-full" disabled={saveTruck.isPending}>
                {saveTruck.isPending ? 'Saving…' : 'Save truck'}
              </Button>

              {drawer.kind === 'truck' ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={removeTruck.isPending}
                  onClick={() => removeTruck.mutate(drawer.id)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Remove truck
                </Button>
              ) : null}
            </form>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

const GuardedSettings = () => (
  <OwnerOnly>
    <Settings />
  </OwnerOnly>
)

export const Route = createFileRoute('/_auth/settings')({ component: GuardedSettings })
