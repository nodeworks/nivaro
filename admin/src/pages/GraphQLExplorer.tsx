import { GraphiQL } from 'graphiql'
import 'graphiql/style.css'
import { explorerPlugin } from '@graphiql/plugin-explorer'
import '@graphiql/plugin-explorer/style.css'
import { ToolbarButton, useGraphiQL } from '@graphiql/react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, KeyRound, Save, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

interface KeyRow {
  id: string | number
  name: string
  prefix: string
  scopes: Array<{ collection: string; actions: string[] }>
  sandbox?: boolean
  is_active: boolean
  graphql_max_depth?: number | null
}

/** A run-as-key session (#625): the token the playground sends, and the key
 *  it stands for. Minted server-side for 15 minutes; never the key itself. */
interface RunAs {
  key: KeyRow
  token: string
  expiresAt: number
}

interface Fixture {
  id: string
  name: string
  key_id: string | number | null
  key_name: string | null
  query: string
  variables: string
  saved_at: string
}

const FIXTURES_KEY = 'nvr_gql_fixtures'

function readFixtures(): Fixture[] {
  try {
    const raw = localStorage.getItem(FIXTURES_KEY)
    const list = raw ? (JSON.parse(raw) as Fixture[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeFixtures(list: Fixture[]) {
  try {
    localStorage.setItem(FIXTURES_KEY, JSON.stringify(list.slice(0, 200)))
  } catch {
    // storage refused — the fixture lives for this page only
  }
}

function describeKey(k: KeyRow): string {
  const parts: string[] = []
  if (k.sandbox) parts.push('sandbox')
  const open = k.scopes.some((s) => s.collection === '*' && s.actions.includes('*'))
  parts.push(
    open ? 'every collection' : `${k.scopes.length} scope${k.scopes.length === 1 ? '' : 's'}`
  )
  if (k.graphql_max_depth != null) parts.push(`depth ≤ ${k.graphql_max_depth}`)
  if (!k.is_active) parts.push('revoked')
  return parts.join(' · ')
}

/** Lives inside the GraphiQL provider: reads and writes the editors. */
function FixturesToolbar({
  runAs,
  onRunAsKey
}: {
  runAs: RunAs | null
  onRunAsKey: (keyId: string | number | null) => void
}) {
  const queryEditor = useGraphiQL((s) => s.queryEditor)
  const variableEditor = useGraphiQL((s) => s.variableEditor)
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [fixtures, setFixtures] = useState<Fixture[]>(() => readFixtures())

  const save = () => {
    const query = queryEditor?.getValue() ?? ''
    if (!query.trim()) {
      toast.error('Nothing to save — the query editor is empty')
      return
    }
    const trimmed = name.trim() || `Fixture ${fixtures.length + 1}`
    const next: Fixture = {
      id: crypto.randomUUID(),
      name: trimmed,
      key_id: runAs?.key.id ?? null,
      key_name: runAs?.key.name ?? null,
      query,
      variables: variableEditor?.getValue() ?? '',
      saved_at: new Date().toISOString()
    }
    const list = [next, ...fixtures]
    setFixtures(list)
    writeFixtures(list)
    setNaming(false)
    setName('')
    toast.success(`Saved "${trimmed}"${runAs ? ` as key ${runAs.key.name}` : ''}`)
  }
  const load = (f: Fixture) => {
    queryEditor?.setValue(f.query)
    variableEditor?.setValue(f.variables ?? '')
    onRunAsKey(f.key_id)
    setOpen(false)
  }
  const remove = (id: string) => {
    const list = fixtures.filter((f) => f.id !== id)
    setFixtures(list)
    writeFixtures(list)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ToolbarButton
          label='Fixtures — saved queries, each with the key it runs as'
          data-gql-fixtures
        >
          <Save className='h-4 w-4' />
        </ToolbarButton>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[360px] p-0' data-gql-fixtures-panel>
        <div className='border-b border-border px-3 py-2'>
          {naming ? (
            <form
              className='flex items-center gap-2'
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='Fixture name'
                data-gql-fixture-name
                className='h-8 flex-1 rounded-md border border-input bg-background px-2 text-[12px]'
              />
              <button
                type='submit'
                data-gql-fixture-save
                className='h-8 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white'
              >
                Save
              </button>
              <button
                type='button'
                onClick={() => setNaming(false)}
                className='h-8 px-1 text-muted-foreground'
                aria-label='Cancel'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </form>
          ) : (
            <button
              type='button'
              onClick={() => setNaming(true)}
              data-gql-fixture-new
              className='flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] hover:bg-muted'
            >
              <Save className='h-3.5 w-3.5 text-muted-foreground' />
              Save the current query as a fixture
              {runAs && (
                <span className='ml-auto text-[10.5px] text-muted-foreground'>
                  as {runAs.key.name}
                </span>
              )}
            </button>
          )}
        </div>
        <ul className='max-h-[320px] overflow-y-auto py-1'>
          {fixtures.length === 0 && (
            <li className='px-3 py-4 text-[12px] text-muted-foreground'>
              No fixtures yet. A fixture remembers a query, its variables and the key it ran as, so
              a partner's exact call can be replayed after a schema change.
            </li>
          )}
          {fixtures.map((f) => (
            <li
              key={f.id}
              data-gql-fixture={f.name}
              className='group flex items-start gap-2 px-3 py-1.5 hover:bg-muted'
            >
              <button type='button' onClick={() => load(f)} className='flex-1 text-left'>
                <span className='block text-[12px] font-medium'>{f.name}</span>
                <span className='block text-[10.5px] text-muted-foreground'>
                  {f.key_name ? `as key ${f.key_name}` : 'as you'} ·{' '}
                  {new Date(f.saved_at).toLocaleDateString()}
                </span>
              </button>
              <button
                type='button'
                onClick={() => remove(f.id)}
                aria-label={`Delete fixture ${f.name}`}
                className='mt-0.5 hidden text-muted-foreground hover:text-foreground group-hover:block'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

export function GraphQLExplorerPage() {
  const { user } = useAuth()
  const explorer = useMemo(() => explorerPlugin({ showAttribution: false }), [])

  // Run as key (#625). Admin-only route: a non-admin's list read 403s and
  // the control simply does not render.
  const keysQ = useQuery({
    queryKey: ['gql-run-as-keys'],
    queryFn: () => api.get<{ data: KeyRow[] }>('/api-keys').then((r) => r.data.data),
    retry: false,
    staleTime: 60_000
  })
  const keys = keysQ.data ?? []
  const [runAs, setRunAs] = useState<RunAs | null>(null)
  const runAsRef = useRef<RunAs | null>(null)
  runAsRef.current = runAs
  const [pickOpen, setPickOpen] = useState(false)

  const runAsKey = useCallback(
    async (keyId: string | number | null) => {
      if (keyId == null) {
        setRunAs(null)
        return
      }
      const key = keys.find((k) => String(k.id) === String(keyId))
      if (!key) {
        toast.error('That API key no longer exists')
        setRunAs(null)
        return
      }
      try {
        const r = await api.post<{ data: { token: string; expires_in: number } }>(
          `/api-keys/${key.id}/simulate-token`
        )
        setRunAs({
          key,
          token: r.data.data.token,
          expiresAt: Date.now() + r.data.data.expires_in * 1000
        })
      } catch {
        toast.error('Could not start a run-as-key session')
      }
    },
    [keys]
  )

  // The session lapses server-side after 15 minutes; say so before a query
  // fails with an expired-token error nobody expects.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!runAs) return
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [runAs])
  const minutesLeft = runAs ? Math.max(0, Math.round((runAs.expiresAt - Date.now()) / 60_000)) : 0

  const fetcher = async (params: unknown) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const sim = runAsRef.current
    if (sim) headers.Authorization = `Bearer ${sim.token}`
    else if (user?.static_token) headers.Authorization = `Bearer ${user.static_token}`
    const res = await fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(params)
    })
    return res.json()
  }

  return (
    <div className='flex h-full flex-col'>
      {keys.length > 0 && (
        <div
          data-gql-run-as-bar
          className={`flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[12px] ${
            runAs
              ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100'
              : 'border-border bg-background text-muted-foreground'
          }`}
        >
          <KeyRound className='h-3.5 w-3.5' />
          <span>Run as</span>
          <Popover open={pickOpen} onOpenChange={setPickOpen}>
            <PopoverTrigger asChild>
              <button
                type='button'
                data-gql-run-as
                className='inline-flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2 font-medium text-foreground'
              >
                {runAs ? `key · ${runAs.key.name}` : `me · ${user?.email ?? 'signed in'}`}
                <ChevronsUpDown className='h-3 w-3 opacity-60' />
              </button>
            </PopoverTrigger>
            <PopoverContent align='start' className='w-[380px] p-0'>
              <Command>
                <CommandInput placeholder='Search API keys…' />
                <CommandList>
                  <CommandEmpty>No key matches.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem
                      value='__me__'
                      onSelect={() => {
                        void runAsKey(null)
                        setPickOpen(false)
                      }}
                    >
                      <Check className={`mr-2 h-3.5 w-3.5 ${runAs ? 'opacity-0' : ''}`} />
                      <span>Me — {user?.email}</span>
                    </CommandItem>
                    {keys.map((k) => (
                      <CommandItem
                        key={String(k.id)}
                        value={`${k.name} ${k.prefix}`}
                        data-gql-run-as-key={k.name}
                        onSelect={() => {
                          void runAsKey(k.id)
                          setPickOpen(false)
                        }}
                      >
                        <Check
                          className={`mr-2 h-3.5 w-3.5 ${
                            runAs && String(runAs.key.id) === String(k.id) ? '' : 'opacity-0'
                          }`}
                        />
                        <span className='flex-1'>
                          <span className='block'>{k.name}</span>
                          <span className='block text-[10.5px] text-muted-foreground'>
                            {k.prefix}… · {describeKey(k)}
                          </span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {runAs ? (
            <>
              <span data-gql-run-as-detail>
                {describeKey(runAs.key)} — scope, depth and sandbox refusals read exactly as that
                key's holder sees them. Nothing counts against the key.
              </span>
              <span className='ml-auto tabular-nums' data-gql-run-as-expires>
                {minutesLeft > 0
                  ? `${minutesLeft} min left`
                  : 'session lapsed — pick the key again'}
              </span>
              <button
                type='button'
                onClick={() => void runAsKey(null)}
                data-gql-run-as-stop
                className='inline-flex h-7 items-center gap-1 rounded-md border border-amber-400 bg-white px-2 font-medium dark:bg-transparent'
              >
                <X className='h-3 w-3' /> Back to me
              </button>
            </>
          ) : (
            <span>Pick a partner's key to see the API as that key does.</span>
          )}
        </div>
      )}
      <div className='min-h-0 flex-1 [&_.graphiql-container]:h-full [&_.graphiql-container]:rounded-none'>
        <GraphiQL
          fetcher={fetcher}
          plugins={[explorer]}
          defaultEditorToolsVisibility
          defaultQuery={`# Nivaro GraphQL API — authenticated as ${user?.email ?? 'you'}
#
# Example:
# { nivaro_collections { id collection display_name } }
`}
        >
          <GraphiQL.Toolbar>
            {({ prettify, copy, merge }) => (
              <>
                {prettify}
                {copy}
                {merge}
                <FixturesToolbar runAs={runAs} onRunAsKey={(id) => void runAsKey(id)} />
              </>
            )}
          </GraphiQL.Toolbar>
        </GraphiQL>
      </div>
    </div>
  )
}
