import { createNivaro } from '@nivaro/sdk'
import { CommandCenterView, NavigationContext, NivaroProvider } from '@nivaro/shared'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useAuth } from '@/lib/auth'

/**
 * /command — admin host for the shared Command Center board (map + live flow +
 * people + system rail + ticker). A headless frontend can mount CommandCenterView
 * with its own recordUrl for its record routing. The board keeps its lenses in the
 * query string itself (history.replaceState), so a copied link reopens the same view.
 */

const client = createNivaro(window.location.origin, { timeoutMs: 90_000 })

export function CommandCenterPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider value={{ navigate: (p: string) => navigate(p) }}>
        <CommandCenterView isAdmin={!!user?.is_admin} />
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}

/**
 * /command/kiosk#<token> — a wallboard link (CC-23): the board read-only, in TV mode, with no
 * app chrome and nobody signed in. Every read carries the token; the API answers as the
 * link's maker for Command Center reads only.
 */
export function CommandCenterKioskPage() {
  const { token: legacyToken = '' } = useParams<{ token: string }>()
  // The token lives in the URL fragment (#<token>): it is never sent to a server, so it cannot
  // reach an access log. An old /command/kiosk/<token> address is rewritten to that form here.
  const [token] = useState(() => {
    const fromHash = window.location.hash.replace(/^#/, '')
    const t = fromHash || legacyToken
    if (t && (legacyToken || !fromHash)) {
      window.history.replaceState(null, '', `/command/kiosk#${t}`)
    }
    return t
  })
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider value={{ navigate: () => undefined }}>
        {/* Bounded to the screen like the admin outlet: the board scrolls its own rail, and
            the map keeps the screen's height instead of growing with the rail. */}
        <div className='flex h-screen flex-col overflow-hidden'>
          <CommandCenterView kiosk={token} />
        </div>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
