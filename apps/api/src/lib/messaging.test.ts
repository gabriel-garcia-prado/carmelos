import { describe, expect, test } from 'bun:test'
import { composeEventMessage, composeFireDutyNote } from './messaging'

const time = (hours: number, minutes = 0) => new Date(2026, 7, 8, hours, minutes)

describe('composeEventMessage', () => {
  test('includes the fire note only when lighting', () => {
    const message = composeEventMessage({
      role: 'pizzaiolo',
      arrivalTime: time(9),
      isLightingFire: true,
      fireReadyTime: time(13),
      coworkerName: 'Leonardo',
      coworkerPhone: '917 434-9619',
      event: {
        rigLabel: 'Small Caddy',
        firstPizzaTime: time(13),
        headcount: 50,
        address: '20 Beechwood Rd',
        leaveTime: time(11, 30),
        driveMinutes: 30,
        specialRequests: [
          { requestType: 'gluten_free', headcount: 2 },
          { requestType: 'no_pork', headcount: 4 }
        ]
      }
    })

    expect(message).toContain('light the fire')
    expect(message).toContain('Gluten free ×2')
    expect(message).toContain('No pork ×4')
    expect(message).toContain('With Leonardo (917 434-9619)')
    expect(message).toContain('Reply Y to confirm')
  })

  test('omits the fire note and the requests line when neither applies', () => {
    const message = composeEventMessage({
      role: 'crew',
      arrivalTime: time(11, 15),
      isLightingFire: false,
      fireReadyTime: null,
      coworkerName: 'Kurt',
      coworkerPhone: '973 525-7887',
      event: {
        rigLabel: 'Small Caddy',
        firstPizzaTime: time(13),
        headcount: 50,
        address: '20 Beechwood Rd',
        leaveTime: time(11, 30),
        driveMinutes: 30,
        specialRequests: []
      }
    })

    expect(message).not.toContain('light the fire')
    expect(message.split('\n')).toHaveLength(5)
  })
})

describe('composeFireDutyNote', () => {
  test('names the covered rig, lighting time, and handover time', () => {
    const note = composeFireDutyNote({ coveredRigLabel: 'Big Caddy', litAt: time(8, 30), handoverTime: time(10, 35) })

    expect(note).toBe("Also: light Big Caddy's fire at 8:30 AM, hand off by 10:35 AM when their crew arrives")
  })
})
