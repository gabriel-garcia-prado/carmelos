export const addMinutes = (date: Date, minutes: number): Date => new Date(date.getTime() + minutes * 60_000)

export const diffMinutes = (later: Date, earlier: Date): number =>
  Math.round((later.getTime() - earlier.getTime()) / 60_000)

export const earliestOf = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b)

export const formatDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${remainder}m`
  if (remainder === 0) return `${hours}h`
  return `${hours}h ${remainder}m`
}

export const formatClockTime = (date: Date): string =>
  date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

// Local wall-clock date keys ('YYYY-MM-DD'), deliberately not UTC/ISO-based —
// event times are the shop's local time, and going through UTC would shift
// the date key by a day depending on the server's offset.
export const toDateKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const addDays = (dateKey: string, days: number): string => {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  return toDateKey(new Date(year, month - 1, day + days))
}

export const parseDateKey = (dateKey: string): Date => {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day)
}
