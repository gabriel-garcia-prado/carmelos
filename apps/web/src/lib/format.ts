export const formatClockTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/**
 * The board's own convention: 12-hour, no meridiem.
 *
 * Every time on a lane is read against the ones above and below it, so AM/PM
 * is noise — and at 8px it's noise that doubles the width of the label.
 */
export const formatLaneTime = (iso: string | null | undefined): string => formatClockTime(iso).replace(/\s?[AP]M$/, '')

export const formatDuration = (minutes: number | null | undefined): string => {
  if (minutes === null || minutes === undefined) return '—'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${remainder}m`
  if (remainder === 0) return `${hours}h`
  return `${hours}h ${remainder}m`
}

export const toDateKey = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const addDaysToKey = (dateKey: string, days: number): string => {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  return toDateKey(new Date(year, month - 1, day + days))
}

export const formatDateLabel = (dateKey: string): string => {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
}
