import { CommandCenterView, NavigationContext, NivaroProvider } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useNavigate } from 'react-router'

/**
 * /command — admin host for the shared Command Center board (map + live flow +
 * people + system rail + ticker). efp-new can mount CommandCenterView with its
 * own recordUrl for /records/:c/:id routing.
 */

const client = createNivaro(window.location.origin)

export function CommandCenterPage() {
  const navigate = useNavigate()
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider value={{ navigate: (p: string) => navigate(p) }}>
        <CommandCenterView geoCollections={['locations']} />
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
