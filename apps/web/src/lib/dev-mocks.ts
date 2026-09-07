import { useSyncExternalStore } from 'react'

/**
 * Which live lookups are being faked. Both are off by default — turning one on
 * stops the app calling Google/NWS at all and swaps in canned data, which is
 * how you see a badge that only appears in real weather, and how you work on
 * the board without spending quota on every re-render.
 */
export type DevMocks = Readonly<{ weather: boolean; traffic: boolean }>

export const DEV_MOCK_KEYS = [
  ['weather', 'Mock weather', 'Canned forecasts instead of the NWS lookup.'],
  ['traffic', 'Mock traffic', 'Canned drive times instead of the Google lookup.']
] as const

const STORAGE_KEY = 'carmelos.dev-mocks'
const NONE: DevMocks = { weather: false, traffic: false }

const read = (): DevMocks => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return NONE
    const parsed = JSON.parse(raw) as Partial<DevMocks>
    return { weather: parsed.weather === true, traffic: parsed.traffic === true }
  } catch {
    // Private windows and blocked site data both throw here; the toggles just
    // don't persist, which is no reason to take the whole board down.
    return NONE
  }
}

let current: DevMocks = read()
const listeners = new Set<() => void>()

export const setDevMock = (key: keyof DevMocks, value: boolean): void => {
  current = { ...current, [key]: value }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Same as above — the toggle still works for this session.
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Always `NONE` outside dev, so a flag left in localStorage can never follow
 * a build into production and quietly replace real forecasts with fakes. */
export const useDevMocks = (): DevMocks =>
  useSyncExternalStore(
    subscribe,
    () => (import.meta.env.DEV ? current : NONE),
    () => NONE
  )

/** Stable per string, so one address always mocks to the same thing — the
 * board stays still between renders instead of flickering through conditions. */
const hash = (value: string): number => {
  let accumulator = 0
  for (const character of value) accumulator = (accumulator * 31 + character.charCodeAt(0)) | 0
  return Math.abs(accumulator)
}

type MockWeather = Readonly<{
  tempF: number | null
  condition: 'rain' | 'snow' | 'thunderstorm' | 'clear' | null
  shortForecast: string | null
  isExtremeHeat: boolean
  hasTornadoWarning: boolean
  hasThunderstormWarning: boolean
}>

const WEATHER_CYCLE: readonly MockWeather[] = [
  {
    tempF: 72,
    condition: 'clear',
    shortForecast: 'Sunny',
    isExtremeHeat: false,
    hasTornadoWarning: false,
    hasThunderstormWarning: false
  },
  {
    tempF: 61,
    condition: 'rain',
    shortForecast: 'Rain likely',
    isExtremeHeat: false,
    hasTornadoWarning: false,
    hasThunderstormWarning: false
  },
  {
    tempF: 98,
    condition: 'clear',
    shortForecast: 'Hot and sunny',
    isExtremeHeat: true,
    hasTornadoWarning: false,
    hasThunderstormWarning: false
  },
  {
    tempF: 68,
    condition: 'thunderstorm',
    shortForecast: 'Scattered thunderstorms',
    isExtremeHeat: false,
    hasTornadoWarning: false,
    hasThunderstormWarning: true
  },
  {
    tempF: 66,
    condition: 'rain',
    shortForecast: 'Severe weather',
    isExtremeHeat: false,
    hasTornadoWarning: true,
    hasThunderstormWarning: false
  }
]

/** Spreads the parties across every badge the real endpoint can produce, so
 * one glance at a seeded week exercises all of them. */
export const mockWeather = (address: string): MockWeather =>
  WEATHER_CYCLE[hash(address) % WEATHER_CYCLE.length] as MockWeather

/** Runs at, a bit over, and well over the planned time — one of each severity
 * the badge colours, keyed off the leg so it doesn't move around. */
export const mockDriveMinutes = (origin: string, destination: string, plannedMinutes: number): number =>
  plannedMinutes + ([0, 12, 28][hash(`${origin}->${destination}`) % 3] as number)
