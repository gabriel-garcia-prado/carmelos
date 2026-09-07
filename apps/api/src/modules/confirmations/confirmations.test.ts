import { describe, expect, mock, test } from 'bun:test'
import { okAsync } from 'neverthrow'
import type { MockDependencies } from '#test'
import type { Confirmation } from './confirmations'
import { listConfirmationsForDate, updateConfirmationStatus } from './confirmations'

const CONFIRMATION: Confirmation = {
  id: 'c1',
  eventId: 'e1',
  personId: 'kurt',
  role: 'pizzaiolo',
  messageBody: 'In 9:00...',
  status: 'pending',
  sentAt: null,
  confirmedAt: null
}

describe('listConfirmationsForDate', () => {
  test('returns whatever the store has for that date', async () => {
    const dependencies: MockDependencies<typeof listConfirmationsForDate> = (overrides) => ({
      fetchConfirmationsForDate: mock(() => okAsync([CONFIRMATION])),
      ...overrides
    })

    const result = await listConfirmationsForDate(dependencies())('2026-08-08')

    expect(result._unsafeUnwrap()).toEqual([CONFIRMATION])
  })
})

describe('updateConfirmationStatus', () => {
  test('saves the new status', async () => {
    const dependencies: MockDependencies<typeof updateConfirmationStatus> = (overrides) => ({
      saveStatus: mock(() => okAsync({ ...CONFIRMATION, status: 'confirmed' as const })),
      ...overrides
    })
    const deps = dependencies()

    const result = await updateConfirmationStatus(deps)({ id: 'c1', status: 'confirmed' })

    expect(deps.saveStatus).toHaveBeenCalledWith('c1', 'confirmed')
    expect(result._unsafeUnwrap().status).toBe('confirmed')
  })
})
