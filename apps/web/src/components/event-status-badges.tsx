import { useQuery } from '@tanstack/react-query'
import { CloudLightning, CloudRain, MapPin, ThermometerSun, Tornado } from 'lucide-react'
import type { ComponentType } from 'react'

import { useApiClient } from '@/components/api-client-provider'
import { mockDriveMinutes, mockWeather, useDevMocks } from '@/lib/dev-mocks'

type TrafficLevel = 'good' | 'warn' | 'bad'

const TRAFFIC_BG: Readonly<Record<TrafficLevel, string>> = {
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad'
}

export type TrafficBadgeProperties = Readonly<{
  // Null when there's no known origin (no shop address set, no prior event
  // to measure from) — the badge just doesn't render.
  origin: string | null
  destination: string
  plannedDriveMinutes: number
  // When the truck actually pulls out for this leg. The estimate is for THAT
  // departure, not right now — the point is whether they'll land in time to
  // set up, and a leg that's clear at 9am can be a crawl at 5pm.
  departsAtIso: string
  // When they have to be on site to start setting up — what the Maps link
  // opens as its "arrive by" target.
  arriveByIso: string
  // In the expanded lane there's room to make this an actual control; in the
  // narrow ones it stays a colour bar with nothing to hit.
  isExpanded?: boolean
}>

const mapsPathSegment = (address: string): string => encodeURIComponent(address).replace(/%20/g, '+')

/**
 * Google's directions view for this leg, opened on "Arrive by" the moment
 * set-up has to start — the question is never "how long is it right now", it's
 * "when do we have to pull out to be on site in time".
 *
 * The documented `dir/?api=1` form takes no time at all (an `arrival_time`
 * param is silently dropped), so this uses the `data=` form the Maps UI itself
 * produces: `6e1!7e2` selects arrive-by and `8j<epoch>` carries the moment.
 * That encoding is Google's own and undocumented — if a future change breaks
 * it, the link still opens the correct route, just on "Leave now".
 */
const mapsArriveByUrl = (origin: string, destination: string, arriveByIso: string): string => {
  const epochSeconds = Math.floor(new Date(arriveByIso).getTime() / 1000)
  const route = `${mapsPathSegment(origin)}/${mapsPathSegment(destination)}`
  return `https://www.google.com/maps/dir/${route}/data=!4m8!4m7!1m0!1m0!2m3!6e1!7e2!8j${epochSeconds}!3e0`
}

/** Live traffic vs. what was planned for this leg — sits in the Drive block
 * itself. Fetched only while the lane has real width (not collapsed to a
 * sliver), cached for a few minutes so re-expanding doesn't refire it. */
export const TrafficBadge = ({
  origin,
  destination,
  plannedDriveMinutes,
  departsAtIso,
  arriveByIso,
  isExpanded
}: TrafficBadgeProperties) => {
  const client = useApiClient()
  const mocks = useDevMocks()

  // Google only gives traffic-aware durations for a departure that's now or
  // later, so a leg already in the past falls back to current conditions.
  const departureSeconds = Math.floor(new Date(departsAtIso).getTime() / 1000)
  const departureTime: number | 'now' = departureSeconds > Date.now() / 1000 ? departureSeconds : 'now'

  const traffic = useQuery({
    enabled: Boolean(origin) && !mocks.traffic,
    queryKey: ['live-drive-time', origin, destination, departureTime],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const response = await client.api['drive-time'].$post({
        json: { origin: origin as string, destination, departureTime }
      })
      if (!response.ok) throw new Error('unavailable')
      return response.json()
    }
  })

  const liveMinutes = mocks.traffic
    ? mockDriveMinutes(origin ?? '', destination, plannedDriveMinutes)
    : traffic.data?.minutes
  if (liveMinutes === undefined) return null

  const overBy = liveMinutes - plannedDriveMinutes
  const level: TrafficLevel = overBy <= 5 ? 'good' : overBy <= 15 ? 'warn' : 'bad'

  const label = `${mocks.traffic ? 'MOCK drive time' : 'Live drive time'} ~${liveMinutes}m (planned ${plannedDriveMinutes}m)`

  // A bar down the full height of the drive block rather than a dot: the
  // block IS the journey, so the colour reads as "this whole leg is slow"
  // and the eye picks it up without hunting for a badge. Expanded, the same
  // bar keeps its colour but becomes the way into Google's own live ETA.
  if (!isExpanded || !origin) {
    return <span title={label} className={`absolute inset-y-0.5 right-0.5 w-1.5 rounded-full ${TRAFFIC_BG[level]}`} />
  }

  return (
    <a
      href={mapsArriveByUrl(origin, destination, arriveByIso)}
      target="_blank"
      rel="noreferrer"
      title={`${label} — open in Google Maps, arriving by set-up time`}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
      className={`absolute inset-y-0.5 right-0.5 flex w-9 flex-col items-center justify-center gap-0.5 rounded font-mono text-[9px] font-semibold leading-none text-white hover:opacity-90 ${TRAFFIC_BG[level]}`}
    >
      <span>{liveMinutes}m</span>
      <MapPin className="h-2.5 w-2.5" />
    </a>
  )
}

type WeatherBadge = Readonly<{
  key: string
  className: string
  Icon: ComponentType<{ className?: string }>
  title: string
}>

export type WeatherBadgesProperties = Readonly<{ address: string }>

/** Precipitation/heat/tornado/thunderstorm at the party's address — same
 * visibility and caching rules as the traffic badge, anchored to the Serve
 * block instead since this is about the party, not the drive. */
export const WeatherBadges = ({ address }: WeatherBadgesProperties) => {
  const client = useApiClient()
  const mocks = useDevMocks()

  const weather = useQuery({
    enabled: !mocks.weather,
    queryKey: ['weather', address],
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      const response = await client.api.weather.$get({ query: { address } })
      if (!response.ok) throw new Error('unavailable')
      return response.json()
    }
  })

  const forecast = mocks.weather ? mockWeather(address) : weather.data
  const badges: WeatherBadge[] = []

  if (forecast?.condition === 'rain' || forecast?.condition === 'snow') {
    badges.push({
      key: 'precip',
      className: 'bg-travel',
      Icon: CloudRain,
      title: forecast.shortForecast ?? 'Precipitation expected'
    })
  }
  if (forecast?.isExtremeHeat) {
    badges.push({
      key: 'heat',
      className: 'bg-warn',
      Icon: ThermometerSun,
      title: forecast.tempF !== null ? `${forecast.tempF}°F` : 'Extreme heat'
    })
  }
  if (forecast?.hasTornadoWarning) {
    badges.push({ key: 'tornado', className: 'bg-bad', Icon: Tornado, title: 'Tornado warning in effect' })
  }
  if (forecast?.hasThunderstormWarning) {
    badges.push({
      key: 'storm',
      className: 'bg-bad',
      Icon: CloudLightning,
      title: forecast.shortForecast ?? 'Thunderstorm warning in effect'
    })
  }

  if (badges.length === 0) return null

  return (
    <div className="absolute bottom-0.5 right-0.5 flex gap-0.5">
      {badges.map(({ key, className, Icon, title }) => (
        <span
          key={key}
          title={title}
          className={`flex h-3.5 w-3.5 items-center justify-center rounded-md text-white ${className}`}
        >
          <Icon className="h-2.5 w-2.5" />
        </span>
      ))}
    </div>
  )
}
