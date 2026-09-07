export type ConsumablesSettings = Readonly<{
  sparePizzasPerEvent: number
  cheeseBagsPerDough: number
  saucePerPizzas: number
  traySize: number
}>

export type ConsumablesEventInput = Readonly<{
  headcount: number
  glutenFreeHeadcount: number
}>

export type ConsumablesSummary = Readonly<{
  totalPizzas: number
  doughCount: number
  cheeseBags: number
  sauceUnits: number
  trays: number
  // Additive, not a substitution for the regular dough count (spec §7).
  glutenFreeDoughExtra: number
}>

/** Night-before consumables list for a day: cheap headcount arithmetic that catches the one failure that can't be rushed the morning of. */
export const computeConsumables = (
  events: readonly ConsumablesEventInput[],
  settings: ConsumablesSettings
): ConsumablesSummary => {
  const totalPizzas = events.reduce((sum, event) => sum + event.headcount + settings.sparePizzasPerEvent, 0)
  const glutenFreeDoughExtra = events.reduce((sum, event) => sum + event.glutenFreeHeadcount, 0)
  const doughCount = totalPizzas

  return {
    totalPizzas,
    doughCount,
    cheeseBags: Math.ceil(doughCount / settings.cheeseBagsPerDough),
    sauceUnits: Math.ceil(totalPizzas / settings.saucePerPizzas),
    trays: Math.ceil(doughCount / settings.traySize),
    glutenFreeDoughExtra
  }
}
