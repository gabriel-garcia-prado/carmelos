/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Browser-restricted key for the Maps JavaScript API (Places library) —
  // distinct from the server's GOOGLE_MAPS_API_KEY, which is IP-restricted
  // and used for the Distance Matrix API instead. Optional: without it, the
  // address field is a plain input and drive time stays manual-entry only.
  readonly VITE_GOOGLE_MAPS_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// @types/google.maps declares the `google` namespace but not its presence on
// `window` — the Maps JS API script attaches it there once loaded.
interface Window {
  google?: typeof google
}
