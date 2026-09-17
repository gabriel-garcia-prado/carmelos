import { formatClockTime } from './time'

export const REQUEST_LABELS: Readonly<Record<string, string>> = {
  gluten_free: 'Gluten free',
  halal: 'Halal',
  no_pork: 'No pork',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  dairy_free: 'Dairy free',
  paneer: 'Paneer',
  spicy: 'Spicy'
}

export type SpecialRequestSummary = Readonly<{ requestType: string; headcount: number }>

export type MessageEventContext = Readonly<{
  rigLabel: string
  firstPizzaTime: Date
  headcount: number
  address: string
  leaveTime: Date
  driveMinutes: number
  specialRequests: readonly SpecialRequestSummary[]
}>

export type MessageRole = 'pizzaiolo' | 'crew' | 'cutter'

export type Coworker = Readonly<{ name: string; phone: string }>

export type PersonMessageInput = Readonly<{
  role: MessageRole
  arrivalTime: Date
  isLightingFire: boolean
  fireReadyTime: Date | null
  /** They're making their own way to the site rather than riding out with the rig. */
  meetsOnSite: boolean
  /** Everyone else on this party — a stick and any cutters, or none of either. */
  coworkers: readonly Coworker[]
  event: MessageEventContext
}>

const formatCoworkers = (coworkers: readonly Coworker[]): string | null => {
  if (coworkers.length === 0) return null
  const listed = coworkers.map((coworker) => `${coworker.name} (${coworker.phone})`)
  const last = listed.pop() as string
  return listed.length === 0 ? `With ${last}` : `With ${listed.join(', ')} and ${last}`
}

const formatRequests = (requests: readonly SpecialRequestSummary[]): string | null => {
  if (requests.length === 0) return null
  return requests
    .map((request) => `${REQUEST_LABELS[request.requestType] ?? request.requestType} ×${request.headcount}`)
    .join(' · ')
}

/** The exact personal text a person gets for one event (spec §10): arrive, fire duty, leave, address, first pizza, requests, coworker. */
export const composeEventMessage = (input: PersonMessageInput): string => {
  const lines: string[] = []

  lines.push(
    input.meetsOnSite
      ? `${input.event.rigLabel} — meet us at ${input.event.address}, ${formatClockTime(input.arrivalTime)} for set-up`
      : input.isLightingFire && input.fireReadyTime
        ? `${input.event.rigLabel} — in ${formatClockTime(input.arrivalTime)}, light the fire (ready ${formatClockTime(input.fireReadyTime)})`
        : `${input.event.rigLabel} — in ${formatClockTime(input.arrivalTime)}`
  )
  // Someone making their own way isn't on the truck's journey, so the shop
  // departure and the drive aren't theirs to act on — where and when to be is
  // already in the line above, and repeating an address they're driving to
  // themselves as somewhere the truck is heading only muddies it.
  if (!input.meetsOnSite) {
    lines.push(
      `Leave ${formatClockTime(input.event.leaveTime)} · ${input.event.driveMinutes}m to ${input.event.address}`
    )
  }
  lines.push(`First pizza ${formatClockTime(input.event.firstPizzaTime)} · ${input.event.headcount} people`)

  const requests = formatRequests(input.event.specialRequests)
  if (requests) lines.push(requests)

  const coworkers = formatCoworkers(input.coworkers)
  if (coworkers) lines.push(coworkers)
  lines.push('Reply Y to confirm')

  return lines.join('\n')
}

export type FireDutyNoteInput = Readonly<{
  coveredRigLabel: string
  litAt: Date
  handoverTime: Date
}>

/** The extra line for someone covering another rig's fire — lives on their own message, not inside the covered rig's text (spec §11). */
export const composeFireDutyNote = (input: FireDutyNoteInput): string =>
  `Also: light ${input.coveredRigLabel}'s fire at ${formatClockTime(input.litAt)}, hand off by ${formatClockTime(input.handoverTime)} when their crew arrives`
