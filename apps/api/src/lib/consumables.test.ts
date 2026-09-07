import { describe, expect, test } from 'bun:test'
import { computeConsumables } from './consumables'

const settings = { sparePizzasPerEvent: 25, cheeseBagsPerDough: 25, saucePerPizzas: 35, traySize: 25 }

describe('computeConsumables', () => {
  test('matches the mockup add-event example for a single 60-person party', () => {
    const summary = computeConsumables([{ headcount: 60, glutenFreeHeadcount: 0 }], settings)

    expect(summary.totalPizzas).toBe(85)
    expect(summary.cheeseBags).toBe(4)
    expect(summary.sauceUnits).toBe(3)
    expect(summary.trays).toBe(4)
  })

  test('sums across events and keeps gluten-free as an additive line, not a substitution', () => {
    const summary = computeConsumables(
      [
        { headcount: 50, glutenFreeHeadcount: 2 },
        { headcount: 60, glutenFreeHeadcount: 0 }
      ],
      settings
    )

    expect(summary.totalPizzas).toBe(50 + 25 + (60 + 25))
    expect(summary.glutenFreeDoughExtra).toBe(2)
    expect(summary.doughCount).toBe(summary.totalPizzas)
  })
})
