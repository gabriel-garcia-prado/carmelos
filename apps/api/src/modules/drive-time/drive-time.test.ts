import { describe, expect, mock, test } from 'bun:test'
import { errAsync, okAsync } from 'neverthrow'
import type { MockDependencies, MockInput } from '#test'
import { getDriveMinutes } from './drive-time'

const input: MockInput<typeof getDriveMinutes> = (overrides) => ({
  origin: '500 Morris Ave, Springfield, NJ',
  destination: '20 Beechwood Rd, Millburn, NJ',
  ...overrides
})

describe('getDriveMinutes', () => {
  test('returns whatever the dependency resolves', async () => {
    const dependencies: MockDependencies<typeof getDriveMinutes> = (overrides) => ({
      fetchDriveMinutes: mock(() => okAsync(23)),
      ...overrides
    })

    const result = await getDriveMinutes(dependencies())(input())

    expect(result._unsafeUnwrap()).toBe(23)
  })

  test('propagates an error from the dependency', async () => {
    const error = { type: 'ValidationError' as const, message: "Couldn't find a route", input: undefined }
    const dependencies: MockDependencies<typeof getDriveMinutes> = (overrides) => ({
      fetchDriveMinutes: mock(() => errAsync(error)),
      ...overrides
    })

    const result = await getDriveMinutes(dependencies())(input())

    expect(result._unsafeUnwrapErr()).toEqual(error)
  })

  test('passes the origin and destination through unchanged', async () => {
    const dependencies: MockDependencies<typeof getDriveMinutes> = (overrides) => ({
      fetchDriveMinutes: mock(() => okAsync(10)),
      ...overrides
    })
    const deps = dependencies()

    await getDriveMinutes(deps)(input())

    expect(deps.fetchDriveMinutes).toHaveBeenCalledWith(input())
  })
})
