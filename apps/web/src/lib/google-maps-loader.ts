// Loads the Maps JavaScript API (Places library) once and memoizes the
// promise, so mounting the event form repeatedly doesn't re-inject the
// script tag. Rejects immediately (no network call) when no browser key is
// configured — callers fall back to a plain address input.
let loadPromise: Promise<void> | null = null

export const loadGoogleMaps = (): Promise<void> => {
  if (loadPromise) return loadPromise

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
  if (!apiKey) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not set'))

  loadPromise = new Promise((resolve, reject) => {
    if (window.google?.maps?.places) {
      resolve()
      return
    }

    const callbackName = '__carmelosGoogleMapsLoaded'
    ;(window as unknown as Record<string, () => void>)[callbackName] = () => resolve()

    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&loading=async&callback=${callbackName}`
    script.async = true
    script.onerror = () => reject(new Error('Failed to load Google Maps'))
    document.head.append(script)
  })

  return loadPromise
}
