export const diffMinutes = (laterIso: string, earlierIso: string): number =>
  Math.round((new Date(laterIso).getTime() - new Date(earlierIso).getTime()) / 60_000)

export const addMinutesToIso = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()

export const roundDownToHalfHour = (date: Date): Date => {
  const rounded = new Date(date)
  rounded.setSeconds(0, 0)
  rounded.setMinutes(rounded.getMinutes() - (rounded.getMinutes() % 30))
  return rounded
}

export const roundUpToHalfHour = (date: Date): Date => {
  const rounded = new Date(date)
  rounded.setSeconds(0, 0)
  const remainder = rounded.getMinutes() % 30
  if (remainder !== 0) rounded.setMinutes(rounded.getMinutes() + (30 - remainder))
  return rounded
}

export const initialsOf = (name: string): string =>
  name.length <= 2 ? name.toUpperCase() : (name[0]?.toUpperCase() ?? '')
