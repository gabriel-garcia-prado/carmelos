import { describe, expect, test } from 'bun:test'
import type { RigFireInput } from './fire-duty'
import { assignFireDuty } from './fire-duty'

const time = (hours: number, minutes = 0) => new Date(2026, 7, 11, hours, minutes)

// Matches the seeded default (spec §4: "twenty or thirty minutes apart is
// not a gap worth a second trip").
const WINDOW = 30

describe('assignFireDuty — reference Tuesday: one person lights three ovens', () => {
  const rigs: RigFireInput[] = [
    {
      rigId: 'small_caddy',
      naturalFireLitTime: time(8, 30),
      leaveTime: time(11, 0),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'kurt',
      crewMemberId: 'leo',
      overridePersonId: null
    },
    {
      rigId: 'big_caddy',
      naturalFireLitTime: time(8, 50),
      leaveTime: time(10, 50),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'gabriel',
      crewMemberId: 'matt',
      overridePersonId: null
    },
    {
      rigId: 'pickup',
      naturalFireLitTime: time(9, 0),
      leaveTime: time(11, 15),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'ej',
      crewMemberId: 'john',
      overridePersonId: null
    }
  ]

  test('close together (within the window): Kurt lights all three at his own arrival time', () => {
    const results = assignFireDuty(rigs, WINDOW)
    const byRig = Object.fromEntries(results.map((result) => [result.rigId, result]))

    expect(byRig.small_caddy).toMatchObject({ litByPersonId: 'kurt', isCovered: false, litAt: time(8, 30) })
    expect(byRig.big_caddy).toMatchObject({ litByPersonId: 'kurt', isCovered: true, litAt: time(8, 30) })
    expect(byRig.big_caddy?.ownArrivalTime).toEqual(time(10, 35))
    expect(byRig.pickup).toMatchObject({ litByPersonId: 'kurt', isCovered: true, litAt: time(8, 30) })
    // No overlap required: arriving exactly as the coverer leaves is fine.
    expect(byRig.pickup?.ownArrivalTime).toEqual(time(11, 0))
  })
})

describe('assignFireDuty — reference Saturday: covered, but too far apart to bundle', () => {
  const rigs: RigFireInput[] = [
    {
      rigId: 'small_caddy',
      naturalFireLitTime: time(9, 0),
      leaveTime: time(11, 30),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'kurt',
      crewMemberId: 'leo',
      overridePersonId: null
    },
    {
      rigId: 'big_caddy',
      naturalFireLitTime: time(9, 45),
      leaveTime: time(11, 45),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'gabriel',
      crewMemberId: 'matt',
      overridePersonId: null
    }
  ]

  test('45 minutes apart: Kurt still covers it, but lights it at its own later time', () => {
    const results = assignFireDuty(rigs, WINDOW)
    const bigCaddy = results.find((result) => result.rigId === 'big_caddy')

    // Covered (Kurt's presence window reaches the handover moment)...
    expect(bigCaddy).toMatchObject({ litByPersonId: 'kurt', isCovered: true })
    // ...but not bundled into Kurt's 9:00 — lit at Big Caddy's own 9:45,
    // matching the spec's own reference day exactly.
    expect(bigCaddy?.litAt).toEqual(time(9, 45))
    // Gabriel and Matt arrive together at the handover moment either way.
    expect(bigCaddy?.ownArrivalTime).toEqual(time(11, 30))
  })
})

describe('assignFireDuty — reference Wednesday: the cover doesn’t reach', () => {
  const rigs: RigFireInput[] = [
    {
      rigId: 'small_caddy',
      naturalFireLitTime: time(8, 0),
      leaveTime: time(10, 35),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'kurt',
      crewMemberId: 'leo',
      overridePersonId: null
    },
    {
      rigId: 'big_caddy',
      naturalFireLitTime: time(11, 15),
      leaveTime: time(13, 15),
      minutesBeforeDeparture: 15,
      defaultOpenerPersonId: 'gabriel',
      crewMemberId: 'matt',
      overridePersonId: null
    }
  ]

  test('Kurt leaves before the handover moment, so the Big Caddy lights its own', () => {
    const results = assignFireDuty(rigs, WINDOW)
    const bigCaddy = results.find((result) => result.rigId === 'big_caddy')

    expect(bigCaddy).toMatchObject({ litByPersonId: 'gabriel', isCovered: false, litAt: time(11, 15) })
    expect(bigCaddy?.ownArrivalTime).toEqual(time(11, 15))
  })
})

