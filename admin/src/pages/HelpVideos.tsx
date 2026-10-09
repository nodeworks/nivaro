import { createNivaro } from '@nivaro/sdk'
import {
  AuthorRolesButton,
  defaultItemUrl,
  HelpVideoLibrary,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  RenderSettingsButton
} from '@nivaro/shared'
import { useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'

// Videos — tutorial recordings people watch from the library, from a record
// form's Videos button and from My Work when a video is required. Authors
// (admins + the roles chosen under "Who can record") record and edit here.
// ?watch=<id> opens the player (&t=<seconds> or &c=<chapter id> start it at a
// moment), ?edit=<id> the editor.
const client = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

export function HelpVideosPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const set = (key: 'watch' | 'edit', id: string | null) => {
    const next = new URLSearchParams(params)
    next.delete('watch')
    next.delete('edit')
    next.delete('t')
    next.delete('c')
    if (id) next.set(key, id)
    setParams(next, { replace: key === 'watch' })
  }
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
        >
          <ItemEditAuthContext.Provider
            value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
          >
            <HelpVideoLibrary
              watchId={params.get('watch')}
              watchAt={params.get('t')}
              watchChapter={params.get('c')}
              editId={params.get('edit')}
              onWatch={(id) => set('watch', id)}
              onEdit={(id) => set('edit', id)}
              headerExtra={
                <>
                  <AuthorRolesButton />
                  <RenderSettingsButton />
                </>
              }
            />
          </ItemEditAuthContext.Provider>
        </NavigationContext.Provider>
      </NivaroProvider>
    </div>
  )
}
