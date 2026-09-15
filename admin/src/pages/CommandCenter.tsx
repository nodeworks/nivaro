import { CommandCenterView, NavigationContext, NivaroProvider } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useNavigate } from 'react-router'

/**
 * /command — admin host for the shared Command Center board (map + live flow +
 * people + system rail + ticker). A headless frontend can mount CommandCenterView
 * with its own recordUrl for its record routing.
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