describe('assignFireDuty — override', () => {
  test('a pinned rig is isolated from the optimizer entirely', () => {
    const rigs: RigFireInput[] = [
      {
        rigId: 'small_caddy',
        naturalFireLitTime: time(8, 0),
        leaveTime: time(11, 0),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'kurt',
        crewMemberId: 'leo',
        overridePersonId: null
      },
      {
        rigId: 'big_caddy',
        naturalFireLitTime: time(8, 10),
        leaveTime: time(10, 0),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'gabriel',
        crewMemberId: 'matt',
        overridePersonId: 'matt'
      }
    ]

    const results = assignFireDuty(rigs, WINDOW)
    const bigCaddy = results.find((result) => result.rigId === 'big_caddy')

    // Pinned to Matt at its OWN natural time — not bundled into Small Caddy's
    // 8:00 the way the optimizer would have. And since Matt isn't Big Caddy's
    // own opener, this counts as covered: Gabriel comes in for the handover
    // (10:00 leave − 15) rather than for a fire someone else is lighting.
    expect(bigCaddy).toMatchObject({
      litByPersonId: 'matt',
      isCovered: true,
      litAt: time(8, 10),
      ownArrivalTime: time(9, 45)
    })
  })

  test('pinning a rig to its own opener is not cover — they still light it themselves', () => {
    const rigs: RigFireInput[] = [
      {
        rigId: 'small_caddy',
        naturalFireLitTime: time(8, 0),
        leaveTime: time(11, 0),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'kurt',
        crewMemberId: 'leo',
        overridePersonId: null
      },
      {
        rigId: 'big_caddy',
        naturalFireLitTime: time(8, 10),
        leaveTime: time(10, 0),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'gabriel',
        crewMemberId: 'matt',
        overridePersonId: 'gabriel'
      }
    ]

    const results = assignFireDuty(rigs, WINDOW)

    expect(results.find((result) => result.rigId === 'big_caddy')).toMatchObject({
      litByPersonId: 'gabriel',
      isCovered: false,
      ownArrivalTime: time(8, 10)
    })
  })

  test('a pinned opener covers the rigs that follow — nobody else comes in early', () => {
    const rigs: RigFireInput[] = [
      {
        rigId: 'small_caddy',
        naturalFireLitTime: time(9, 0),
        leaveTime: time(11, 30),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'kurt',
        crewMemberId: 'leo',
        // Leo, the crew member, is holding the match on this one.
        overridePersonId: 'leo'
      },
      {
        rigId: 'big_caddy',
        naturalFireLitTime: time(9, 45),
        leaveTime: time(11, 45),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'gabriel',
        crewMemberId: 'matt',
        overridePersonId: null
      }
    ]

    const results = assignFireDuty(rigs, WINDOW)
    const byRig = Object.fromEntries(results.map((result) => [result.rigId, result]))

    // Leo is at the shop from 9:00 until Small Caddy pulls out at 11:30, which
    // reaches Big Caddy's 11:30 handover — so he lights that one too rather
    // than Gabriel making a second trip in for it.
    expect(byRig.big_caddy).toMatchObject({ litByPersonId: 'leo', isCovered: true })
    // Its own natural time, not bundled: 45 minutes is outside the window.
    expect(byRig.big_caddy?.litAt).toEqual(time(9, 45))
    // Gabriel just turns up for the truck.
    expect(byRig.big_caddy?.ownArrivalTime).toEqual(time(11, 30))
  })

  test('a pinned opener borrowed from ANOTHER rig does not become a coverer', () => {
    const rigs: RigFireInput[] = [
      {
        rigId: 'small_caddy',
        naturalFireLitTime: time(9, 0),
        leaveTime: time(11, 30),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'kurt',
        crewMemberId: 'leo',
        // Nick is on neither rig, so his presence isn't this rig's to promise.
        overridePersonId: 'nick'
      },
      {
        rigId: 'big_caddy',
        naturalFireLitTime: time(9, 45),
        leaveTime: time(11, 45),
        minutesBeforeDeparture: 15,
        defaultOpenerPersonId: 'gabriel',
        crewMemberId: 'matt',
        overridePersonId: null
      }
    ]

    const results = assignFireDuty(rigs, WINDOW)

    expect(results.find((result) => result.rigId === 'big_caddy')).toMatchObject({
      litByPersonId: 'gabriel',
      isCovered: false
    })
  })
})
