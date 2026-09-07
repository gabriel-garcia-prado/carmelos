export const RIGS = ['small_caddy', 'big_caddy', 'pickup', 'bus'] as const

export type Rig = (typeof RIGS)[number]

export const RIG_LABELS: Readonly<Record<Rig, string>> = {
  small_caddy: 'Small Caddy',
  big_caddy: 'Big Caddy',
  pickup: 'Pickup',
  bus: 'Bus'
}

export const REQUEST_TYPES = [
  'gluten_free',
  'halal',
  'no_pork',
  'vegetarian',
  'vegan',
  'dairy_free',
  'paneer',
  'spicy'
] as const

export type RequestType = (typeof REQUEST_TYPES)[number]

export const REQUEST_LABELS: Readonly<Record<RequestType, string>> = {
  gluten_free: 'Gluten free',
  halal: 'Halal',
  no_pork: 'No pork',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  dairy_free: 'Dairy free',
  paneer: 'Paneer',
  spicy: 'Spicy'
}
