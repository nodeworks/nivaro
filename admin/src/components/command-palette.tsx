import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRight, CornerDownLeft, FileText, History, Plus, Search, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { showContrastAudit } from '@/lib/contrast-audit'
import { titleCase } from '@/lib/utils'

// ─── Static page registry (mirrors AppLayout nav structure) ──────────────────

const PAGES: { label: string; path: string; keywords?: string }[] = [
  { label: 'Overview', path: '/', keywords: 'home dashboard' },
  { label: 'Dashboards', path: '/dashboards', keywords: 'kpi widgets' },
  { label: 'Collections', path: '/collections', keywords: 'content data items' },
  { label: 'Data Model', path: '/data-model', keywords: 'schema fields tables' },
  { label: 'Files', path: '/files', keywords: 'uploads media' },
  { label: 'Hierarchies', path: '/hierarchies', keywords: 'tree levels' },
  { label: 'Record Templates', path: '/record-templates' },
  { label: 'Collection Presets', path: '/collection-presets' },
  { label: 'Users', path: '/users', keywords: 'people accounts' },
  { label: 'Roles', path: '/roles', keywords: 'permissions policies rbac' },
  { label: 'Workspaces', path: '/workspaces' },
  { label: 'Pipelines', path: '/pipelines', keywords: 'owner matrix' },
  { label: 'Flows', path: '/flows', keywords: 'automation inngest' },
  { label: 'Webhooks', path: '/webhooks' },
  { label: 'Rules', path: '/rules', keywords: 'automation conditions' },
  { label: 'Blackout Dates', path: '/blackout-dates' },
  { label: 'Scheduled Changes', path: '/scheduled-changes' },
  { label: 'Virtual Collections', path: '/virtual-collections' },
  { label: 'External APIs', path: '/external-apis', keywords: 'integrations' },
  { label: 'GraphQL Explorer', path: '/graphql', keywords: 'graphiql' },
  { label: 'Custom Queries', path: '/custom-queries', keywords: 'sql' },
  { label: 'Extensions', path: '/extensions', keywords: 'plugins' },
  { label: 'Analytics', path: '/analytics' },
  { label: 'Presence', path: '/presence' },
  { label: 'Docs', path: '/docs', keywords: 'documentation reference' },
  { label: 'API Docs', path: '/api-docs', keywords: 'rest reference' },
  { label: 'Settings', path: '/settings', keywords: 'configuration ai key' },
  { label: 'Activity', path: '/activity', keywords: 'audit log' },
  { label: 'Reports', path: '/reports', keywords: 'audit' },
  { label: 'Alerts', path: '/alerts', keywords: 'thresholds' },
  { label: 'SLA Rules', path: '/sla-rules' },
  { label: 'Field Watches', path: '/field-watches', keywords: 'changelog' },
  { label: 'Subscriptions', path: '/notification-subscriptions', keywords: 'notifications' },
  { label: 'Imports', path: '/imports', keywords: 'csv upload' },
  { label: 'Submission Forms', path: '/submission-forms', keywords: 'public forms' },
  { label: 'Schema Snapshot', path: '/schema-snapshot' },
  { label: 'Profile', path: '/profile', keywords: 'account token' }
]

interface SearchRecord {
  collection: string
  id: string | number
  label: string
  snippet: string
}

interface GlobalSearchResponse {
  records: SearchRecord[]
  semantic?: SearchRecord[]
  pages: { label: string; path: string }[]
  actions: { label: string; path: string }[]
}

function matchesQuery(p: { label: string; path: string; keywords?: string }, q: string) {
  const lower = q.toLowerCase()
  return (
    p.label.toLowerCase().includes(lower) ||
    (p.keywords ?? '').toLowerCase().includes(lower) ||
    p.path.toLowerCase().includes(lower)
  )
}

// ─── Palette v2 (#323): recents + fuzzy highlight + preview pane ─────────────

interface RecentEntry {
  label: string
  path: string
}

const RECENTS_KEY = 'nvr_palette_recents'

function readRecents(): RecentEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.slice(0, 8) : []
  } catch {
    return []
  }
}

