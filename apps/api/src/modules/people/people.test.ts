import { describe, expect, mock, test } from 'bun:test'
import { okAsync } from 'neverthrow'
import type { MockDependencies, MockInput } from '#test'
import type { Person } from './people'
import { createPerson, deletePerson, listPeople, updatePerson } from './people'

const ID = 'b16ed4bb-2c3f-478f-8b1d-1139467daf4d'

const PERSON: Person = {
  id: ID,
  name: 'Kurt',
  phone: '973 525-7887',
  isPizzaiolo: true,
  canStick: true,
  canDrive: true,
  canDriveTrailer: false,
  rackRateOverridePer30Min: null,
  minutesBeforeDepartureOverride: null,
  homeBaseAddress: null
}

describe('listPeople', () => {
  test('returns everyone from the store', async () => {
    const dependencies: MockDependencies<typeof listPeople> = (overrides) => ({
      fetchPeople: mock(() => okAsync([PERSON])),
      ...overrides
    })

    const result = await listPeople(dependencies())()

    expect(result._unsafeUnwrap()).toEqual([PERSON])
  })
})

describe('createPerson', () => {
  test('inserts under a generated id', async () => {
    const dependencies: MockDependencies<typeof createPerson> = (overrides) => ({
      generateId: mock(() => ID),
      insertPerson: mock((person: typeof PERSON) => okAsync(person)),
      ...overrides
    })
    const deps = dependencies()
    const input: MockInput<typeof createPerson> = (overrides) => ({
      name: 'Kurt',
      phone: '973 525-7887',
      isPizzaiolo: true,
      canStick: true,
      canDrive: true,
      canDriveTrailer: false,
      rackRateOverridePer30Min: null,
      minutesBeforeDepartureOverride: null,
      homeBaseAddress: null,
      ...overrides
    })

    const result = await createPerson(deps)(input())

    expect(deps.insertPerson).toHaveBeenCalledWith(PERSON)
    expect(result._unsafeUnwrap()).toEqual(PERSON)
  })
})

describe('updatePerson', () => {
  test('saves the given update', async () => {
    const update = { id: ID, rackRateOverridePer30Min: 25 }
    const dependencies: MockDependencies<typeof updatePerson> = (overrides) => ({
      savePerson: mock(() => okAsync({ ...PERSON, rackRateOverridePer30Min: 25 })),
      ...overrides
    })
    const deps = dependencies()

    const result = await updatePerson(deps)(update)

    expect(deps.savePerson).toHaveBeenCalledWith(update)
    expect(result._unsafeUnwrap().rackRateOverridePer30Min).toBe(25)
  })
})

describe('deletePerson', () => {
  const dependencies: MockDependencies<typeof deletePerson> = (overrides) => ({
    countEventsUsing: mock(() => okAsync(0)),
    removePerson: mock(() => okAsync(undefined)),
    ...overrides
  })

  test("removes by id when they aren't on any booked day", async () => {
    const deps = dependencies()

    await deletePerson(deps)(ID)

    expect(deps.removePerson).toHaveBeenCalledWith(ID)
  })

  test('refuses while they are still crewing a booked day', async () => {
    const deps = dependencies({ countEventsUsing: mock(() => okAsync(3)) })

    const result = await deletePerson(deps)(ID)

    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr()).toMatchObject({ type: 'ValidationError' })
    expect(deps.removePerson).not.toHaveBeenCalled()
  })
})
