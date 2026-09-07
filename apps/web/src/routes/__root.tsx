import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { DevBar } from '@/components/dev-bar'
import { ErrorBoundary } from '@/components/error-boundary'
import { ModeToggle } from '@/components/mode-toggle'
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarTrigger } from '@/components/ui/menubar'
import { client } from '@/lib/auth-client'

const Root = () => {
  const { data } = client.useSession()
  return (
    <div className="">
      <div className="p-2 flex gap-2">
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger className="flex items-center gap-2">
              <svg viewBox="0 0 50 20" width="20" height="8" aria-hidden="true">
                <rect x="0" y="0" width="10" height="10" fill="var(--fired)" />
                <rect x="20" y="0" width="10" height="10" fill="var(--fired)" />
                <rect x="40" y="0" width="10" height="10" fill="var(--fired)" />
                <rect x="10" y="10" width="10" height="10" fill="var(--fired)" />
                <rect x="30" y="10" width="10" height="10" fill="var(--fired)" />
              </svg>
              Carmelo's
            </MenubarTrigger>
            <MenubarContent>
              <MenubarItem asChild>
                <Link to="/" className="w-full cursor-default">
                  Today
                </Link>
              </MenubarItem>
              <MenubarItem asChild>
                <Link to="/week" className="w-full cursor-default">
                  Week
                </Link>
              </MenubarItem>
              <MenubarItem asChild>
                <Link to="/people" className="w-full cursor-default">
                  People
                </Link>
              </MenubarItem>
              <MenubarItem asChild>
                <Link to="/settings" className="w-full cursor-default">
                  Settings
                </Link>
              </MenubarItem>
              {data?.session ? (
                <MenubarItem asChild>
                  <button type="button" className="w-full cursor-default text-left" onClick={() => client.signOut()}>
                    Log out
                  </button>
                </MenubarItem>
              ) : undefined}
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
        <ModeToggle />
      </div>
      <hr />
      {/* Bottom padding so the fixed dev bar never covers the last row of
          whatever page is open. Zero in a production build, where DevBar
          renders nothing. */}
      <div className={import.meta.env.DEV ? 'pb-10' : ''}>
        <Outlet />
      </div>
      <TanStackRouterDevtools />
      <DevBar />
    </div>
  )
}

export const Route = createRootRoute({ component: Root, errorComponent: ErrorBoundary })
