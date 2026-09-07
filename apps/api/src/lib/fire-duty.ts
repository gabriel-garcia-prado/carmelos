import { diffMinutes } from './time'

export type RigFireInput = Readonly<{
  rigId: string
  naturalFireLitTime: Date
  leaveTime: Date
  minutesBeforeDeparture: number
  defaultOpenerPersonId: string
  // The rig's other person. Whoever of the two ends up lighting this fire is
  // at the shop from then until this truck leaves, so either one can go on to
  // cover a later rig — which is the entire point of the pool.
  crewMemberId: string
  // Pins who lights this rig's fire (spec §8: every derived assignment stays
  // overridable). The rig stops being optimised, but a pinned opener who
  // belongs to this rig still joins the pool for the rigs that follow.
  overridePersonId: string | null
}>

export type RigFireResult = Readonly<{
  rigId: string
  litAt: Date
  litByPersonId: string
  isCovered: boolean
  // When this rig's own pizzaiolo needs to physically be there: the lighting
  // moment if they're lighting it themselves, or the handover moment if
  // someone else covered it and they just arrive to take the truck.
  ownArrivalTime: Date
}>

/**
 * Per-day, per-rig fire-lighting assignment (spec §4). A rig lights its own
 * fire unless someone already committed to being at the shop earlier can
 * reach it without a second trip: their presence window — from their own
 * arrival until they leave with their own rig — has to extend at least to
 * the covered rig's handover moment (`leave − minutesBeforeDeparture`, the
 * point its own crew shows up and cover ends; no overlap required, arriving
 * as the coverer leaves is fine).
 *
 * A covered rig's fire is lit at ITS OWN natural time by default — the
 * coverer is present anyway, so there's no reason to light it early and burn
 * extra wood. Only when the covered rig's natural time falls within
 * `windowMinutes` of the coverer's own lighting moment does it get bundled
 * into that single earlier moment instead (spec §4: "fires falling close
 * together are lit together... burning a little longer, which costs wood and
 * nothing else"). This is what makes the reference Saturday's Small
 * Caddy(9:00)/Big Caddy(9:45) — 45 minutes apart — light separately while
 * Tuesday's three fires 20-30 minutes apart all light at once.
 *
 * Rigs are processed earliest-natural-time first, and whoever ends up lighting
 * a rig's fire joins the pool of people later rigs can be covered by — this is
 * what lets one early arrival cover two or three rigs in one trip. That
 * includes a PINNED opener: once someone is standing at the shop at 9:00 for
 * one rig, a rig firing at 9:45 defaults to them too, rather than paying a
 * second person to come in and light an oven three feet away.
 */
export const assignFireDuty = (rigs: readonly RigFireInput[], windowMinutes: number): readonly RigFireResult[] => {
  const ordered = [...rigs].sort((a, b) => a.naturalFireLitTime.getTime() - b.naturalFireLitTime.getTime())

  type Opener = Readonly<{ personId: string; lightingTime: Date; leaveTime: Date }>
  const openers: Opener[] = []
  const results = new Map<string, RigFireResult>()

  for (const rig of ordered) {
    const handoverMoment = new Date(rig.leaveTime.getTime() - rig.minutesBeforeDeparture * 60_000)

    if (rig.overridePersonId !== null) {
      // An override naming someone OTHER than this rig's own opener is cover
      // in every sense that matters — so it reports as covered, and the rig's
      // own pizzaiolo turns up for the handover rather than for the lighting.
      const litByPersonId = rig.overridePersonId
      const isCovered = litByPersonId !== rig.defaultOpenerPersonId
      results.set(rig.rigId, {
        rigId: rig.rigId,
        litAt: rig.naturalFireLitTime,
        litByPersonId,
        isCovered,
        ownArrivalTime: isCovered ? handoverMoment : rig.naturalFireLitTime
      })
      // A pinned opener from this rig's own pair is at the shop from the fire
      // until this truck leaves, exactly like a rig that self-lights — so the
      // later rigs get to be covered by them instead of dragging a second
      // person in early for a fire someone is already standing next to.
      if (litByPersonId === rig.defaultOpenerPersonId || litByPersonId === rig.crewMemberId) {
        openers.push({ personId: litByPersonId, lightingTime: rig.naturalFireLitTime, leaveTime: rig.leaveTime })
      }
      continue
    }

    const coverer = openers.find((opener) => opener.leaveTime.getTime() >= handoverMoment.getTime())

    if (coverer) {
      const withinWindow = Math.abs(diffMinutes(rig.naturalFireLitTime, coverer.lightingTime)) <= windowMinutes
      results.set(rig.rigId, {
        rigId: rig.rigId,
        litAt: withinWindow ? coverer.lightingTime : rig.naturalFireLitTime,
        litByPersonId: coverer.personId,
        isCovered: true,
        ownArrivalTime: handoverMoment
      })
    } else {
      openers.push({
        personId: rig.defaultOpenerPersonId,
        lightingTime: rig.naturalFireLitTime,
        leaveTime: rig.leaveTime
      })
      results.set(rig.rigId, {
        rigId: rig.rigId,
        litAt: rig.naturalFireLitTime,
        litByPersonId: rig.defaultOpenerPersonId,
        isCovered: false,
        ownArrivalTime: rig.naturalFireLitTime
      })
    }
  }

  return rigs.map((rig) => results.get(rig.rigId) as RigFireResult)
}
