import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { loadGoogleMaps } from '@/lib/google-maps-loader'

type Suggestion = Readonly<{
  /** Stable across renders — used as the list key and to fetch the address. */
  placeId: string
  /** "412 Prospect St" — the part that matches what's been typed. */
  mainText: string
  /** "Westfield, NJ, USA" */
  secondaryText: string
  prediction: google.maps.places.PlacePrediction
}>

export type AddressAutocompleteProperties = Readonly<{
  id: string
  value: string
  onChange: (value: string) => void
  /** Fired only for a picked suggestion, with the resolved full address —
   * never for free typing, so callers can treat it as "this one is real". */
  onSelect: (formattedAddress: string) => void
  onBlur?: () => void
  required?: boolean
  placeholder?: string
}>

// Below this there's nothing worth asking Google about, and every keystroke is
// a billable request.
const MIN_QUERY_LENGTH = 3
const DEBOUNCE_MS = 250

/**
 * Address field with its own suggestion list, built on the Places data API
 * (`AutocompleteSuggestion`) rather than the `Autocomplete` widget.
 *
 * The widget renders its own dropdown into `<body>` and only exposes a fixed
 * set of classes, which cost us: Radix sets `pointer-events: none` on the body
 * while a modal drawer is open, so the suggestions became unclickable; the
 * widget has no `destroy()`, so StrictMode's double-mount left two of them on
 * one input; and restyling its footer made the SDK refuse to render at all.
 * Fetching the data and drawing the list ourselves removes all three, because
 * the list is then just markup inside the drawer like everything else.
 *
 * The "Powered by Google" mark stays: the Places terms require attribution
 * wherever results are shown without a Google map. Rendering it ourselves is
 * what buys the freedom over everything around it.
 */
export const AddressAutocomplete = ({
  id,
  value,
  onChange,
  onSelect,
  onBlur,
  required,
  placeholder
}: AddressAutocompleteProperties) => {
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([])
  const [open, setOpen] = useState(false)
  // Suggestions are only ever fetched for someone actually in the field.
  // Loading an existing event sets the address programmatically, and without
  // this the list sprang open over a form nobody had touched yet.
  const [focused, setFocused] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const listboxId = useId()

  // A session groups the keystrokes leading up to one selection so Google
  // bills them as a single autocomplete session rather than per request. It
  // has to be replaced once a place has been resolved.
  const sessionToken = useRef<google.maps.places.AutocompleteSessionToken | null>(null)
  // Guards against an older, slower response overwriting a newer one.
  const latestQuery = useRef(0)
  // Set while a suggestion is being applied, so the resulting value change
  // doesn't immediately reopen the list.
  const applying = useRef(false)

  useEffect(() => {
    if (applying.current) {
      applying.current = false
      return
    }
    if (!focused) {
      setOpen(false)
      return
    }
    const query = value.trim()
    if (query.length < MIN_QUERY_LENGTH) {
      setSuggestions([])
      setOpen(false)
      return
    }

    const requestId = ++latestQuery.current
    const timer = setTimeout(async () => {
      try {
        await loadGoogleMaps()
        const places = window.google?.maps?.places
        if (!places) return
        sessionToken.current ??= new places.AutocompleteSessionToken()

        const { suggestions: fetched } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: query,
          includedRegionCodes: ['us'],
          sessionToken: sessionToken.current
        })
        if (requestId !== latestQuery.current) return

        const next = fetched.flatMap((suggestion) => {
          const prediction = suggestion.placePrediction
          return prediction
            ? [
                {
                  placeId: prediction.placeId,
                  mainText: prediction.mainText?.toString() ?? prediction.text.toString(),
                  secondaryText: prediction.secondaryText?.toString() ?? '',
                  prediction
                }
              ]
            : []
        })
        setSuggestions(next)
        setActiveIndex(-1)
        setOpen(next.length > 0)
      } catch {
        // No browser key, a blocked request, or a network blip — the field
        // stays a plain input and the address can still be typed by hand.
        setSuggestions([])
        setOpen(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [value, focused])

  const choose = async (suggestion: Suggestion) => {
    setOpen(false)
    setSuggestions([])
    setActiveIndex(-1)
    try {
      const place = suggestion.prediction.toPlace()
      await place.fetchFields({ fields: ['formattedAddress'] })
      // Ends the billing session — the next keystroke starts a fresh one.
      sessionToken.current = null
      const resolved = place.formattedAddress
      if (!resolved) return
      applying.current = true
      onChange(resolved)
      onSelect(resolved)
    } catch {
      // Fall back to the prediction's own text rather than losing the pick.
      applying.current = true
      const fallback = [suggestion.mainText, suggestion.secondaryText].filter(Boolean).join(', ')
      onChange(fallback)
      onSelect(fallback)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1))
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      // Only swallow Enter when a row is actually highlighted, so it still
      // submits the form when the list is just sitting open.
      event.preventDefault()
      const picked = suggestions[activeIndex]
      if (picked) void choose(picked)
    } else if (event.key === 'Escape') {
      // Closing the list is all this does. Radix's dismiss layer listens for
      // Escape in the CAPTURE phase on document, so it has already decided
      // what to do before React dispatches here — stopPropagation is far too
      // late. The drawer is kept open by the SheetContent's own
      // onEscapeKeyDown, which reads `aria-expanded` off this input.
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        autoComplete="off"
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        // A suggestion's mousedown preventDefaults, so focus never leaves the
        // input mid-pick and this only runs when the field is genuinely done
        // with — no timeout needed to outlive the click.
        onBlur={() => {
          setFocused(false)
          setOpen(false)
          onBlur?.()
        }}
      />

      {open && suggestions.length > 0 ? (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
          <div id={listboxId} role="listbox" aria-label="Address suggestions">
            {suggestions.map((suggestion, index) => (
              <div
                key={suggestion.placeId}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // Focus stays on the input for the whole interaction — that's
                // the combobox pattern, and it's why the arrow keys are handled
                // there and the active row is named by aria-activedescendant.
                tabIndex={-1}
                className={`cursor-pointer px-3 py-2 text-[13px] leading-5 ${
                  index === activeIndex ? 'bg-accent text-accent-foreground' : ''
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                // mousedown, not click: the input's blur would otherwise close
                // the list before a click ever landed.
                onMouseDown={(event) => {
                  event.preventDefault()
                  void choose(suggestion)
                }}
              >
                <span className="font-semibold">{suggestion.mainText}</span>
                {suggestion.secondaryText ? (
                  <span className="ml-1.5 text-muted-foreground">{suggestion.secondaryText}</span>
                ) : null}
              </div>
            ))}
          </div>
          {/* Required by the Places terms wherever results appear without a
              Google map. Ours to place and size, which is the whole point. */}
          <div className="flex justify-end border-t px-3 py-1.5">
            <span className="google-attribution" />
          </div>
        </div>
      ) : null}
    </div>
  )
}