function pushRecent(entry: RecentEntry) {
  try {
    const list = [entry, ...readRecents().filter((r) => r.path !== entry.path)].slice(0, 8)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}

/** Highlight the query match inside a label (case-insensitive, first hit). */
function Hi({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className='rounded-sm bg-[#00ceff]/25 px-0 text-inherit'>
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className='inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground'>
      {children}
    </kbd>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // ⌘K / Ctrl+K + custom focus-search event
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onFocusSearch = () => setOpen(true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('nivaro:focus-search', onFocusSearch)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('nivaro:focus-search', onFocusSearch)
    }
  }, [])

  // Debounce live record search (250ms)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // Reset query when closing
  useEffect(() => {
    if (!open) {
      setQuery('')
      setDebouncedQuery('')
    }
  }, [open])

  const { data: searchData, isFetching } = useQuery({
    queryKey: ['global-search', debouncedQuery],
    queryFn: () =>
      api
        .get<{ data: GlobalSearchResponse }>('/global-search', {
          params: { q: debouncedQuery }
        })
        .then((r) => r.data.data),
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 15_000
  })

  const { data: collections } = useQuery({
    queryKey: ['command-palette-collections'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name?: string | null }[] }>('/collections')
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 60_000
  })

  const q = query.trim()
  const pageMatches = q ? PAGES.filter((p) => matchesQuery(p, q)).slice(0, 8) : PAGES.slice(0, 8)
  const records = debouncedQuery.length >= 2 ? (searchData?.records ?? []) : []
  const serverActions = debouncedQuery.length >= 2 ? (searchData?.actions ?? []) : []
  const semantic = debouncedQuery.length >= 4 ? (searchData?.semantic ?? []) : []

  const newItemActions = q
    ? (collections ?? [])
        .filter(
          (c) =>
            !c.collection.toLowerCase().startsWith('nivaro_') &&
            (c.collection.toLowerCase().includes(q.toLowerCase()) ||
              (c.display_name ?? '').toLowerCase().includes(q.toLowerCase()))
        )
        .slice(0, 5)
    : []

  const [recents, setRecents] = useState<RecentEntry[]>([])
  // Preview pane (#323): cmdk exposes the highlighted item's value — map it
  // back to the entity so the right pane can describe it before Enter.
  const [selectedValue, setSelectedValue] = useState('')
  useEffect(() => {
    if (open) setRecents(readRecents())
  }, [open])

  function go(path: string, label?: string) {
    if (label) pushRecent({ label, path })
    setOpen(false)
    navigate(path)
  }

  // Natural-language mode: route prose to the right collection, then let the
  // browser's existing AI query translate it to filters (?ai= param).
  const aiNavigate = useMutation({
    mutationFn: (prompt: string) =>
      api
        .post<{ data: { collection: string | null } }>('/ai/navigate', { prompt })
        .then((r) => r.data.data),
    onSuccess: (res, prompt) => {
      if (!res.collection) {
        toast.message('Could not match that to a collection')
        return
      }
      go(`/collections/${res.collection}?ai=${encodeURIComponent(prompt)}`)
    },
    onError: () => toast.error('AI navigation failed')
  })
  const showAiRow = q.length >= 10 && q.split(/\s+/).length >= 3

  const hasResults =
    pageMatches.length > 0 ||
    records.length > 0 ||
    semantic.length > 0 ||
    newItemActions.length > 0 ||
    serverActions.length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className='overflow-hidden p-0 shadow-lg sm:max-w-[720px]'>
        <DialogTitle className='sr-only'>Command palette</DialogTitle>
        <Command
          shouldFilter={false}
          value={selectedValue}
          onValueChange={setSelectedValue}
          className='[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-11 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2'
        >
          <CommandInput
            placeholder='Search pages, records, actions…'
            value={query}
            onValueChange={setQuery}
          />
          <div className='flex'>
            <CommandList className='max-h-[380px] flex-1'>
              {!hasResults && (
                <CommandEmpty>{isFetching ? 'Searching…' : 'No results found.'}</CommandEmpty>
              )}

              {showAiRow && (
                <CommandGroup heading='Ask AI'>
                  <CommandItem
                    value={`ai-${q}`}
                    onSelect={() => aiNavigate.mutate(q)}
                    className='text-[13px]'
                  >
                    <Sparkles className='mr-2 h-4 w-4 text-nvr-cyan' />
                    {aiNavigate.isPending ? 'Thinking…' : <>Find records: “{q}”</>}
                  </CommandItem>
                </CommandGroup>
              )}

              {!q && recents.length > 0 && (
                <CommandGroup heading='Recent'>
                  {recents.map((r) => (
                    <CommandItem
                      key={`recent-${r.path}`}
                      value={`recent-${r.path}`}
                      onSelect={() => go(r.path, r.label)}
                    >
                      <History className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                      <span className='text-[13px]'>{r.label}</span>
                      <span className='ml-auto max-w-[220px] truncate font-mono text-[11px] text-muted-foreground'>
                        {r.path}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {pageMatches.length > 0 && (
                <CommandGroup heading='Pages'>
                  {pageMatches.map((p) => (
                    <CommandItem
                      key={`page-${p.path}`}
                      value={`page-${p.path}`}
                      onSelect={() => go(p.path, p.label)}
                    >
                      <FileText className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                      <span className='text-[13px]'>
                        <Hi text={p.label} q={q} />
                      </span>
                      <span className='ml-auto font-mono text-[11px] text-muted-foreground'>
                        {p.path}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {records.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading='Records'>
                    {records.map((r) => (
                      <CommandItem
                        key={`record-${r.collection}-${r.id}`}
                        value={`record-${r.collection}-${r.id}`}
                        onSelect={() =>
                          go(`/collections/${r.collection}/${r.id}`, r.label || String(r.id))
                        }
                      >
                        <Search className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                        <div className='min-w-0 flex-1'>
                          <div className='truncate text-[13px]'>
                            <Hi text={r.label || String(r.id)} q={q} />
                          </div>
                          {r.snippet && r.snippet !== r.label && (
                            <div className='truncate text-[11px] text-muted-foreground'>
                              {r.snippet}
                            </div>
                          )}
                        </div>
                        <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                          {titleCase(r.collection)}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              {semantic.length > 0 && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading='Similar meaning'>
                    {semantic.map((r) => (
                      <CommandItem
                        key={`sem-${r.collection}-${r.id}`}
                        value={`sem-${r.collection}-${r.id}`}
                        onSelect={() => go(`/collections/${r.collection}/${r.id}`)}
                      >
                        <Sparkles className='mr-2 h-3.5 w-3.5 text-purple-500' />
                        <div className='min-w-0 flex-1'>
                          <div className='truncate text-[13px]'>{r.label || String(r.id)}</div>
                        </div>
                        <span className='ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
                          {titleCase(r.collection)}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}

              {'audit contrast'.includes(q.toLowerCase()) && q.length >= 3 && (
                <CommandGroup heading='Tools'>
                  <CommandItem
                    value='tool-contrast-audit'
                    onSelect={() => {
                      setOpen(false)
                      setTimeout(() => showContrastAudit(), 250)
                    }}
                  >
                    <Sparkles className='mr-2 h-3.5 w-3.5 text-amber-500' />
                    <span className='text-[13px]'>Audit contrast on this page</span>
                  </CommandItem>
                </CommandGroup>
              )}

              {(newItemActions.length > 0 || serverActions.length > 0) && (
                <>
                  <CommandSeparator />
                  <CommandGroup heading='Actions'>
                    {newItemActions.map((c) => (
                      <CommandItem
                        key={`new-${c.collection}`}
                        value={`new-${c.collection}`}
                        onSelect={() => go(`/collections/${c.collection}/new`)}
                      >
                        <Plus className='mr-2 h-3.5 w-3.5 text-nvr-cyan' />
                        <span className='text-[13px]'>
                          New item in {c.display_name ?? titleCase(c.collection)}
                        </span>
                      </CommandItem>
                    ))}
                    {serverActions.map((a) => (
                      <CommandItem
                        key={`action-${a.path}-${a.label}`}
                        value={`action-${a.path}-${a.label}`}
                        onSelect={() => go(a.path)}
                      >
                        <ArrowRight className='mr-2 h-3.5 w-3.5 text-muted-foreground' />
                        <span className='text-[13px]'>{a.label}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
            <PreviewPane
              value={selectedValue}
              records={[...records, ...semantic]}
              pages={PAGES}
              recents={recents}
            />
          </div>

          {/* Footer hint row */}
          <div className='flex items-center gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground'>
            <span className='flex items-center gap-1'>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className='flex items-center gap-1'>
              <Kbd>
                <CornerDownLeft className='h-2.5 w-2.5' />
              </Kbd>{' '}
              open
            </span>
            <span className='flex items-center gap-1'>
              <Kbd>esc</Kbd> close
            </span>
            <span className='ml-auto flex items-center gap-1'>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function PreviewPane({
  value,
  records,
  pages,
  recents
}: {
  value: string
  records: SearchRecord[]
  pages: { label: string; path: string; keywords?: string }[]
  recents: RecentEntry[]
}) {
  let title = ''
  let sub = ''
  let path = ''
  let kind = ''
  if (value.startsWith('record-') || value.startsWith('sem-')) {
    const r = records.find((x) => value.endsWith(`${x.collection}-${x.id}`))
    if (r) {
      title = r.label || String(r.id)
      sub = r.snippet && r.snippet !== r.label ? r.snippet : ''
      path = `/collections/${r.collection}/${r.id}`
      kind = titleCase(r.collection)
    }
  } else if (value.startsWith('page-')) {
    const p = pages.find((x) => value === `page-${x.path}`)
    if (p) {
      title = p.label
      sub = p.keywords ?? ''
      path = p.path
      kind = 'Page'
    }
  } else if (value.startsWith('recent-')) {
    const r = recents.find((x) => value === `recent-${x.path}`)
    if (r) {
      title = r.label
      path = r.path
      kind = 'Recent'
    }
  } else if (value.startsWith('new-')) {
    title = 'Create a record'
    kind = 'Action'
    path = value.replace('new-', '/collections/') + '/new'
  }
  return (
    <div className='hidden w-[210px] shrink-0 flex-col gap-1.5 border-l border-border p-3 sm:flex'>
      {title ? (
        <>
          <span className='w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'>
            {kind}
          </span>
          <p className='break-words text-[13px] font-medium leading-snug'>{title}</p>
          {sub && (
            <p className='break-words text-[11.5px] leading-snug text-muted-foreground'>{sub}</p>
          )}
          {path && (
            <p className='mt-auto break-all font-mono text-[10.5px] text-muted-foreground'>
              {path}
            </p>
          )}
        </>
      ) : (
        <p className='m-auto text-center text-[11.5px] text-muted-foreground'>
          Arrow through results to preview
        </p>
      )}
    </div>
  )
}
