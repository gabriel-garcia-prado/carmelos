import { useQueryClient } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { DevMocks } from '@/lib/dev-mocks'
import { DEV_MOCK_KEYS, setDevMock, useDevMocks } from '@/lib/dev-mocks'

/**
 * Dev-only strip along the bottom for switching the live lookups to canned
 * data. Rendered nowhere but a dev build — `import.meta.env.DEV` is a literal
 * at build time, so the whole thing drops out of a production bundle.
 */
export const DevBar = () => {
  const mocks = useDevMocks()
  const queryClient = useQueryClient()
  if (!import.meta.env.DEV) return null

  const toggle = (key: keyof DevMocks, value: boolean) => {
    setDevMock(key, value)
    // Turning mocking OFF leaves the cache holding whatever the fake said, so
    // drop both sets of results and let the real lookups run again.
    void queryClient.invalidateQueries({ queryKey: [key === 'weather' ? 'weather' : 'live-drive-time'] })
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-end gap-4 border-t bg-card/95 px-3 py-1.5 backdrop-blur">
      {/* Hidden on narrow viewports, where the router devtools badge already
          occupies this corner. The mr-auto spacer stays either way so the
          toggles keep to the right of it. */}
      <span className="mr-auto hidden items-center gap-1.5 pl-56 font-mono text-[10px] uppercase tracking-wide text-muted-foreground lg:flex">
        <FlaskConical className="h-3 w-3" />
        Dev
      </span>
      {DEV_MOCK_KEYS.map(([key, label, hint]) => (
        <div key={key} className="flex items-center gap-1.5" title={hint}>
          <Checkbox
            id={`dev-mock-${key}`}
            checked={mocks[key]}
            onCheckedChange={(checked) => toggle(key, checked === true)}
          />
          <Label htmlFor={`dev-mock-${key}`} className="cursor-pointer whitespace-nowrap font-normal text-xs">
            {label}
          </Label>
        </div>
      ))}
    </div>
  )
}
