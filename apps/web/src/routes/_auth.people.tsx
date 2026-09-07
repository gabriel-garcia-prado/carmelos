import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useApiClient } from '@/components/api-client-provider'
import { OwnerOnly } from '@/components/owner-only'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'

type PersonForm = Readonly<{
  name: string
  phone: string
  isPizzaiolo: boolean
  canDrive: boolean
  canDriveTrailer: boolean
  rackRateOverridePer30Min: string
  minutesBeforeDepartureOverride: string
  homeBaseAddress: string
}>

const EMPTY_PERSON: PersonForm = {
  name: '',
  phone: '',
  isPizzaiolo: false,
  canDrive: false,
  canDriveTrailer: false,
  rackRateOverridePer30Min: '',
  minutesBeforeDepartureOverride: '',
  homeBaseAddress: ''
}

const CAPABILITIES = [
  ['isPizzaiolo', 'Pizzaiolo', 'Can run a rig, not just crew it.'],
  ['canDrive', 'Can drive', 'Cleared to take a truck out.'],
  ['canDriveTrailer', 'Can tow a trailer', 'Cleared for the trailer-oven trucks.']
] as const

const People = () => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const [drawer, setDrawer] = useState<Readonly<{ id: string | null }> | null>(null)
  const [form, setForm] = useState<PersonForm>(EMPTY_PERSON)
  const [error, setError] = useState<string | null>(null)

  const people = useQuery({
    queryKey: ['people'],
    queryFn: async () => {
      const response = await client.api.people.$get()
      if (!response.ok) throw new Error('Failed to load people')
      return response.json()
    }
  })

  const save = useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: PersonForm }) => {
      const optionalNumber = (raw: string) => (raw.trim() === '' ? null : Number(raw))
      const json = {
        name: values.name.trim(),
        phone: values.phone.trim(),
        isPizzaiolo: values.isPizzaiolo,
        canDrive: values.canDrive,
        canDriveTrailer: values.canDriveTrailer,
        rackRateOverridePer30Min: optionalNumber(values.rackRateOverridePer30Min),
        minutesBeforeDepartureOverride: optionalNumber(values.minutesBeforeDepartureOverride),
        homeBaseAddress: values.homeBaseAddress.trim() === '' ? null : values.homeBaseAddress.trim()
      }
      const response = id
        ? await client.api.people[':id'].$patch({ param: { id }, json })
        : await client.api.people.$post({ json })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
      return response.json()
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['people'] })
      setDrawer(null)
    },
    onError: (mutationError: Error) => setError(mutationError.message)
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await client.api.people[':id'].$delete({ param: { id } })
      if (!response.ok) {
        const body = (await response.json()) as { message: string }
        throw new Error(body.message)
      }
    },
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['people'] })
      setDrawer(null)
    },
    onError: (mutationError: Error) => setError(mutationError.message)
  })

  if (people.isPending) return <Skeleton className="mx-auto h-96 w-full max-w-xl" />
  if (people.isError) return <p className="p-5 text-destructive">Couldn't load people.</p>

  const openPerson = (id: string) => {
    const person = people.data.find((candidate) => candidate.id === id)
    if (!person) return
    setForm({
      name: person.name,
      phone: person.phone ?? '',
      isPizzaiolo: person.isPizzaiolo,
      canDrive: person.canDrive,
      canDriveTrailer: person.canDriveTrailer,
      rackRateOverridePer30Min: person.rackRateOverridePer30Min === null ? '' : String(person.rackRateOverridePer30Min),
      minutesBeforeDepartureOverride:
        person.minutesBeforeDepartureOverride === null ? '' : String(person.minutesBeforeDepartureOverride),
      homeBaseAddress: person.homeBaseAddress ?? ''
    })
    setError(null)
    setDrawer({ id })
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-5">
      <h1 className="text-2xl font-semibold">People</h1>
      <p className="text-sm text-muted-foreground">
        Everyone in the pool is crew-capable. The badges mark who can also run a rig, drive, or tow.
      </p>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Crew</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setForm(EMPTY_PERSON)
              setError(null)
              setDrawer({ id: null })
            }}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </CardHeader>
        <CardContent className="divide-y pt-0">
          {people.data.map((person) => (
            <div key={person.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{person.name}</span>
                  {person.isPizzaiolo ? <Badge>Pizzaiolo</Badge> : null}
                  {person.canDrive ? <Badge variant="secondary">Driver</Badge> : null}
                  {person.canDriveTrailer ? <Badge variant="secondary">Trailer</Badge> : null}
                </div>
                <p className="font-mono text-xs text-muted-foreground">{person.phone}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => openPerson(person.id)}>
                <Pencil className="mr-1 h-3 w-3" />
                Edit
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Sheet open={drawer !== null} onOpenChange={(open) => !open && setDrawer(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          {drawer ? (
            <form
              className="space-y-4 pt-6"
              onSubmit={(event) => {
                event.preventDefault()
                save.mutate({ id: drawer.id, values: form })
              }}
            >
              <h2 className="text-lg font-semibold">{drawer.id ? 'Edit person' : 'Add someone'}</h2>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="person-name">Name</Label>
                  <Input
                    id="person-name"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="person-phone">Phone</Label>
                  <Input
                    id="person-phone"
                    required
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </div>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">What they can do</legend>
                {CAPABILITIES.map(([key, label, hint]) => (
                  <div key={key} className="flex items-start gap-2">
                    <Checkbox
                      id={key}
                      className="mt-0.5"
                      checked={form[key]}
                      onCheckedChange={(checked) => setForm({ ...form, [key]: checked === true })}
                    />
                    <div>
                      <Label htmlFor={key} className="font-normal">
                        {label}
                      </Label>
                      <p className="text-xs text-muted-foreground">{hint}</p>
                    </div>
                  </div>
                ))}
              </fieldset>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="person-rack">Rack rate override</Label>
                  <Input
                    id="person-rack"
                    type="number"
                    min="1"
                    placeholder="default"
                    value={form.rackRateOverridePer30Min}
                    onChange={(e) => setForm({ ...form, rackRateOverridePer30Min: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Pizzas per 30 min. Blank uses the shop default.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="person-lead">Lead time override</Label>
                  <Input
                    id="person-lead"
                    type="number"
                    min="0"
                    placeholder="default"
                    value={form.minutesBeforeDepartureOverride}
                    onChange={(e) => setForm({ ...form, minutesBeforeDepartureOverride: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">Minutes before departure they're due in.</p>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="person-home">Home base address</Label>
                <Input
                  id="person-home"
                  value={form.homeBaseAddress}
                  onChange={(e) => setForm({ ...form, homeBaseAddress: e.target.value })}
                />
              </div>

              {error ? (
                <p className="border-l-2 border-bad bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">
                  {error}
                </p>
              ) : null}

              <Button type="submit" className="w-full" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>

              {drawer.id ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={remove.isPending}
                  onClick={() => drawer.id && remove.mutate(drawer.id)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Remove person
                </Button>
              ) : null}
            </form>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

const GuardedPeople = () => (
  <OwnerOnly>
    <People />
  </OwnerOnly>
)

export const Route = createFileRoute('/_auth/people')({ component: GuardedPeople })
