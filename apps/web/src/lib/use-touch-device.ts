import { useSyncExternalStore } from 'react'

// Pointer type, not screen width: a narrow desktop window is still a desktop,
// and a tablet in landscape is still the thing that can open Messages. This is
// also the one signal that doesn't rely on parsing a user-agent string.
const COARSE_POINTER = '(pointer: coarse)'

let query: MediaQueryList | null = null
const mediaQuery = (): MediaQueryList => {
  query ??= globalThis.matchMedia(COARSE_POINTER)
  return query
}

const subscribe = (onChange: () => void): (() => void) => {
  const list = mediaQuery()
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/**
 * Whether this device drives with a finger — which here stands for "can
 * actually open an `sms:` link". Desktop browsers hand that scheme to the OS
 * and, with nothing registered for it, drop the navigation silently: no error,
 * no window, no way for JavaScript to find out it went nowhere.
 */
export const useIsTouchDevice = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => mediaQuery().matches,
    () => false
  )
